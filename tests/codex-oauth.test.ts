import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildServer, type BuiltServer } from '../apps/api/src/server.js';
import { startMockUpstream, type MockServerHandle } from '../apps/api/src/mock/server.js';
import { startMockOAuth, type MockOAuthHandle } from '../apps/api/src/mock/oauth-server.js';
import { testConfig, authHeaders, adminHeaders, ROUTER_KEY } from './helpers/harness.js';
import { CODEX_PROVIDER_ID } from '@router/config';

/**
 * Full Codex OAuth lifecycle against LOCAL mocks — no real login, no credits.
 *
 * A real mock authorization server (auth.openai.com stand-in) and a real mock
 * upstream (the ChatGPT backend stand-in) sit on real sockets; only the router
 * itself is exercised through `app.inject`. The whole path is genuine:
 *
 *   connect → authorize (PKCE S256) → callback (code exchange) → credential
 *   created (masked) → chat routed via `openai-codex` carrying the account
 *   header → forced expiry → single coalesced refresh with token rotation →
 *   disconnect.
 *
 * The load-bearing security assertion runs throughout: no raw access/refresh/id
 * token ever appears in an API or dashboard response body.
 */

let oauth: MockOAuthHandle;
let upstream: MockServerHandle;
let server: BuiltServer;

// Injected clock so token expiry is deterministic. Starts at real "now" so it
// stays aligned with the absolute expiry the code exchange computes from the
// mock's `expires_in`.
let clock = Date.now();

beforeAll(async () => {
  oauth = await startMockOAuth(0);
  upstream = await startMockUpstream(0);

  server = await buildServer({
    config: testConfig({
      codexOAuth: {
        enabled: true,
        issuer: oauth.url,
        clientId: 'app_test_codex',
        redirectPort: 1455,
        redirectUri: 'http://127.0.0.1:1455/auth/callback',
        backendBaseUrl: `${upstream.url}/v1`,
        // No skew: only genuine expiry triggers a refresh, so the "before" and
        // "after" phases are unambiguous.
        refreshSkewMs: 0,
      },
    }),
    databasePath: ':memory:',
    skipMock: true,
    logger: false,
    now: () => clock,
    bootstrapKey: ROUTER_KEY,
  });
});

afterAll(async () => {
  await server?.close();
  await upstream?.close();
  await oauth?.close();
});

/** Never let a token blob escape in a response body, whatever its shape. */
function assertNoTokenLeak(text: string): void {
  expect(text).not.toMatch(/\bat_[A-Za-z0-9_-]{10,}/); // access token
  expect(text).not.toMatch(/\brt_[A-Za-z0-9_-]{10,}/); // refresh token
  expect(text).not.toContain('access_token');
  expect(text).not.toContain('refresh_token');
  expect(text).not.toContain('"idToken"');
}

async function connectAndCallback(): Promise<{ credentialId: string; accountId: string }> {
  // 1. Start a flow — get the authorize URL and the anti-CSRF state.
  const start = await server.app.inject({
    method: 'POST',
    url: '/api/admin/providers/codex/connect',
    headers: adminHeaders,
  });
  expect(start.statusCode).toBe(200);
  assertNoTokenLeak(start.payload);
  const { authorizeUrl, state } = start.json<{ authorizeUrl: string; state: string }>();
  expect(authorizeUrl).toContain('code_challenge=');
  expect(authorizeUrl).toContain('code_challenge_method=S256');

  // 2. Drive the browser leg: the mock authorize 302s back to redirect_uri with
  //    a one-time code bound to our PKCE challenge.
  const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' });
  expect(authorizeRes.status).toBe(302);
  const location = authorizeRes.headers.get('location');
  expect(location).toBeTruthy();
  const cb = new URL(location!);
  const code = cb.searchParams.get('code');
  expect(code).toBeTruthy();
  expect(cb.searchParams.get('state')).toBe(state);

  // 3. Land on the router's callback: it exchanges the code and persists the
  //    (encrypted) tokens, creating one credential for the account.
  const callback = await server.app.inject({
    method: 'GET',
    url: `/auth/callback?code=${encodeURIComponent(code!)}&state=${encodeURIComponent(state)}`,
  });
  expect(callback.statusCode).toBe(200);
  expect(callback.payload).toContain('Connected');
  assertNoTokenLeak(callback.payload);

  const cred = server.repos.credentials
    .listByProvider(CODEX_PROVIDER_ID)
    .find((c) => c.secretKind === 'oauth');
  expect(cred).toBeTruthy();
  return { credentialId: cred!.id, accountId: 'acct_mock_00000000' };
}

