import { describe, it, expect, vi } from 'vitest';
import { TokenManager, type OAuthTokenStore, type StoredTokenSet } from './token-manager.js';
import { resolveEndpoints } from './codex-oauth.js';

const ep = resolveEndpoints({ issuer: 'http://localhost:9999' });

function memStore(initial: StoredTokenSet): OAuthTokenStore & { current: StoredTokenSet } {
  return {
    current: { ...initial },
    load() {
      return this.current;
    },
    save(_id, t) {
      this.current = { ...t };
    },
  };
}

function baseTokens(overrides: Partial<StoredTokenSet> = {}): StoredTokenSet {
  return {
    accessToken: 'at-old',
    refreshToken: 'rt-old',
    idToken: null,
    expiresAt: Date.now() + 3_600_000,
    scope: 'openid',
    accountId: 'acct-1',
    email: 'u@example.com',
    ...overrides,
  };
}

/** A token endpoint that counts calls and can be made slow, to expose races. */
function countingFetch(opts: { delayMs?: number; newRefresh?: string } = {}) {
  const state = { calls: 0 };
  const impl = (async () => {
    state.calls++;
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    return new Response(
      JSON.stringify({
        access_token: `at-new-${state.calls}`,
        refresh_token: opts.newRefresh ?? `rt-new-${state.calls}`,
        expires_in: 3600,
        scope: 'openid',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;
  return { impl, state };
}

describe('TokenManager', () => {
  it('returns the stored token without refreshing when it is still valid', async () => {
    const store = memStore(baseTokens());
    const { impl, state } = countingFetch();
    const tm = new TokenManager({ store, endpoints: ep, fetchImpl: impl });
    const ctx = await tm.getAccessToken('cred-1');
    expect(ctx.accessToken).toBe('at-old');
    expect(ctx.accountId).toBe('acct-1');
    expect(state.calls).toBe(0);
  });

  it('refreshes when the token is within skew of expiry', async () => {
    const store = memStore(baseTokens({ expiresAt: Date.now() + 10_000 }));
    const { impl, state } = countingFetch();
    const tm = new TokenManager({ store, endpoints: ep, fetchImpl: impl, skewMs: 60_000 });
    const ctx = await tm.getAccessToken('cred-1');
    expect(state.calls).toBe(1);
    expect(ctx.accessToken).toBe('at-new-1');
  });

  it('single-flights concurrent refreshes into exactly one token request', async () => {
    const store = memStore(baseTokens({ expiresAt: Date.now() - 1 }));
    const { impl, state } = countingFetch({ delayMs: 50 });
    const tm = new TokenManager({ store, endpoints: ep, fetchImpl: impl });

    const results = await Promise.all(
      Array.from({ length: 8 }, () => tm.getAccessToken('cred-1')),
    );

    expect(state.calls).toBe(1); // the whole point
    // Every caller saw the same freshly-refreshed access token.
    for (const r of results) expect(r.accessToken).toBe('at-new-1');
  });

  it('persists the rotated refresh token', async () => {
    const store = memStore(baseTokens({ expiresAt: Date.now() - 1 }));
    const { impl } = countingFetch({ newRefresh: 'rt-rotated' });
    const tm = new TokenManager({ store, endpoints: ep, fetchImpl: impl });
    await tm.getAccessToken('cred-1');
    expect(store.current.refreshToken).toBe('rt-rotated');
    expect(store.current.accessToken).toBe('at-new-1');
  });

  it('allows a subsequent independent refresh after the first completes', async () => {
    const store = memStore(baseTokens({ expiresAt: Date.now() - 1 }));
    const { impl, state } = countingFetch();
    const tm = new TokenManager({ store, endpoints: ep, fetchImpl: impl });
    await tm.forceRefresh('cred-1');
    await tm.forceRefresh('cred-1');
    expect(state.calls).toBe(2); // sequential calls are NOT coalesced
  });

  it('invokes onRefreshFailure and rethrows on invalid_grant', async () => {
    const store = memStore(baseTokens({ expiresAt: Date.now() - 1 }));
    const badFetch = (async () =>
      new Response(JSON.stringify({ error: 'invalid_grant' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const onFail = vi.fn();
    const tm = new TokenManager({ store, endpoints: ep, fetchImpl: badFetch, onRefreshFailure: onFail });

    await expect(tm.getAccessToken('cred-1')).rejects.toMatchObject({ kind: 'invalid_grant' });
    expect(onFail).toHaveBeenCalledOnce();
    expect(onFail).toHaveBeenCalledWith('cred-1', expect.anything());
  });

  it('does NOT disable the credential on a transient server error', async () => {
    const store = memStore(baseTokens({ expiresAt: Date.now() - 1 }));
    const badFetch = (async () =>
      new Response(JSON.stringify({ error: 'server_error' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const onFail = vi.fn();
    const tm = new TokenManager({ store, endpoints: ep, fetchImpl: badFetch, onRefreshFailure: onFail });

    await expect(tm.getAccessToken('cred-1')).rejects.toBeTruthy();
    expect(onFail).not.toHaveBeenCalled();
  });

  it('throws when no tokens are stored', async () => {
    const store: OAuthTokenStore = { load: () => null, save: () => {} };
    const tm = new TokenManager({ store, endpoints: ep });
    await expect(tm.getAccessToken('missing')).rejects.toMatchObject({ name: 'OAuthError' });
  });
});
