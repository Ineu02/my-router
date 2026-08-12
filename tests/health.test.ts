import { describe, it, expect, afterEach } from 'vitest';
import { HealthStatus, RotationStrategy } from '@router/shared';
import { harness, chat, trail, meta, type Harness } from './helpers/harness.js';

/**
 * Health degradation, cooldown, recovery and credential rotation — driven end
 * to end through real HTTP requests rather than by poking the tracker directly.
 *
 * The harness clock is frozen and advanced explicitly, so cooldown expiry is
 * asserted at exact boundaries and nothing here sleeps or flakes under load.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
});

/** The single credential of a single-provider harness. */
function soleCredential(hh: Harness, providerId: string) {
  return hh.server.repos.credentials.list().find((c) => c.providerId === providerId)!;
}

function status(hh: Harness, credId: string): HealthStatus | undefined {
  return hh.server.engine.health.get(credId)?.status;
}

describe('degradation', () => {
  it('keeps serving through a single failure rather than condemning a credential', async () => {
    // One blip is a wobble, not a verdict. Pulling a provider out of rotation on
    // the first hiccup would make a busy upstream look permanently sick.
    h = await harness({ providers: [{ id: 'solo', upstreamModel: 'mock-fast', priority: 100 }] });
    const cred = soleCredential(h, 'solo');

    h.failNext('500', 1);
    await chat(h);

    expect(status(h, cred.id)).toBe(HealthStatus.ONLINE);
    expect(h.server.engine.health.get(cred.id)!.consecutiveFailures).toBe(1);
    expect(h.server.engine.health.isAvailable(cred.id, h.now())).toBe(true);
  });

  it('degrades and cools down after the configured failure threshold', async () => {
    h = await harness({
      config: { healthFailureThreshold: 3, healthCooldownBaseMs: 5_000 },
      providers: [{ id: 'solo', upstreamModel: 'mock-fast', priority: 100 }],
    });
    const cred = soleCredential(h, 'solo');

    for (let i = 0; i < 3; i++) {
      h.failNext('500', 1);
      await chat(h);
    }

    const state = h.server.engine.health.get(cred.id)!;
    expect(state.status).toBe(HealthStatus.DEGRADED);
    expect(state.cooldownUntil).toBe(h.now() + 5_000);
    expect(h.server.engine.health.isAvailable(cred.id, h.now())).toBe(false);
  });

  it('ramps the cooldown exponentially and caps it', async () => {
    h = await harness({
      config: { healthFailureThreshold: 1, healthCooldownBaseMs: 1_000, healthMaxCooldownMs: 4_000 },
      providers: [{ id: 'solo', upstreamModel: 'mock-fast', priority: 100 }],
    });
    const cred = soleCredential(h, 'solo');
    const seen: number[] = [];

    for (let i = 0; i < 5; i++) {
      h.failNext('500', 1);
      await chat(h);
      const s = h.server.engine.health.get(cred.id)!;
      seen.push(s.cooldownUntil! - h.now());
      // Step past the cooldown so the next request is actually attempted.
      h.advance(seen[seen.length - 1] + 1);
    }

    // 1s, 2s, 4s, then pinned at the 4s ceiling — a provider that stays broken
    // must not be retried every second for ever, nor backed off into next week.
    expect(seen).toEqual([1_000, 2_000, 4_000, 4_000, 4_000]);
  });

  it('marks a persistently broken credential OFFLINE rather than merely degraded', async () => {
    h = await harness({
      config: { healthFailureThreshold: 1, healthCooldownBaseMs: 1_000 },
      providers: [{ id: 'solo', upstreamModel: 'mock-500', priority: 100 }],
    });
    const cred = soleCredential(h, 'solo');

    for (let i = 0; i < 5; i++) {
      await chat(h);
      h.advance(600_000);
    }

    expect(status(h, cred.id)).toBe(HealthStatus.OFFLINE);
  });

  it('does not degrade a credential for the client\'s own bad request', async () => {
    h = await harness({ providers: [{ id: 'solo', upstreamModel: 'mock-400', priority: 100 }] });
    const cred = soleCredential(h, 'solo');

    for (let i = 0; i < 5; i++) await chat(h);

    // The payload was wrong, not the account. Counting these would let one
    // broken client take a healthy provider out of rotation for everyone.
    expect(status(h, cred.id)).toBe(HealthStatus.ONLINE);
    expect(h.server.engine.health.get(cred.id)!.consecutiveFailures).toBe(0);
  });
});

