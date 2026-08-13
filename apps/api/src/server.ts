import Fastify, { LogController, type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import { createServer, type Server } from 'node:http';
import {
  RouterError,
  RouterErrorCode,
  generateRequestId,
  generateRouterKey,
  hashSecret,
  maskSecret,
} from '@router/shared';
import {
  createRepositories,
  loadConfig,
  openDatabase,
  seedDatabase,
  type ConfigWarning,
  type DB,
  type Repositories,
  type RouterConfig,
} from '@router/config';
import { RouterEngine } from './engine.js';
import { registerPublicRoutes } from './routes.js';
import { registerAdminRoutes } from './admin.js';
import { registerOAuthRoutes } from './oauth.js';
import {
  MemoryRateLimitStore,
  authenticateRequest,
  checkRateLimit,
  rateLimitIdentity,
  sendRouterError,
} from './auth.js';
import { startMockUpstream, type MockServerHandle } from './mock/server.js';

/**
 * Server assembly.
 *
 * Boot order matters: config → database → seed → engine → routes. The engine
 * hydrates health from disk before the first request can arrive, so a
 * credential that was cooling down at shutdown stays cooling down.
 */

export interface BuildOptions {
  config?: RouterConfig;
  /** Overrides the configured path — tests pass ':memory:'. */
  databasePath?: string;
  /** Skip binding the mock upstream (tests run their own). */
  skipMock?: boolean;
  now?: () => number;
  /** Bootstrap key to seed, when not coming from ROUTER_API_KEY. */
  bootstrapKey?: string;
  logger?: boolean;
}

export interface BuiltServer {
  app: FastifyInstance;
  engine: RouterEngine;
  repos: Repositories;
  config: RouterConfig;
  db: DB;
  warnings: ConfigWarning[];
  mock: MockServerHandle | null;
  /** Plaintext bootstrap key, returned exactly once, only when generated. */
  generatedKey: string | null;
  close(): Promise<void>;
}

/**
 * Routes whose per-request access log is suppressed: the LLM data path (logged
 * structurally in SQLite instead) and the two health endpoints (polled on a
 * timer by every orchestrator that has ever existed).
 */
const QUIET_LOG_PATHS = /^\/(?:v1\/|health$|api\/health$)/;

export async function buildServer(opts: BuildOptions = {}): Promise<BuiltServer> {
  const loaded = opts.config ? { config: opts.config, warnings: [] as ConfigWarning[] } : loadConfig();
  const config = loaded.config;
  const now = opts.now ?? (() => Date.now());
  const startedAt = now();

  /* ── storage ───────────────────────────────────────────────────────── */
  const db = openDatabase(opts.databasePath ?? config.databasePath);
  const repos = createRepositories(db);

  /* ── mock upstream ─────────────────────────────────────────────────── */
  // Booted before seeding so the seeded base URL points at a live port.
  let mock: MockServerHandle | null = null;
  if (config.enableMockProvider && !opts.skipMock) {
    mock = await startMockUpstream(config.mockProviderPort);
  }

  /* ── seed ──────────────────────────────────────────────────────────── */
  let generatedKey: string | null = null;
  let bootstrapKey = opts.bootstrapKey ?? config.bootstrapApiKey;

  // With auth on and no usable key configured, generate one and print it
  // once. Refusing to start would be worse; starting unauthenticated would
  // be much worse.
  if (config.requireApiKey && (!bootstrapKey || bootstrapKey.includes('CHANGE-ME'))) {
    if (repos.routerKeys.list().filter((k) => k.enabled && !k.revokedAt).length === 0) {
      bootstrapKey = generateRouterKey();
      generatedKey = bootstrapKey;
    } else {
      bootstrapKey = '';
    }
  }

  await seedDatabase(repos, config, { bootstrapKeyPlaintext: bootstrapKey });

  /* ── engine ────────────────────────────────────────────────────────── */
  const engine = new RouterEngine(repos, config, now);
  engine.start();

  /* ── app ───────────────────────────────────────────────────────────── */
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    bodyLimit: config.maxBodyBytes,
    // Fastify's access log is suppressed on the data path and on the health
    // probes: every routed request already gets a structured `request_logs`
    // row carrying the full attempt trail, which is the real audit record, and
    // health endpoints are polled hard enough by orchestrators to drown
    // everything else. Admin mutations and unknown routes keep their log.
    // (The top-level `disableRequestLogging` flag is deprecated in Fastify 5.)
    logController: new LogController({
      disableRequestLogging: (req) => QUIET_LOG_PATHS.test(req.url),
    }),
    trustProxy: true,
    // Fastify's default id is a counter; a random one is far easier to grep
    // for across the router's own logs and a client's.
    genReqId: () => generateRequestId('req'),
  });

  await app.register(cors, {
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-api-key',
      'anthropic-version',
      'x-router-admin-token',
      'x-stainless-os',
      'x-stainless-lang',
      'x-stainless-package-version',
      'x-stainless-runtime',
      'x-stainless-runtime-version',
      'x-stainless-arch',
      'x-stainless-retry-count',
      'openai-organization',
      'openai-beta',
    ],
    exposedHeaders: ['x-request-id', 'x-router-provider', 'x-router-model', 'x-router-fallbacks', 'retry-after'],
  });

  await app.register(cookie, { secret: config.sessionSecret || 'router-dev-secret' });

  const rateLimiter = new MemoryRateLimitStore(now);

  /* ── request id ────────────────────────────────────────────────────── */
  app.addHook('onRequest', async (req, reply) => {
    req.requestId = String(req.id);
    reply.header('x-request-id', req.requestId);
  });

  /* ── auth + rate limit (public API only) ───────────────────────────── */
  app.addHook('preHandler', async (req, reply) => {
    const url = req.url.split('?')[0] ?? '';

    // Health is unauthenticated (liveness probes shouldn't need a secret) and
    // /api/admin/* has its own token, checked in admin.ts.
    if (url === '/health' || url === '/api/health') return;
    if (url.startsWith('/api/admin')) return;
    if (!url.startsWith('/v1/')) return;

    const auth = await authenticateRequest(req, repos, config);
    if (!auth.ok && auth.error) {
      // Only the outcome is logged — never the presented key.
      req.log.warn({ requestId: req.requestId, url, reason: auth.error.errorClass }, 'auth rejected');
      return sendRouterError(reply, auth.error, req.requestId);
    }
    if (auth.key) req.routerKey = auth.key;

    const limit = checkRateLimit(rateLimiter, rateLimitIdentity(req), config);
    reply.header('x-ratelimit-limit', String(config.rateLimitMax));
    reply.header('x-ratelimit-remaining', String(limit.remaining));
    reply.header('x-ratelimit-reset', String(Math.floor(limit.resetAt / 1000)));

    if (!limit.allowed) {
      return sendRouterError(
        reply,
        new RouterError(
          'RATE_LIMIT',
          `Rate limit exceeded: ${config.rateLimitMax} requests per ${Math.round(config.rateLimitWindowMs / 1000)}s.`,
          { retryAfterSec: limit.retryAfterSec, detail: RouterErrorCode.RATE_LIMITED },
        ),
        req.requestId,
      );
    }
  });

  /* ── error handling ────────────────────────────────────────────────── */
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof RouterError) return sendRouterError(reply, err, req.requestId);

    const status = err.statusCode ?? 500;
    if (status === 413 || err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({
        error: {
          message: `Request body exceeds the ${config.maxBodyBytes} byte limit.`,
          type: 'invalid_request_error',
          code: RouterErrorCode.PAYLOAD_TOO_LARGE,
          param: null,
        },
      });
    }
    if (status >= 400 && status < 500) {
      return reply.code(status).send({
        error: { message: err.message, type: 'invalid_request_error', code: err.code ?? null, param: null },
      });
    }

    req.log.error({ err, requestId: req.requestId }, 'unhandled error');
    return reply.code(500).send({
      error: { message: 'Internal router error', type: 'api_error', code: 'internal_error', param: null },
    });
  });

  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: {
        message: `Unknown route ${req.method} ${req.url}`,
        type: 'invalid_request_error',
        code: 'not_found',
        param: null,
      },
    }),
  );

  /* ── routes ────────────────────────────────────────────────────────── */
  const deps = { engine, repos, config, startedAt };
  registerPublicRoutes(app, deps);
  registerAdminRoutes(app, deps);
  registerOAuthRoutes(app, deps);

  /* ── log retention ─────────────────────────────────────────────────── */
  const retention = setInterval(
    () => {
      try {
        repos.logs.pruneOlderThan(now() - config.logRetentionDays * 86_400_000);
      } catch {
        /* pruning is best-effort */
      }
    },
    6 * 60 * 60 * 1000,
  );
  retention.unref?.();

  return {
    app,
    engine,
    repos,
    config,
    db,
    warnings: loaded.warnings,
    mock,
    generatedKey,
    async close() {
      clearInterval(retention);
      engine.stop();
      await app.close();
      if (mock) await mock.close();
      db.close();
    },
  };
}

