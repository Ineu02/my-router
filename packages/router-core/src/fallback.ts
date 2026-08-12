import {
  ERROR_POLICY,
  RouterError,
  RouterErrorCode,
  type CredentialEntry,
  type ProviderAttempt,
  type RotationStrategy,
} from '@router/shared';
import type { Candidate } from './resolve.js';
import type { HealthTracker } from './health.js';
import { attemptStatusToken, classifyError } from './errors.js';
import { orderCredentials, RoundRobinCursor } from './rotation.js';

/**
 * The fallback ladder.
 *
 *   candidate 1 ──▶ credential A ──429──▶ credential B ──▶ ...
 *        │ exhausted
 *        ▼
 *   candidate 2 ──▶ ... ──▶ success
 *
 * Stops on: success · TERMINAL error class · attempt budget spent ·
 * global deadline exceeded.
 */

export interface FallbackConfig {
  maxAttempts: number;
  /** Wall-clock ceiling for the entire ladder, including retries. */
  globalDeadlineMs: number;
  /** Extra attempts on the SAME credential for NETWORK errors. */
  retryNetworkErrors: number;
  strategy: RotationStrategy;
}

export const DEFAULT_FALLBACK_CONFIG: FallbackConfig = {
  maxAttempts: 4,
  globalDeadlineMs: 120_000,
  retryNetworkErrors: 1,
  strategy: 'health-based',
};

export interface AttemptContext {
  candidate: Candidate;
  credential: CredentialEntry;
  attemptIndex: number;
  /** Remaining budget for this attempt, ms. */
  timeoutMs: number;
}

export interface ExecuteOptions<T> {
  candidates: Candidate[];
  config: FallbackConfig;
  health: HealthTracker;
  cursor?: RoundRobinCursor;
  /** Per-attempt timeout. */
  attemptTimeoutMs: number;
  now: () => number;
  /** The actual upstream call. Must reject with anything; we classify it. */
  execute: (ctx: AttemptContext) => Promise<T>;
  /** Notified on every attempt outcome — used for live dashboard events. */
  onAttempt?: (attempt: ProviderAttempt, ctx: AttemptContext) => void;
  /** Notified when moving from one candidate to the next. */
  onFallback?: (from: string, to: string, reason: string) => void;
  /** Called when a policy says a model should be taken out of rotation. */
  onDisableModel?: (modelId: string, reason: string) => void;
}

export interface ExecuteResult<T> {
  value: T;
  attempts: ProviderAttempt[];
  candidate: Candidate;
  credential: CredentialEntry;
  fallbackCount: number;
  totalLatencyMs: number;
}

export class AllProvidersFailedError extends RouterError {
  override readonly attempts: ProviderAttempt[];
  readonly soonestRetryAfterSec: number | undefined;

  constructor(attempts: ProviderAttempt[], last: RouterError | null, soonestRetryAfterSec?: number) {
    super(
      'PROVIDER_UNAVAILABLE',
      last
        ? `All providers unavailable. Last error: ${last.message}`
        : 'All providers unavailable',
      { detail: RouterErrorCode.ALL_PROVIDERS_UNAVAILABLE },
    );
    this.name = 'AllProvidersFailedError';
    this.attempts = attempts;
    this.soonestRetryAfterSec = soonestRetryAfterSec;
  }
}