describe('rate limiting', () => {
  it('honours Retry-After as the cooldown length', async () => {
    // The mock sends `retry-after: 2`. A provider telling us when to come back
    // is better information than our own backoff curve.
    h = await harness({ providers: [{ id: 'solo', upstreamModel: 'mock-429', priority: 100 }] });
    const cred = soleCredential(h, 'solo');

    await chat(h);

    const state = h.server.engine.health.get(cred.id)!;
    expect(state.status).toBe(HealthStatus.RATE_LIMITED);
    expect(state.cooldownUntil).toBe(h.now() + 2_000);
    expect(state.totalRateLimits).toBe(1);
  });

  it('rate-limits on the first 429 without waiting for a threshold', async () => {
    h = await harness({
      config: { healthFailureThreshold: 5 },
      providers: [{ id: 'solo', upstreamModel: 'mock-429', priority: 100 }],
    });
    const cred = soleCredential(h, 'solo');
    await chat(h);
    // A 429 is not ambiguous, so it does not need corroboration.
    expect(status(h, cred.id)).toBe(HealthStatus.RATE_LIMITED);
    expect(h.server.engine.health.isAvailable(cred.id, h.now())).toBe(false);
  });

  it('sets Retry-After on the 503 from the soonest cooldown', async () => {
    h = await harness({ providers: [{ id: 'solo', upstreamModel: 'mock-429', priority: 100 }] });
    await chat(h);

    // Second request: the only credential is cooling down, so the ladder is
    // empty before it starts and the client is told when to return.
    const { res, json } = await chat(h);
    expect(res.statusCode).toBe(503);
    expect((json as { error: { code: string } }).error.code).toBe('no_candidates_available');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(2);
    // The upstream was not called a second time — cooling down means cooling down.
    expect(h.upstream.state.byModel['mock-429']).toBe(1);
  });
});