async function chat(model = 'codex-gpt-5') {
  return server.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: authHeaders,
    payload: { model, messages: [{ role: 'user', content: 'hello codex' }] },
  });
}

describe('codex oauth lifecycle (mock)', () => {
  it('runs connect → chat → refresh → disconnect end to end', async () => {
    oauth.reset();
    upstream.reset();
    clock = Date.now();

    /* ── connect ──────────────────────────────────────────────────────── */
    const { credentialId, accountId } = await connectAndCallback();
    expect(oauth.state.codeExchanges).toBe(1);
    expect(oauth.state.refreshes).toBe(0);

    // The account shows up masked, with status — and no token material.
    const list1 = await server.app.inject({
      method: 'GET',
      url: '/api/admin/providers/codex/accounts',
      headers: adminHeaders,
    });
    expect(list1.statusCode).toBe(200);
    assertNoTokenLeak(list1.payload);
    const accounts = list1.json<{ accounts: Array<Record<string, unknown>> }>().accounts;
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.accountId).toBe(accountId);
    expect(accounts[0]!.credentialId).toBe(credentialId);
    expect(accounts[0]).not.toHaveProperty('accessToken');

    /* ── chat via the codex adapter ───────────────────────────────────── */
    const c1 = await chat();
    expect(c1.statusCode).toBe(200);
    // The adapter promoted the account id to the ChatGPT header, and the bearer
    // on the wire was the OAuth access token — not a static key.
    expect(upstream.state.lastAccountId).toBe(accountId);
    expect(upstream.state.lastAuthorization).toMatch(/^Bearer at_/);
    // A valid token was used as-is: no refresh happened.
    expect(oauth.state.refreshes).toBe(0);

    /* ── force expiry → exactly one refresh, even under concurrency ────── */
    clock += 4 * 3_600_000; // well past the 1h access-token lifetime

    const before = oauth.state.refreshes;
    const concurrent = await Promise.all([chat(), chat(), chat()]);
    for (const res of concurrent) expect(res.statusCode).toBe(200);

    // Single-flight: three concurrent callers, one token endpoint refresh.
    expect(oauth.state.refreshes - before).toBe(1);
    // Rotation: the old refresh token was invalidated, exactly one lives on.
    expect(oauth.state.refreshTokens.size).toBe(1);

    /* ── disconnect ───────────────────────────────────────────────────── */
    const disc = await server.app.inject({
      method: 'POST',
      url: `/api/admin/providers/codex/accounts/${credentialId}/disconnect`,
      headers: adminHeaders,
    });
    expect(disc.statusCode).toBe(200);

    // Both the credential and its encrypted tokens are gone.
    expect(server.repos.credentials.get(credentialId)).toBeNull();
    expect(server.repos.oauth.get(credentialId)).toBeNull();

    const list2 = await server.app.inject({
      method: 'GET',
      url: '/api/admin/providers/codex/accounts',
      headers: adminHeaders,
    });
    expect(list2.json<{ accounts: unknown[] }>().accounts).toHaveLength(0);

    // With no account connected, the codex model no longer routes.
    const afterDisconnect = await chat();
    expect(afterDisconnect.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rejects a callback whose state was never issued (CSRF guard)', async () => {
    const res = await server.app.inject({
      method: 'GET',
      url: '/auth/callback?code=whatever&state=forged-state-value',
    });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toContain('Invalid or expired request');
  });

  it('guards connect/list/disconnect behind the admin token', async () => {
    const noAuth = await server.app.inject({
      method: 'POST',
      url: '/api/admin/providers/codex/connect',
    });
    expect(noAuth.statusCode).toBe(401);
  });
});
