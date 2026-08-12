import { describe, it, expect, afterEach } from 'vitest';
import { harness, chat, trail, meta, authHeaders, type Harness } from './helpers/harness.js';

/**
 * Model resolution and the fallback ladder.
 *
 * This is the file that matters most. The gateway's entire value proposition is
 * that a client asking for `auto` gets an answer even when the first provider
 * it tried is rate limited, hung, or misconfigured — and that it does *not*
 * hammer a provider whose failure is permanent. Both halves are asserted here.
 *
 * Failure modes come from the upstream model name the mock is asked for
 * (`mock-429`, `mock-timeout`, …), so a ladder is declared by naming which
 * upstream each rung talks to.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('model resolution', () => {
  it('resolves a profile name to its ordered ladder', async () => {
    h = await harness();
    const { res, json } = await chat(h, { model: 'auto' });
    expect(res.statusCode).toBe(200);
    // `auto` is a profile row like any other, not a special case in code — so
    // it reports itself, and an operator can re-point it without a deploy.
    expect(meta(json).resolved_profile).toBe('auto');
    expect(meta(json).selected_provider).toBe('primary');
  });

  it('resolves a named profile', async () => {
    h = await harness({ profiles: { coding: ['secondary-model'] } });
    const { res, json } = await chat(h, { model: 'coding' });
    expect(res.statusCode).toBe(200);
    expect(meta(json).resolved_profile).toBe('coding');
    expect(meta(json).selected_provider).toBe('secondary');
  });

  it('honours the profile ladder order over model priority', async () => {
    // `third` has the lowest priority but is listed first, and an explicit
    // profile order is the operator's intent — priority only breaks ties in
    // non-profile resolution.
    h = await harness({ profiles: { auto: ['third-model', 'primary-model'] } });
    const { json } = await chat(h, { model: 'auto' });
    expect(meta(json).selected_provider).toBe('third');
  });

  it('resolves provider/model to that exact pair', async () => {
    h = await harness();
    const { res, json } = await chat(h, { model: 'secondary/mock-smart' });
    expect(res.statusCode).toBe(200);
    expect(meta(json).selected_provider).toBe('secondary');
    expect(meta(json).selected_model).toBe('mock-smart');
    // Pinning bypasses profiles entirely.
    expect(meta(json).resolved_profile).toBeUndefined();
  });

  it('accepts the registry id on the right-hand side of the slash too', async () => {
    h = await harness();
    const { json } = await chat(h, { model: 'secondary/secondary-model' });
    expect(meta(json).selected_provider).toBe('secondary');
  });

  it('passes an unregistered model through to a known provider', async () => {
    // The upstream is the authority on which model names it accepts; pinning
    // must not require pre-registering every one of them.
    h = await harness();
    const { res, json } = await chat(h, { model: 'primary/some-unlisted-model' });
    expect(res.statusCode).toBe(200);
    expect(meta(json).selected_model).toBe('some-unlisted-model');
    expect(h.upstream.state.byModel['some-unlisted-model']).toBe(1);
  });

  it('resolves a bare provider name to that provider', async () => {
    h = await harness();
    const { res, json } = await chat(h, { model: 'third' });
    expect(res.statusCode).toBe(200);
    expect(meta(json).selected_provider).toBe('third');
  });

  it('resolves a bare registry id', async () => {
    h = await harness();
    const { json } = await chat(h, { model: 'secondary-model' });
    expect(meta(json).selected_provider).toBe('secondary');
  });

  it('rejects an unresolvable model with 400 and no upstream call', async () => {
    h = await harness();
    const { res, json } = await chat(h, { model: 'gpt-9-ultra' });
    expect(res.statusCode).toBe(400);
    expect((json as { error: { code: string } }).error.code).toBe('invalid_model_format');
    expect(h.upstream.state.requestCount).toBe(0);
  });

  it('restricts the ladder when router_providers is given', async () => {
    h = await harness();
    const { json } = await chat(h, { model: 'auto', router_providers: ['third'] });
    expect(meta(json).selected_provider).toBe('third');
  });

  it('routes by capability when the request needs one', async () => {
    // Only `secondary` claims vision, so a vision request must land there even
    // though `primary` outranks it.
    h = await harness({
      providers: [
        { id: 'primary', upstreamModel: 'mock-fast', priority: 100, capabilities: ['chat'] },
        { id: 'secondary', upstreamModel: 'mock-smart', priority: 90, capabilities: ['chat', 'vision'] },
      ],
    });
    const { res, json } = await chat(h, {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
          ],
        },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(meta(json).selected_provider).toBe('secondary');
  });
});

describe('fallback ladder', () => {
  it('falls over a 429 to the next provider', async () => {
    h = await harness({
      providers: [
        { id: 'limited', upstreamModel: 'mock-429', priority: 100 },
        { id: 'healthy', upstreamModel: 'mock-fast', priority: 90 },
      ],
    });
    const { res, json } = await chat(h);

    expect(res.statusCode).toBe(200);
    const t = trail(json);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ provider: 'limited', error_class: 'RATE_LIMIT' });
    expect(t[1]).toMatchObject({ provider: 'healthy', status: 'success' });
    // The client sees a clean 200 — the 429 never leaks out.
    expect(res.headers['x-router-provider']).toBe('healthy');
  });

  it('walks the whole ladder when each rung fails differently', async () => {
    h = await harness({
      providers: [
        { id: 'a', upstreamModel: 'mock-429', priority: 100 },
        { id: 'b', upstreamModel: 'mock-500', priority: 90 },
        { id: 'c', upstreamModel: 'mock-malformed', priority: 80 },
        { id: 'd', upstreamModel: 'mock-fast', priority: 70 },
      ],
    });
    const { res, json } = await chat(h);

    expect(res.statusCode).toBe(200);
    const t = trail(json);
    expect(t.map((a) => a.provider)).toEqual(['a', 'b', 'c', 'd']);
    expect(t.map((a) => a.error_class)).toEqual([
      'RATE_LIMIT',
      'PROVIDER_UNAVAILABLE',
      'MALFORMED_RESPONSE',
      undefined,
    ]);
    expect(meta(json).fallback_count).toBe(3);
    expect(trail(json)).toHaveLength(4);
  });

  it('falls over a timeout without waiting on the dead socket twice', async () => {
    h = await harness({
      config: { requestTimeoutMs: 700 },
      providers: [
        { id: 'hung', upstreamModel: 'mock-timeout', priority: 100 },
        { id: 'healthy', upstreamModel: 'mock-fast', priority: 90 },
      ],
    });
    const started = Date.now();
    const { res, json } = await chat(h);
    const elapsed = Date.now() - started;

    expect(res.statusCode).toBe(200);
    expect(trail(json)[0]).toMatchObject({ provider: 'hung', error_class: 'TIMEOUT' });
    // One budget, not two: the successful retry must not be charged a timeout.
    expect(elapsed).toBeLessThan(2_500);
  });

  it('stops at max_fallback_attempts instead of walking for ever', async () => {
    h = await harness({
      config: { maxFallbackAttempts: 2 },
      providers: [
        { id: 'a', upstreamModel: 'mock-500', priority: 100 },
        { id: 'b', upstreamModel: 'mock-500', priority: 90 },
        { id: 'c', upstreamModel: 'mock-fast', priority: 80 },
      ],
    });
    const { res, json } = await chat(h);

    // `c` would have worked, but the operator capped the ladder at 2 — the cap
    // is a real budget, not a suggestion.
    expect(res.statusCode).toBe(503);
    expect(trail(json)).toHaveLength(2);
    expect(h.upstream.state.byModel['mock-fast']).toBeUndefined();
  });

  it('returns 503 with Retry-After when the whole ladder is exhausted', async () => {
    h = await harness({
      providers: [
        { id: 'a', upstreamModel: 'mock-429', priority: 100 },
        { id: 'b', upstreamModel: 'mock-429', priority: 90 },
      ],
    });
    const { res, json } = await chat(h);

    expect(res.statusCode).toBe(503);
    expect((json as { error: { code: string } }).error.code).toBe('all_providers_unavailable');
    // Honouring the upstream's own Retry-After is the difference between a
    // client that backs off correctly and one that makes things worse.
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('errors that must not be retried', () => {
  it('does not retry a client BAD_REQUEST against another provider', async () => {
    // Retrying a payload the upstream rejected as malformed just multiplies
    // latency and hides the client's own bug, so this is the one failure class
    // that aborts the ladder immediately.
    h = await harness({
      providers: [
        { id: 'strict', upstreamModel: 'mock-400', priority: 100 },
        { id: 'healthy', upstreamModel: 'mock-fast', priority: 90 },
      ],
    });
    const { res, json } = await chat(h);

    expect(res.statusCode).toBe(400);
    expect(trail(json)).toHaveLength(1);
    // `healthy` was never asked — the ladder stopped rather than laundering a
    // bad request through a second provider.
    expect(h.upstream.state.byModel['mock-fast']).toBeUndefined();
  });

  it('treats an upstream 401 as terminal for that credential', async () => {
    h = await harness({
      providers: [
        { id: 'badkey', upstreamModel: 'mock-401', priority: 100 },
        { id: 'healthy', upstreamModel: 'mock-fast', priority: 90 },
      ],
    });
    const { res, json } = await chat(h);

    expect(res.statusCode).toBe(200);
    const t = trail(json);
    expect(t[0]).toMatchObject({ provider: 'badkey', error_class: 'AUTH' });
    // Exactly one attempt against the bad credential — no same-credential retry.
    expect(t.filter((a) => a.provider === 'badkey')).toHaveLength(1);

    // And it is out of rotation, so the next request skips it entirely.
    const cred = h.server.repos.credentials.list().find((c) => c.providerId === 'badkey')!;
    expect(h.server.engine.health.isAvailable(cred.id, h.now())).toBe(false);

    h.upstream.reset();
    const second = await chat(h);
    expect(second.res.statusCode).toBe(200);
    expect(trail(second.json)).toHaveLength(1);
    expect(h.upstream.state.byModel['mock-401']).toBeUndefined();
  });

  it('treats an upstream 404 as terminal for that model', async () => {
    h = await harness({
      providers: [
        { id: 'gone', upstreamModel: 'mock-404', priority: 100 },
        { id: 'healthy', upstreamModel: 'mock-fast', priority: 90 },
      ],
    });
    const { res, json } = await chat(h);

    expect(res.statusCode).toBe(200);
    expect(trail(json)[0]).toMatchObject({ provider: 'gone', error_class: 'MODEL_UNAVAILABLE' });
    expect(trail(json).filter((a) => a.provider === 'gone')).toHaveLength(1);

    // The model is disabled rather than the credential: the key is fine, the
    // model name is not.
    expect(h.server.repos.models.get('gone-model')!.enabled).toBe(false);
  });

  it('keeps a sibling credential alive when only one of them is unauthorised', async () => {
    // The health state machine is per credential precisely so one exhausted or
    // revoked account cannot condemn the others on the same provider.
    h = await harness({
      providers: [{ id: 'solo', upstreamModel: 'mock-fast', priority: 100 }],
      extraCredentials: [{ providerId: 'solo', label: 'second key', priority: 90 }],
    });
    h.failNext('401', 1);

    const { res, json } = await chat(h);
    expect(res.statusCode).toBe(200);

    const t = trail(json);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ provider: 'solo', error_class: 'AUTH' });
    expect(t[1]).toMatchObject({ provider: 'solo', status: 'success' });
    // Same provider, different credentials — that is the whole point.
    expect(t[0].credential_id).not.toBe(t[1].credential_id);

    const creds = h.server.repos.credentials.list().filter((c) => c.providerId === 'solo');
    expect(creds).toHaveLength(2);
    const available = creds.filter((c) => h.server.engine.health.isAvailable(c.id, h.now()));
    expect(available.map((c) => c.id)).toEqual([t[1].credential_id]);
  });

  it('gives up on a provider once every credential is unauthorised', async () => {
    h = await harness({
      providers: [{ id: 'solo', upstreamModel: 'mock-401', priority: 100 }],
      extraCredentials: [{ providerId: 'solo', label: 'second key', priority: 90 }],
    });
    const { res, json } = await chat(h);

    expect(res.statusCode).toBe(503);
    // Two attempts, one per credential — tried independently, not one poisoning
    // the other, and neither retried.
    expect(trail(json)).toHaveLength(2);
    expect(h.upstream.state.byModel['mock-401']).toBe(2);
  });
});

describe('exclusion', () => {
  it('skips a disabled provider', async () => {
    h = await harness();
    h.server.repos.providers.setEnabled('primary', false);
    const { json } = await chat(h);
    expect(meta(json).selected_provider).toBe('secondary');
    expect(h.upstream.state.byModel['mock-fast']).toBeUndefined();
  });

  it('skips a disabled model', async () => {
    h = await harness();
    h.server.repos.models.setEnabled('primary-model', false);
    const { json } = await chat(h);
    expect(meta(json).selected_provider).toBe('secondary');
  });

  it('skips a provider whose only credential is disabled', async () => {
    h = await harness();
    const cred = h.server.repos.credentials.list().find((c) => c.providerId === 'primary')!;
    h.server.repos.credentials.setEnabled(cred.id, false);
    const { json } = await chat(h);
    expect(meta(json).selected_provider).toBe('secondary');
  });

  it('returns 503 when everything is disabled, without calling anything', async () => {
    h = await harness();
    for (const p of h.server.repos.providers.list()) h.server.repos.providers.setEnabled(p.id, false);
    const { res, json } = await chat(h);
    expect(res.statusCode).toBe(503);
    expect((json as { error: { code: string } }).error.code).toBe('no_candidates_available');
    expect(h.upstream.state.requestCount).toBe(0);
  });
});

describe('attempt trail hygiene', () => {
  it('never contains key material', async () => {
    h = await harness({
      providers: [
        { id: 'a', upstreamModel: 'mock-429', priority: 100 },
        { id: 'b', upstreamModel: 'mock-fast', priority: 90 },
      ],
    });
    const { text } = await chat(h);
    expect(text).not.toContain('mock-local-key');
    expect(text).not.toContain('sk-router-test');
    // Credentials appear as opaque ids only.
    for (const attempt of trail(JSON.parse(text))) {
      expect(attempt.credential_id).toMatch(/^cred_/);
    }
  });

  it('is absent entirely without router_debug', async () => {
    h = await harness({
      providers: [
        { id: 'a', upstreamModel: 'mock-429', priority: 100 },
        { id: 'b', upstreamModel: 'mock-fast', priority: 90 },
      ],
    });
    const res = await h.server.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders,
      payload: { model: 'auto', messages: [{ role: 'user', content: 'x' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()._router).toBeUndefined();
    // The headers still say a failover happened, for clients that care.
    expect(res.headers['x-router-fallbacks']).toBe('1');
    expect(res.headers['x-router-provider']).toBe('b');
  });
});