describe('recovery', () => {
  it('returns to rotation when the cooldown expires', async () => {
    h = await harness({ providers: [{ id: 'solo', upstreamModel: 'mock-fast', priority: 100 }] });
    const cred = soleCredential(h, 'solo');

    h.failNext('429', 1);
    await chat(h);
    expect(h.server.engine.health.isAvailable(cred.id, h.now())).toBe(false);

    // One millisecond short of the deadline: still out.
    h.advance(1_999);
    expect(h.server.engine.health.isAvailable(cred.id, h.now())).toBe(false);

    h.advance(2);
    expect(h.server.engine.health.isAvailable(cred.id, h.now())).toBe(true);

    const { res, json } = await chat(h);
    expect(res.statusCode).toBe(200);
    expect(meta(json).selected_provider).toBe('solo');
  });

  it('clears DEGRADED back to ONLINE on a success', async () => {
    h = await harness({
      config: { healthFailureThreshold: 3, healthCooldownBaseMs: 1_000, healthSuccessReset: 1 },
      providers: [{ id: 'solo', upstreamModel: 'mock-fast', priority: 100 }],
    });
    const cred = soleCredential(h, 'solo');

    for (let i = 0; i < 3; i++) {
      h.failNext('500', 1);
      await chat(h);
    }
    expect(status(h, cred.id)).toBe(HealthStatus.DEGRADED);

    h.advance(1_001);
    await chat(h);

    const state = h.server.engine.health.get(cred.id)!;
    expect(state.status).toBe(HealthStatus.ONLINE);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.cooldownUntil).toBeNull();
  });

  it('brings an OFFLINE credential back through a successful probe', async () => {
    h = await harness({
      config: { healthFailureThreshold: 1, healthCooldownBaseMs: 1_000 },
      providers: [{ id: 'solo', upstreamModel: 'mock-fast', priority: 100 }],
    });
    const cred = soleCredential(h, 'solo');

    for (let i = 0; i < 5; i++) {
      h.failNext('500', 1);
      await chat(h);
      h.advance(600_000);
    }
    expect(status(h, cred.id)).toBe(HealthStatus.OFFLINE);

    // The probe is the only path back for a credential this far gone — request
    // traffic alone would never reach it again.
    await h.server.engine.runProbes();

    expect(status(h, cred.id)).toBe(HealthStatus.ONLINE);
    expect(h.server.engine.health.isAvailable(cred.id, h.now())).toBe(true);
  });

  it('leaves a still-broken credential offline after a failed probe', async () => {
    h = await harness({
      config: { healthFailureThreshold: 1, healthCooldownBaseMs: 1_000 },
      providers: [{ id: 'solo', upstreamModel: 'mock-500', priority: 100 }],
    });
    const cred = soleCredential(h, 'solo');

    for (let i = 0; i < 5; i++) {
      await chat(h);
      h.advance(600_000);
    }
    expect(status(h, cred.id)).toBe(HealthStatus.OFFLINE);

    await h.server.engine.runProbes();
    expect(status(h, cred.id)).not.toBe(HealthStatus.ONLINE);
  });

  it('brings an AUTH-disabled credential back once the key works again', async () => {
    // A 401 disables the credential, which by definition removes it from
    // rotation — so request traffic can never prove the key was fixed. Without
    // the probe reaching DISABLED rows, a rotated key stays dead until restart.
    h = await harness({ providers: [{ id: 'solo', upstreamModel: 'mock-fast', priority: 100 }] });
    const cred = soleCredential(h, 'solo');

    h.failNext('401', 1);
    await chat(h);
    expect(status(h, cred.id)).toBe(HealthStatus.DISABLED);
    expect(h.server.engine.health.isAvailable(cred.id, h.now())).toBe(false);

    h.advance(600_000);
    await h.server.engine.runProbes();

    expect(status(h, cred.id)).toBe(HealthStatus.ONLINE);
    const { res } = await chat(h);
    expect(res.statusCode).toBe(200);
  });

  it('leaves an operator-disabled credential alone when probing', async () => {
    // Same mechanism, opposite intent: a human turned this one off, and a
    // background probe must not quietly turn it back on.
    h = await harness({ providers: [{ id: 'solo', upstreamModel: 'mock-fast', priority: 100 }] });
    const cred = soleCredential(h, 'solo');

    h.server.repos.credentials.setEnabled(cred.id, false);
    h.server.engine.health.setEnabled(cred.id, 'solo', false, h.now());

    h.advance(600_000);
    await h.server.engine.runProbes();

    expect(status(h, cred.id)).toBe(HealthStatus.DISABLED);
  });

  it('recovers a whole provider mid-ladder — the classic outage-then-heal case', async () => {
    h = await harness({
      providers: [
        { id: 'primary', upstreamModel: 'mock-fast', priority: 100 },
        { id: 'backup', upstreamModel: 'mock-smart', priority: 90 },
      ],
    });
    const primaryCred = soleCredential(h, 'primary');

    // Primary 429s: traffic shifts to the backup…
    h.failNext('429', 1);
    const during = await chat(h);
    expect(meta(during.json).selected_provider).toBe('backup');
    expect(trail(during.json)[0]).toMatchObject({ provider: 'primary', error_class: 'RATE_LIMIT' });

    // …while it is cooling down, the backup keeps serving with no failover cost…
    const cooling = await chat(h);
    expect(meta(cooling.json).selected_provider).toBe('backup');
    expect(trail(cooling.json)).toHaveLength(1);

    // …and once the cooldown lapses, primary is preferred again automatically.
    h.advance(2_001);
    const after = await chat(h);
    expect(meta(after.json).selected_provider).toBe('primary');
    expect(status(h, primaryCred.id)).toBe(HealthStatus.ONLINE);
  });
});