/** Register an additional router key at runtime (used by the CLI). */
export async function issueRouterKey(
  repos: Repositories,
  name: string,
  usageLimit: number | null = null,
): Promise<{ key: string; masked: string; id: string }> {
  const key = generateRouterKey();
  const record = repos.routerKeys.create({
    name,
    keyHash: await hashSecret(key),
    keyPrefix: key.slice(0, 12),
    maskedKey: maskSecret(key),
  });
  if (usageLimit !== null) {
    // create() takes the limit, but keep the call site explicit either way.
    repos.routerKeys.delete(record.id);
    const withLimit = repos.routerKeys.create({
      name,
      keyHash: await hashSecret(key),
      keyPrefix: key.slice(0, 12),
      maskedKey: maskSecret(key),
      usageLimit,
    });
    return { key, masked: withLimit.maskedKey, id: withLimit.id };
  }
  return { key, masked: record.maskedKey, id: record.id };
}

/* ── entrypoint ────────────────────────────────────────────────────────── */

export async function start(): Promise<BuiltServer> {
  const built = await buildServer();
  const { app, config, warnings, generatedKey } = built;

  for (const w of warnings) {
    if (w.level === 'error') app.log.error(`[config] ${w.message}`);
    else app.log.warn(`[config] ${w.message}`);
  }

  await app.listen({ port: config.port, host: config.host });

  const line = '─'.repeat(64);
  const out = [
    '',
    line,
    `  LLM Router  ·  http://${config.host}:${config.port}`,
    line,
    `  Endpoint      http://${config.host}:${config.port}/v1`,
    `  Health        http://${config.host}:${config.port}/api/health`,
    `  Auth          ${config.requireApiKey ? 'required (Bearer sk-router-…)' : 'DISABLED'}`,
    `  Providers     ${built.repos.providers.list().filter((p) => p.enabled).length} enabled`,
    `  Models        ${built.repos.models.listEnabled().length} enabled`,
    `  Profiles      ${built.repos.profiles.list().map((p) => p.id).join(', ')}`,
    built.mock ? `  Mock upstream ${built.mock.url}` : null,
    line,
  ].filter(Boolean);

  // eslint-disable-next-line no-console
  console.log(out.join('\n'));

  if (generatedKey) {
    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        '  No usable ROUTER_API_KEY was configured, so one was generated.',
        '  It is shown ONCE and stored only as a hash — copy it now:',
        '',
        `      ${generatedKey}`,
        '',
        '  Add it to .env as ROUTER_API_KEY to keep it across restarts.',
        line,
        '',
      ].join('\n'),
    );
  }

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, shutting down`);
    await built.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  return built;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  /server\.(ts|js)$/.test(process.argv[1].replace(/\\/g, '/'));

if (invokedDirectly) {
  start().catch((err: unknown) => {
     
    console.error('Failed to start router:', err);
    process.exit(1);
  });
}

export type { Server };
export { createServer };
