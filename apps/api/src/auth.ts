import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ERROR_POLICY,
  RouterError,
  RouterErrorCode,
  hashSecret,
  timingSafeEqual,
  type RouterApiKey,
} from '@router/shared';
import type { Repositories, RouterConfig } from '@router/config';

/**
 * Client authentication.
 *
 * Keys are matched by SHA-256 hash — the database never holds anything
 * usable. Two independent credentials exist and must not be confused:
 *
 *   sk-router-…   client key  → /v1/*        (this file)
 *   ADMIN_TOKEN   operator    → /api/admin/* (admin.ts)
 *
 * A leaked client key therefore cannot read provider secrets or change
 * routing.
 */

declare module 'fastify' {
  interface FastifyRequest {
    routerKey?: RouterApiKey;
    requestId: string;
  }
}

export interface AuthResult {
  ok: boolean;
  key: RouterApiKey | null;
  error?: RouterError;
}

export async function authenticateRequest(
  req: FastifyRequest,
  repos: Repositories,
  config: RouterConfig,
): Promise<AuthResult> {
  const presented = extractBearer(req);

  // Open mode never rejects — that is the whole point of it. It does still
  // resolve a presented key, so usage counting, per-key rate limiting and log
  // attribution keep working for clients that send one. A key that does not
  // resolve (or is revoked, disabled, exhausted) is treated as anonymous rather
  // than as an error: a client whose key went stale must not start failing in
  // the mode whose entire purpose is not requiring one.
  if (!config.requireApiKey) {
    if (!presented) return { ok: true, key: null };
    const key = repos.routerKeys.findByHash(await hashSecret(presented));
    const usable = key && key.revokedAt === null && key.enabled;
    return { ok: true, key: usable ? key : null };
  }

  if (!presented) {
    return {
      ok: false,
      key: null,
      error: new RouterError(
        'CLIENT_AUTH',
        'Missing API key. Send `Authorization: Bearer sk-router-…`.',
        { detail: RouterErrorCode.UNAUTHORIZED },
      ),
    };
  }

  const hash = await hashSecret(presented);
  const key = repos.routerKeys.findByHash(hash);

  if (!key) {
    // Burn a constant-time compare against a dummy so a miss and a hit cost
    // roughly the same.
    timingSafeEqual(hash, '0'.repeat(64));
    return {
      ok: false,
      key: null,
      error: new RouterError('CLIENT_AUTH', 'Invalid API key.', {
        detail: RouterErrorCode.UNAUTHORIZED,
      }),
    };
  }

  if (key.revokedAt !== null) {
    return {
      ok: false,
      key,
      error: new RouterError('CLIENT_AUTH', 'This API key has been revoked.', {
        detail: RouterErrorCode.UNAUTHORIZED,
      }),
    };
  }

  if (!key.enabled) {
    return {
      ok: false,
      key,
      error: new RouterError('CLIENT_AUTH', 'This API key is disabled.', {
        detail: RouterErrorCode.UNAUTHORIZED,
      }),
    };
  }

  if (key.usageLimit !== null && key.usageCount >= key.usageLimit) {
    return {
      ok: false,
      key,
      error: new RouterError(
        'RATE_LIMIT',
        `This API key has reached its usage limit of ${key.usageLimit} requests.`,
        { detail: RouterErrorCode.RATE_LIMITED },
      ),
    };
  }

  return { ok: true, key };
}

/**
 * Pull the presented credential out of the request.
 *
 * Three accepted shapes, in precedence order:
 *
 *   Authorization: Bearer sk-router-…   the documented form
 *   Authorization: sk-router-…          scheme omitted — accepted deliberately
 *   x-api-key: sk-router-…              what Anthropic-shaped clients send
 *
 * The bare form is a compatibility affordance, not an oversight: several clients
 * and proxies write the header raw, and there is no security cost to accepting
 * it, since the value still has to hash to a live key. Anything that is not a
 * valid key fails the lookup a moment later regardless of how it was framed.
 */
function extractBearer(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    if (m?.[1]) return m[1].trim();
    return auth.trim();
  }
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey) return xApiKey.trim();
  return null;
}

/**
 * Fixed-window rate limiter, per API key (or per IP when auth is off).
 *
 * In-process by design: this is a single-node gateway and SQLite already
 * makes that assumption. The interface is narrow enough that a Redis-backed
 * store drops in without touching callers.
 */
export interface RateLimitStore {
  hit(key: string, windowMs: number): { count: number; resetAt: number };
  reset(): void;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private now: () => number = () => Date.now()) {}

  hit(key: string, windowMs: number): { count: number; resetAt: number } {
    const t = this.now();
    const bucket = this.buckets.get(key);

    if (!bucket || t >= bucket.resetAt) {
      const fresh = { count: 1, resetAt: t + windowMs };
      this.buckets.set(key, fresh);
      // Opportunistic sweep — bounded work, no timer to leak.
      if (this.buckets.size > 4096) this.sweep(t);
      return fresh;
    }

    bucket.count++;
    return bucket;
  }

  private sweep(t: number): void {
    for (const [k, v] of this.buckets) {
      if (t >= v.resetAt) this.buckets.delete(k);
    }
  }

  reset(): void {
    this.buckets.clear();
  }
}

export function checkRateLimit(
  store: RateLimitStore,
  identity: string,
  config: RouterConfig,
): { allowed: boolean; remaining: number; resetAt: number; retryAfterSec: number } {
  const { count, resetAt } = store.hit(identity, config.rateLimitWindowMs);
  const allowed = count <= config.rateLimitMax;
  return {
    allowed,
    remaining: Math.max(0, config.rateLimitMax - count),
    resetAt,
    retryAfterSec: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
  };
}

/** Client identity for rate limiting — key id when authenticated, else IP. */
export function rateLimitIdentity(req: FastifyRequest): string {
  return req.routerKey?.id ?? `ip:${clientIp(req) ?? 'unknown'}`;
}

export function clientIp(req: FastifyRequest): string | null {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0]?.trim() ?? null;
  return req.ip ?? null;
}

const KNOWN_CODES = new Set<string>(Object.values(RouterErrorCode));

/**
 * Send a RouterError in the OpenAI error envelope clients expect.
 *
 * `extra` merges top-level keys into the body — used to attach `_router` debug
 * metadata to a failure without teaching every call site the status/code mapping.
 */
export function sendRouterError(
  reply: FastifyReply,
  err: RouterError,
  requestId?: string,
  extra?: Record<string, unknown>,
): FastifyReply {
  const policy = ERROR_POLICY[err.errorClass];
  if (err.retryAfterSec !== undefined) {
    reply.header('retry-after', String(err.retryAfterSec));
  }
  if (requestId) reply.header('x-request-id', requestId);
  // `detail` doubles as a stable router error code when it is one; otherwise
  // it is free-form upstream text and must not become the `code` field.
  const code = err.detail && KNOWN_CODES.has(err.detail) ? err.detail : undefined;
  return reply.code(policy.clientStatus).send({ ...err.toClientJSON(code), ...extra });
}