describe('credential rotation', () => {
  const threeCreds = {
    providers: [{ id: 'multi', upstreamModel: 'mock-fast', priority: 100 }],
    extraCredentials: [
      { providerId: 'multi', label: 'second', priority: 50 },
      { providerId: 'multi', label: 'third', priority: 10 },
    ],
  };

  it('prefers the highest priority under the priority strategy', async () => {
    h = await harness({ ...threeCreds, config: { rotationStrategy: RotationStrategy.PRIORITY } });
    const top = h.server.repos.credentials
      .listByProvider('multi')
      .reduce((a, b) => (a.priority >= b.priority ? a : b));

    for (let i = 0; i < 4; i++) {
      const { json } = await chat(h);
      expect(trail(json)[0].credential_id).toBe(top.id);
    }
  });

  it('spreads load across every credential under round-robin', async () => {
    h = await harness({ ...threeCreds, config: { rotationStrategy: RotationStrategy.ROUND_ROBIN } });

    const used = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const { json } = await chat(h);
      used.add(trail(json)[0].credential_id!);
    }
    expect(used.size).toBe(3);
  });

  it('avoids the most-failed credential under least-failures', async () => {
    h = await harness({ ...threeCreds, config: { rotationStrategy: RotationStrategy.LEAST_FAILURES } });
    const creds = h.server.repos.credentials.listByProvider('multi');

    // Damage one credential without cooling it down: one failure is below the
    // threshold, so it stays available but should now be the last resort.
    const victim = creds[0];
    h.server.engine.health.recordFailure(victim.id, 'multi', 'PROVIDER_UNAVAILABLE', h.now());
    expect(h.server.engine.health.isAvailable(victim.id, h.now())).toBe(true);

    const { json } = await chat(h);
    expect(trail(json)[0].credential_id).not.toBe(victim.id);
  });

  it('prefers a healthy credential over a degraded one under health-based', async () => {
    h = await harness({ ...threeCreds, config: { rotationStrategy: RotationStrategy.HEALTH_BASED } });
    const creds = h.server.repos.credentials.listByProvider('multi');
    const top = creds.reduce((a, b) => (a.priority >= b.priority ? a : b));

    // The highest-priority credential is degraded but not cooling down. Health
    // outranks priority: that is the whole point of the default strategy.
    h.server.engine.health.updateConfig({ failureThreshold: 1, cooldownBaseMs: 0 });
    h.server.engine.health.recordFailure(top.id, 'multi', 'PROVIDER_UNAVAILABLE', h.now());
    h.advance(1);
    expect(status(h, top.id)).toBe(HealthStatus.DEGRADED);
    expect(h.server.engine.health.isAvailable(top.id, h.now())).toBe(true);

    const { json } = await chat(h);
    expect(trail(json)[0].credential_id).not.toBe(top.id);
  });

  it('skips cooling credentials and uses the ones still available', async () => {
    h = await harness(threeCreds);
    const creds = h.server.repos.credentials.listByProvider('multi');

    // Two of three are rate limited; the request must still succeed on the third.
    for (const c of creds.slice(0, 2)) {
      h.server.engine.health.recordFailure(c.id, 'multi', 'RATE_LIMIT', h.now(), { retryAfterSec: 60 });
    }

    const { res, json } = await chat(h);
    expect(res.statusCode).toBe(200);
    expect(trail(json)[0].credential_id).toBe(creds[2].id);
    expect(trail(json)).toHaveLength(1);
  });

  it('reports per-credential health without leaking key material', async () => {
    h = await harness(threeCreds);
    await chat(h);

    const snapshots = h.server.engine.health.snapshots();
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
    const serialised = JSON.stringify(snapshots);
    expect(serialised).not.toContain('mock-local-key');
    expect(serialised).not.toContain('MOCK_PROVIDER_API_KEY');
  });
});