export async function executeWithFallback<T>(opts: ExecuteOptions<T>): Promise<ExecuteResult<T>> {
  const { candidates, config, health, cursor, attemptTimeoutMs, now, execute } = opts;

  const attempts: ProviderAttempt[] = [];
  const startedAt = now();
  const deadline = startedAt + config.globalDeadlineMs;

  let attemptCount = 0;
  let lastError: RouterError | null = null;
  let fallbackCount = 0;
  let previousLabel: string | null = null;
  let soonestRetryAfter: number | undefined;

  for (const candidate of candidates) {
    if (attemptCount >= config.maxAttempts) break;
    if (now() >= deadline) break;

    const label = `${candidate.provider.id}/${candidate.model.model}`;

    const creds = orderCredentials(
      candidate.credentials,
      { strategy: config.strategy, health, now: now() },
      cursor,
    );

    for (const credential of creds) {
      if (attemptCount >= config.maxAttempts) break;

      const remaining = deadline - now();
      if (remaining <= 0) break;

      // Retry loop for NETWORK errors on this same credential.
      let sameCredentialTries = 0;
      const maxSameTries = 1 + Math.max(0, config.retryNetworkErrors);

      while (sameCredentialTries < maxSameTries) {
        if (attemptCount >= config.maxAttempts) break;

        // Count the fallback here, not when the candidate loop advances: a
        // candidate whose credentials are all cooling down is skipped without
        // ever being called, and reporting that as a fallback would inflate
        // `fallback_count` past the number of upstreams actually tried.
        if (previousLabel !== null && previousLabel !== label) {
          fallbackCount++;
          opts.onFallback?.(
            previousLabel,
            label,
            lastError ? attemptStatusToken(lastError) : 'unknown',
          );
        }
        previousLabel = label;

        sameCredentialTries++;
        attemptCount++;

        const attemptStart = now();
        const timeoutMs = Math.max(1, Math.min(attemptTimeoutMs, deadline - attemptStart));
        const ctx: AttemptContext = {
          candidate,
          credential,
          attemptIndex: attemptCount - 1,
          timeoutMs,
        };

        try {
          const value = await execute(ctx);
          const latency = now() - attemptStart;

          health.recordSuccess(credential.id, candidate.provider.id, latency, now());

          const ok: ProviderAttempt = {
            provider: candidate.provider.id,
            model: candidate.model.model,
            status: 'success',
            latency_ms: latency,
            credential_id: credential.id,
            credential_label: credential.label,
          };
          attempts.push(ok);
          opts.onAttempt?.(ok, ctx);

          return {
            value,
            attempts,
            candidate,
            credential,
            fallbackCount,
            totalLatencyMs: now() - startedAt,
          };
        } catch (rawErr) {
          const err = classifyError(rawErr, candidate.provider.id);
          const latency = now() - attemptStart;
          lastError = err;

          if (err.retryAfterSec !== undefined) {
            soonestRetryAfter =
              soonestRetryAfter === undefined
                ? err.retryAfterSec
                : Math.min(soonestRetryAfter, err.retryAfterSec);
          }

          const policy = ERROR_POLICY[err.errorClass];

          health.recordFailure(credential.id, candidate.provider.id, err.errorClass, now(), {
            retryAfterSec: err.retryAfterSec,
            latencyMs: latency,
          });

          const rec: ProviderAttempt = {
            provider: candidate.provider.id,
            model: candidate.model.model,
            status: attemptStatusToken(err),
            latency_ms: latency,
            error_class: err.errorClass,
            credential_id: credential.id,
            credential_label: credential.label,
          };
          attempts.push(rec);
          opts.onAttempt?.(rec, ctx);

          if (policy.disablesModel) {
            opts.onDisableModel?.(candidate.model.id, err.errorClass);
          }

          // The client's own payload is broken — trying another provider just
          // wastes latency and hides the real bug. The trail travels with the
          // error so a terminal failure is as diagnosable as an exhausted one.
          if (policy.action === 'TERMINAL') {
            err.attempts = attempts;
            throw err;
          }

          // Bad credentials never self-heal by retrying.
          if (policy.disablesCredential) break;

          if (policy.action === 'RETRY_SAME' && sameCredentialTries < maxSameTries) {
            continue; // one more go at this same credential
          }

          break; // next credential
        }
      }
    }
  }

  throw new AllProvidersFailedError(attempts, lastError, soonestRetryAfter);
}

/**
 * Run a promise under a timeout, converting the abort into a TIMEOUT
 * RouterError. The signal is handed to the caller so fetch can be cancelled
 * for real rather than left running in the background.
 */
export async function withTimeout<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort(externalSignal.reason);
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (controller.signal.aborted && !externalSignal?.aborted) {
      throw new RouterError('TIMEOUT', `Provider did not respond within ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
  }
}
