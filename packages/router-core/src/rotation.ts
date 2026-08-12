import {
  HEALTH_RANK,
  HealthStatus,
  RotationStrategy,
  type CredentialEntry,
  type HealthState,
} from '@router/shared';
import type { HealthTracker } from './health.js';

/**
 * Credential rotation. Given the credentials attached to a provider, decide
 * the order in which to try them.
 *
 * Default is health-based + priority: prefer credentials that are actually
 * working, break ties by operator priority, then by fewest recent failures.
 */

export interface RotationContext {
  strategy: RotationStrategy;
  health: HealthTracker;
  now: number;
}

/** Round-robin cursors, keyed by provider. Survives across requests. */
export class RoundRobinCursor {
  private cursors = new Map<string, number>();

  next(providerId: string, len: number): number {
    if (len <= 0) return 0;
    const cur = this.cursors.get(providerId) ?? 0;
    this.cursors.set(providerId, (cur + 1) % len);
    return cur % len;
  }

  reset(): void {
    this.cursors.clear();
  }
}

/**
 * Order credentials for an attempt. Only returns credentials that are
 * enabled AND currently serveable (not cooling down, not disabled).
 */
export function orderCredentials(
  credentials: CredentialEntry[],
  ctx: RotationContext,
  cursor?: RoundRobinCursor,
): CredentialEntry[] {
  const usable = credentials.filter(
    (c) => c.enabled && ctx.health.isAvailable(c.id, ctx.now),
  );
  if (usable.length <= 1) return usable;

  const stateOf = (c: CredentialEntry): HealthState | undefined => ctx.health.get(c.id);

  switch (ctx.strategy) {
    case RotationStrategy.PRIORITY:
      return [...usable].sort((a, b) => b.priority - a.priority);

    case RotationStrategy.ROUND_ROBIN: {
      const sorted = [...usable].sort((a, b) => a.id.localeCompare(b.id));
      const providerId = sorted[0]?.providerId ?? 'default';
      const start = cursor ? cursor.next(providerId, sorted.length) : 0;
      return [...sorted.slice(start), ...sorted.slice(0, start)];
    }

    case RotationStrategy.LEAST_FAILURES:
      return [...usable].sort((a, b) => {
        const fa = stateOf(a)?.totalFailures ?? 0;
        const fb = stateOf(b)?.totalFailures ?? 0;
        if (fa !== fb) return fa - fb;
        return b.priority - a.priority;
      });

    case RotationStrategy.WEIGHTED:
      return weightedShuffle(usable, ctx.now);

    case RotationStrategy.HEALTH_BASED:
    default:
      return [...usable].sort((a, b) => {
        const sa = stateOf(a);
        const sb = stateOf(b);
        const ra = HEALTH_RANK[sa?.status ?? HealthStatus.ONLINE];
        const rb = HEALTH_RANK[sb?.status ?? HealthStatus.ONLINE];
        if (ra !== rb) return ra - rb;
        if (a.priority !== b.priority) return b.priority - a.priority;
        const ca = sa?.consecutiveFailures ?? 0;
        const cb = sb?.consecutiveFailures ?? 0;
        if (ca !== cb) return ca - cb;
        // Final tiebreak: prefer the faster credential.
        const la = avg(sa?.latencySamples ?? []);
        const lb = avg(sb?.latencySamples ?? []);
        return la - lb;
      });
  }
}

/**
 * Weighted selection without a random clock read — uses `now` as the entropy
 * source so behaviour stays reproducible in tests.
 */
function weightedShuffle(list: CredentialEntry[], now: number): CredentialEntry[] {
  const total = list.reduce((sum, c) => sum + Math.max(1, c.weight), 0);
  const out: CredentialEntry[] = [];
  const pool = [...list];
  let seed = now;

  while (pool.length > 0) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    let target = (seed / 0x7fffffff) * pool.reduce((s, c) => s + Math.max(1, c.weight), 0);
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      target -= Math.max(1, pool[i]!.weight);
      if (target <= 0) {
        idx = i;
        break;
      }
    }
    out.push(pool.splice(idx, 1)[0]!);
  }
  void total;
  return out;
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
