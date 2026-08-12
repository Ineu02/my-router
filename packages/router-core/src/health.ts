import {
  HealthStatus,
  type HealthState,
  type HealthSnapshot,
  ErrorClass,
  ERROR_POLICY,
} from '@router/shared';

/**
 * Per-credential health state machine.
 *
 * Pure: `now` is always injected, never read from the clock. That makes
 * cooldown ramps and recovery deterministically testable without fake timers.
 *
 *   ONLINE ──3 consecutive failures──▶ DEGRADED ──more failure──▶ cooldown
 *                                                                    │
 *   RATE_LIMITED ◀── 429 (cooldown = Retry-After) ───┐    cooldown expires
 *                                                    │               ▼
 *   OFFLINE ◀── failure across repeated cooldowns ───┤          health probe
 *                                                    │               │
 *   DISABLED ◀── AUTH error / manual toggle          └── healthy ──▶ rotation
 */

export interface HealthConfig {
  /** Consecutive failures before ONLINE → DEGRADED. */
  failureThreshold: number;
  /** First cooldown length; doubles each level. */
  cooldownBaseMs: number;
  /** Ceiling for the exponential ramp. */
  maxCooldownMs: number;
  /** Cooldown level at which a credential is considered OFFLINE. */
  offlineAfterCooldownLevel: number;
  /** Successes required to clear DEGRADED back to ONLINE. */
  successReset: number;
  /** Rolling latency window size. */
  latencyWindow: number;
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  failureThreshold: 3,
  cooldownBaseMs: 5_000,
  maxCooldownMs: 300_000,
  offlineAfterCooldownLevel: 3,
  successReset: 1,
  latencyWindow: 50,
};

export function createHealthState(credentialId: string, providerId: string): HealthState {
  return {
    credentialId,
    providerId,
    status: HealthStatus.ONLINE,
    consecutiveFailures: 0,
    totalRequests: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    totalTimeouts: 0,
    totalRateLimits: 0,
    cooldownUntil: null,
    cooldownLevel: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastErrorClass: null,
    latencySamples: [],
  };
}

/**
 * Health tracker. Holds a map of credentialId → HealthState and applies
 * transitions. The only mutable state in router-core, and it is explicit.
 */
export class HealthTracker {
  private states = new Map<string, HealthState>();
  private listeners = new Set<(s: HealthState, prev: HealthStatus) => void>();

  constructor(private config: HealthConfig = DEFAULT_HEALTH_CONFIG) {}

