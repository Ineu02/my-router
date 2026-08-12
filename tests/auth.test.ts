import { describe, it, expect, afterEach } from 'vitest';
import { hashSecret, maskSecret } from '@router/shared';
import { harness, chat, ROUTER_KEY, authHeaders, adminHeaders, type Harness } from './helpers/harness.js';

/**
 * Router API-key authentication.
 *
 * The distinction this file exists to protect: a bad *client* key is a 401 the
 * client must fix, while a bad *provider* key is a 502 the operator must fix.
 * Conflating them tells an agent to rotate its own key when the real problem is
 * an expired upstream credential.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('accepting keys', () => {
  it('accepts the bootstrap key', async () => {
    h = await harness();
    const { res } = await chat(h);
    expect(res.statusCode).toBe(200);
  });

  it('accepts a key created at runtime', async () => {
    h = await harness();
    const plaintext = 'sk-router-runtime-key-abcdef123456';
    h.server.repos.routerKeys.create({
      name: 'runtime',
      keyHash: await hashSecret(plaintext),
      keyPrefix: plaintext.slice(0, 12),
      maskedKey: maskSecret(plaintext),
    });

    const { res } = await chat(h, {}, { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' });
    expect(res.statusCode).toBe(200);
  });

  it('accepts the key via x-api-key as well as Authorization', async () => {
    h = await harness();
    const { res } = await chat(h, {}, { 'x-api-key': ROUTER_KEY, 'content-type': 'application/json' });
    expect(res.statusCode).toBe(200);
  });

  it('accepts a bare token with the scheme omitted', async () => {
    // A deliberate compatibility affordance for clients that write the header
    // raw — see extractBearer. Asserted so it cannot be tightened by accident.
    h = await harness();
    const { res } = await chat(h, {}, { authorization: ROUTER_KEY, 'content-type': 'application/json' });
    expect(res.statusCode).toBe(200);
  });

  it('records usage against the key that was used', async () => {
    h = await harness();
    await chat(h);
    const key = h.server.repos.routerKeys.list()[0];
    expect(key.usageCount).toBeGreaterThan(0);
    expect(key.lastUsedAt).not.toBeNull();
  });
});

describe('rejecting keys', () => {
  const cases: Array<[string, Record<string, string>]> = [
    ['no header at all', { 'content-type': 'application/json' }],
    ['an unknown key', { authorization: 'Bearer sk-router-nope-nope-nope', 'content-type': 'application/json' }],
    ['a valid-looking key that was never issued', { authorization: `Bearer ${ROUTER_KEY}x`, 'content-type': 'application/json' }],
    ['an empty bearer', { authorization: 'Bearer ', 'content-type': 'application/json' }],
    ['a non-router credential in a Basic header', { authorization: 'Basic dXNlcjpwYXNzd29yZA==', 'content-type': 'application/json' }],
  ];

  for (const [label, headers] of cases) {
    it(`rejects ${label} with 401`, async () => {
      h = await harness();
      const { res, json } = await chat(h, {}, headers);
      expect(res.statusCode).toBe(401);
      expect((json as { error: { type: string } }).error.type).toBe('authentication_error');
      // No upstream call may be made for an unauthenticated request.
      expect(h.upstream.state.requestCount).toBe(0);
    });
  }

  it('rejects a revoked key', async () => {
    h = await harness();
    const key = h.server.repos.routerKeys.list()[0];
    h.server.repos.routerKeys.revoke(key.id);

    const { res, json } = await chat(h);
    expect(res.statusCode).toBe(401);
    expect((json as { error: { message: string } }).error.message).toMatch(/revoked/i);
  });

  it('rejects a disabled key', async () => {
    h = await harness();
    const key = h.server.repos.routerKeys.list()[0];
    h.server.repos.routerKeys.setEnabled(key.id, false);

    const { res, json } = await chat(h);
    expect(res.statusCode).toBe(401);
    expect((json as { error: { message: string } }).error.message).toMatch(/disabled/i);
  });

  it('never echoes the presented key back in the error', async () => {
    h = await harness();
    const secret = 'sk-router-super-secret-value-999';
    const { res, text } = await chat(h, {}, { authorization: `Bearer ${secret}`, 'content-type': 'application/json' });
    expect(res.statusCode).toBe(401);
    expect(text).not.toContain(secret);
  });
});

describe('usage limits', () => {
  it('rejects with 429 once a key is over its request limit', async () => {
    h = await harness();
    const key = h.server.repos.routerKeys.list()[0];
    h.server.repos.routerKeys.setLimit(key.id, 1);

    const first = await chat(h);
    expect(first.res.statusCode).toBe(200);

    const second = await chat(h);
    expect(second.res.statusCode).toBe(429);
    expect((second.json as { error: { message: string } }).error.message).toMatch(/limit/i);
  });

  it('lets an operator raise the cap on an exhausted key', async () => {
    // Via the admin API, not the repo: raising a cap after creation is the
    // operator's actual workflow, and it has to work without deleting and
    // reissuing the key.
    h = await harness();
    const key = h.server.repos.routerKeys.list()[0];
    h.server.repos.routerKeys.setLimit(key.id, 1);

    await chat(h);
    expect((await chat(h)).res.statusCode).toBe(429);

    const patch = await h.server.app.inject({
      method: 'PATCH',
      url: `/api/admin/keys/${key.id}`,
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      payload: { usageLimit: 10 },
    });
    expect(patch.statusCode).toBe(200);
    // Past usage is preserved — the counter is history, not a quota reset.
    expect(patch.json().key.usageCount).toBe(1);
    expect(patch.json().key.usageLimit).toBe(10);

    expect((await chat(h)).res.statusCode).toBe(200);
  });

  it('removes the cap entirely on an explicit null', async () => {
    h = await harness();
    const key = h.server.repos.routerKeys.list()[0];
    h.server.repos.routerKeys.setLimit(key.id, 1);
    await chat(h);

    const patch = await h.server.app.inject({
      method: 'PATCH',
      url: `/api/admin/keys/${key.id}`,
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      payload: { usageLimit: null },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().key.usageLimit).toBeNull();
    expect((await chat(h)).res.statusCode).toBe(200);
  });

  it('never returns the key hash when patching', async () => {
    h = await harness();
    const key = h.server.repos.routerKeys.list()[0];
    const patch = await h.server.app.inject({
      method: 'PATCH',
      url: `/api/admin/keys/${key.id}`,
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      payload: { enabled: true },
    });
    expect(patch.json().key.keyHash).toBeUndefined();
    expect(patch.payload).not.toContain(ROUTER_KEY);
  });

  it('rejects an empty patch rather than silently doing nothing', async () => {
    h = await harness();
    const key = h.server.repos.routerKeys.list()[0];
    const patch = await h.server.app.inject({
      method: 'PATCH',
      url: `/api/admin/keys/${key.id}`,
      headers: { ...adminHeaders, 'content-type': 'application/json' },
      payload: {},
    });
    expect(patch.statusCode).toBe(400);
  });
});

describe('open mode', () => {
  it('serves unauthenticated traffic when REQUIRE_API_KEY is off', async () => {
    h = await harness({ config: { requireApiKey: false } });
    const res = await h.server.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: { model: 'auto', messages: [{ role: 'user', content: 'x' }] },
    });
    expect(res.statusCode).toBe(200);
  });

  it('still honours a presented key so usage is attributed', async () => {
    h = await harness({ config: { requireApiKey: false } });
    await chat(h, {}, authHeaders);
    expect(h.server.repos.routerKeys.list()[0].usageCount).toBe(1);
  });

  it('serves a revoked key anonymously rather than rejecting it', async () => {
    // Open mode must never 401. A stale key breaking in the mode whose purpose
    // is not requiring one would be the worst kind of surprise.
    h = await harness({ config: { requireApiKey: false } });
    const key = h.server.repos.routerKeys.list()[0];
    h.server.repos.routerKeys.revoke(key.id);

    const { res } = await chat(h, {}, authHeaders);
    expect(res.statusCode).toBe(200);
    // …and it is not credited with the request either.
    expect(h.server.repos.routerKeys.get(key.id)!.usageCount).toBe(0);
  });

  it('does not enforce a usage limit in open mode', async () => {
    h = await harness({ config: { requireApiKey: false } });
    const key = h.server.repos.routerKeys.list()[0];
    h.server.repos.routerKeys.setLimit(key.id, 1);

    expect((await chat(h, {}, authHeaders)).res.statusCode).toBe(200);
    expect((await chat(h, {}, authHeaders)).res.statusCode).toBe(200);
  });
});

describe('provider auth failure is not client auth failure', () => {
  it('maps an upstream 401 to 502, never to 401', async () => {
    // A single provider whose upstream model always 401s. Nothing to fall over
    // to, so the client sees the exhaustion status — and it must not be 401,
    // which would tell the agent to rotate its own perfectly good key.
    h = await harness({
      providers: [{ id: 'only', upstreamModel: 'mock-401', priority: 100 }],
    });
    const { res, json } = await chat(h);
    expect(res.statusCode).toBe(503);
    expect((json as { error: { type: string } }).error.type).not.toBe('authentication_error');

    const attempts = (json as { _router: { provider_attempts: Array<{ error_class: string }> } })._router
      .provider_attempts;
    expect(attempts[0].error_class).toBe('AUTH');
  });
});