  updateConfig(patch: Partial<HealthConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  getConfig(): HealthConfig {
    return { ...this.config };
  }

  onChange(fn: (s: HealthState, prev: HealthStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(state: HealthState, prev: HealthStatus): void {
    if (prev === state.status) return;
    for (const l of this.listeners) {
      try {
        l(state, prev);
      } catch {
        /* a broken listener must never break routing */
      }
    }
  }

  ensure(credentialId: string, providerId: string): HealthState {
    let s = this.states.get(credentialId);
    if (!s) {
      s = createHealthState(credentialId, providerId);
      this.states.set(credentialId, s);
    }
    return s;
  }

  get(credentialId: string): HealthState | undefined {
    return this.states.get(credentialId);
  }

  all(): HealthState[] {
    return [...this.states.values()];
  }

  /** Load persisted state at boot so restarts don't forget a bad credential. */
  hydrate(states: HealthState[]): void {
    for (const s of states) this.states.set(s.credentialId, { ...s });
  }

  /**
   * Is this credential allowed to serve a request right now?
   * Cooldown expiry is evaluated lazily here rather than on a timer.
   */
  isAvailable(credentialId: string, now: number): boolean {
    const s = this.states.get(credentialId);
    if (!s) return true; // unknown credential = fresh, assume good
    if (s.status === HealthStatus.DISABLED) return false;

    if (s.cooldownUntil !== null) {
      if (now < s.cooldownUntil) return false;
      // Cooldown elapsed — let it back in on probation.
      this.clearCooldown(s);
    }
    return s.status !== HealthStatus.OFFLINE || s.cooldownUntil === null;
  }

  private clearCooldown(s: HealthState): void {
    const prev = s.status;
    s.cooldownUntil = null;
    if (s.status === HealthStatus.RATE_LIMITED || s.status === HealthStatus.OFFLINE) {
      // Return on probation, not straight to full health.
      s.status = HealthStatus.DEGRADED;
    }
    this.emit(s, prev);
  }

  /**
   * Record a successful call. One success is enough to clear DEGRADED.
   *
   * `clearDisabled` lifts a DISABLED status too. Only the probe path passes it —
   * see `recordProbe` for why that is safe.
   */
  recordSuccess(
    credentialId: string,
    providerId: string,
    latencyMs: number,
    now: number,
    opts: { clearDisabled?: boolean } = {},
  ): HealthState {
    const s = this.ensure(credentialId, providerId);
    const prev = s.status;

    s.totalRequests++;
    s.totalSuccesses++;
    s.consecutiveFailures = 0;
    s.lastSuccessAt = now;
    s.cooldownUntil = null;
    s.cooldownLevel = 0;

    s.latencySamples.push(latencyMs);
    if (s.latencySamples.length > this.config.latencyWindow) s.latencySamples.shift();

    // A manually DISABLED credential stays disabled — success on the request
    // path doesn't override an operator decision.
    if (s.status !== HealthStatus.DISABLED || opts.clearDisabled) s.status = HealthStatus.ONLINE;

    this.emit(s, prev);
    return s;
  }

  /**
   * Record a failure and apply the transition dictated by the error class.
   * `retryAfterSec` (from a 429) overrides the computed backoff.
   */
  recordFailure(
    credentialId: string,
    providerId: string,
    errorClass: ErrorClass,
    now: number,
    opts: { retryAfterSec?: number; latencyMs?: number } = {},
  ): HealthState {
    const s = this.ensure(credentialId, providerId);
    const prev = s.status;
    const policy = ERROR_POLICY[errorClass];

    s.totalRequests++;
    s.lastFailureAt = now;
    s.lastErrorClass = errorClass;

    if (errorClass === ErrorClass.TIMEOUT) s.totalTimeouts++;
    if (errorClass === ErrorClass.RATE_LIMIT) s.totalRateLimits++;

    // BAD_REQUEST / CONTENT_FILTER are the client's problem, not the
    // credential's — they must not degrade a healthy account.
    if (!policy.countsAsFailure) {
      this.emit(s, prev);
      return s;
    }

    s.totalFailures++;
    s.consecutiveFailures++;

    // A bad key can't fix itself by being retried, so it leaves rotation at
    // once. It still gets a cooldown — not to gate rotation (DISABLED is
    // excluded regardless of the clock) but to pace the background probe that is
    // its only way back, so a permanently dead key is not re-checked on every
    // cycle for ever.
    if (policy.disablesCredential) {
      s.status = HealthStatus.DISABLED;
      s.cooldownUntil = now + this.backoffMs(s.cooldownLevel);
      s.cooldownLevel = Math.min(s.cooldownLevel + 1, 10);
      this.emit(s, prev);
      return s;
    }

    if (errorClass === ErrorClass.RATE_LIMIT) {
      s.status = HealthStatus.RATE_LIMITED;
      const explicit = opts.retryAfterSec !== undefined ? opts.retryAfterSec * 1000 : undefined;
      s.cooldownUntil = now + (explicit ?? this.backoffMs(s.cooldownLevel));
      s.cooldownLevel = Math.min(s.cooldownLevel + 1, 10);
      this.emit(s, prev);
      return s;
    }

    if (s.consecutiveFailures >= this.config.failureThreshold) {
      s.cooldownUntil = now + this.backoffMs(s.cooldownLevel);
      s.cooldownLevel = Math.min(s.cooldownLevel + 1, 10);
      s.status =
        s.cooldownLevel > this.config.offlineAfterCooldownLevel
          ? HealthStatus.OFFLINE
          : HealthStatus.DEGRADED;
    }
    // Below the threshold the status is deliberately left alone: an isolated
    // failure is a wobble, not a verdict, and pulling a credential out of
    // rotation for one blip would make a busy provider look unhealthy.

    this.emit(s, prev);
    return s;
  }

  /** Exponential backoff, capped. */
  private backoffMs(level: number): number {
    return Math.min(this.config.cooldownBaseMs * 2 ** level, this.config.maxCooldownMs);
  }

  /** Operator toggle. Disabling is sticky; enabling resets the counters. */
  setEnabled(credentialId: string, providerId: string, enabled: boolean, now: number): HealthState {
    const s = this.ensure(credentialId, providerId);
    const prev = s.status;
    if (enabled) {
      s.status = HealthStatus.ONLINE;
      s.consecutiveFailures = 0;
      s.cooldownUntil = null;
      s.cooldownLevel = 0;
    } else {
      s.status = HealthStatus.DISABLED;
      s.cooldownUntil = null;
    }
    void now;
    this.emit(s, prev);
    return s;
  }

  /**
   * Result of a background probe.
   *
   * Unlike the request path, a passing probe *does* clear DISABLED — that is the
   * entire point of it. A credential auto-disabled by a 401 is excluded from
   * rotation by definition, so traffic can never demonstrate that it works
   * again; the probe is its only way back. Operator intent is not at risk:
   * `runProbes` only ever probes credentials whose stored `enabled` flag is
   * true, so a manually disabled credential never reaches this method.
   */
  recordProbe(credentialId: string, providerId: string, ok: boolean, latencyMs: number, now: number): HealthState {
    if (ok) return this.recordSuccess(credentialId, providerId, latencyMs, now, { clearDisabled: true });
    return this.recordFailure(credentialId, providerId, ErrorClass.PROVIDER_UNAVAILABLE, now);
  }

  /**
   * Credentials due for a background probe.
   *
   * DISABLED is included deliberately. Everything here is out of rotation, and
   * the probe is the only route back for a credential a 401 or a 404 took down.
   * Excluding it would strand auto-disabled keys until a restart — the caller
   * enforces operator intent separately, via the stored `enabled` flag.
   */
  dueForProbe(now: number): HealthState[] {
    return this.all().filter(
      (s) => s.status !== HealthStatus.ONLINE && (s.cooldownUntil === null || now >= s.cooldownUntil),
    );
  }

  snapshot(credentialId: string): HealthSnapshot | null {
    const s = this.states.get(credentialId);
    if (!s) return null;
    return toSnapshot(s);
  }

  snapshots(): HealthSnapshot[] {
    return this.all().map(toSnapshot);
  }

  reset(): void {
    this.states.clear();
  }
}

export function toSnapshot(s: HealthState): HealthSnapshot {
  return {
    credentialId: s.credentialId,
    providerId: s.providerId,
    status: s.status,
    successRate: s.totalRequests === 0 ? 1 : s.totalSuccesses / s.totalRequests,
    avgLatencyMs: average(s.latencySamples),
    p95LatencyMs: percentile(s.latencySamples, 0.95),
    totalRequests: s.totalRequests,
    totalFailures: s.totalFailures,
    totalTimeouts: s.totalTimeouts,
    consecutiveFailures: s.consecutiveFailures,
    cooldownUntil: s.cooldownUntil,
    lastSuccessAt: s.lastSuccessAt,
    lastFailureAt: s.lastFailureAt,
    lastErrorClass: s.lastErrorClass,
  };
}

function average(xs: number[]): number {
  if (xs.length === 0) return 0;
  return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] ?? 0;
}
