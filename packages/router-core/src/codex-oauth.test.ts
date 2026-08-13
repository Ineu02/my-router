import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  resolveEndpoints,
  exchangeCode,
  refreshTokens,
  decodeIdToken,
  accountIdFromClaims,
  isExpired,
  OAuthError,
  CODEX_DEFAULTS,
} from './codex-oauth.js';

const ep = resolveEndpoints({ issuer: 'http://localhost:9999' });

/** Mint a fake unsigned JWT with the given payload. */
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('codex-oauth: PKCE', () => {
  it('produces an S256 challenge that is SHA-256(verifier) base64url', () => {
    const { verifier, challenge, method } = generatePkce();
    expect(method).toBe('S256');
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(challenge).toBe(expected);
    // base64url: no +/=
    expect(challenge).not.toMatch(/[+/=]/);
  });

  it('generates unique verifiers and states', () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
    expect(generateState()).not.toBe(generateState());
  });
});

describe('codex-oauth: authorize URL', () => {
  it('contains all required params with S256 and org flag', () => {
    const url = new URL(buildAuthorizeUrl(ep, { challenge: 'CHAL', state: 'STATE' }));
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe(CODEX_DEFAULTS.clientId);
    expect(p.get('redirect_uri')).toBe(CODEX_DEFAULTS.redirectUri);
    expect(p.get('scope')).toBe(CODEX_DEFAULTS.scope);
    expect(p.get('code_challenge')).toBe('CHAL');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('id_token_add_organizations')).toBe('true');
    expect(p.get('state')).toBe('STATE');
    expect(url.origin).toBe('http://localhost:9999');
  });
});

describe('codex-oauth: id_token decoding', () => {
  it('extracts chatgpt_account_id from the auth namespace', () => {
    const jwt = fakeJwt({
      email: 'u@example.com',
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' },
    });
    const claims = decodeIdToken(jwt)!;
    expect(accountIdFromClaims(claims)).toBe('acct-123');
    expect(claims.email).toBe('u@example.com');
  });

  it('returns null for malformed jwt or missing claim', () => {
    expect(decodeIdToken('not.a.jwt-with-bad-b64.x')).not.toBeUndefined();
    expect(decodeIdToken('only-one-part')).toBeNull();
    expect(accountIdFromClaims({})).toBeNull();
  });
});

describe('codex-oauth: expiry', () => {
  it('flags tokens within skew as expired', () => {
    const now = 1_000_000;
    expect(isExpired(now + 10_000, 60_000, now)).toBe(true); // inside skew
    expect(isExpired(now + 120_000, 60_000, now)).toBe(false); // outside skew
    expect(isExpired(now - 1, 0, now)).toBe(true); // already past
  });
});

describe('codex-oauth: token exchange', () => {
  function fetchReturning(status: number, body: unknown): typeof fetch {
    return async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
  }

  it('exchanges an authorization code into a token set with account id', async () => {
    const idToken = fakeJwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-xyz' } });
    const f = fetchReturning(200, {
      access_token: 'at-1',
      refresh_token: 'rt-1',
      id_token: idToken,
      expires_in: 3600,
      scope: 'openid',
    });
    const set = await exchangeCode(ep, { code: 'c', verifier: 'v' }, f);
    expect(set.accessToken).toBe('at-1');
    expect(set.refreshToken).toBe('rt-1');
    expect(set.accountId).toBe('acct-xyz');
    expect(set.expiresAt).toBeGreaterThan(Date.now());
  });

  it('reuses the old refresh token when the server omits it', async () => {
    const f = fetchReturning(200, { access_token: 'at-2', id_token: fakeJwt({}), expires_in: 60 });
    const set = await refreshTokens(ep, { refreshToken: 'old-rt' }, f);
    expect(set.accessToken).toBe('at-2');
    expect(set.refreshToken).toBe('old-rt');
  });

  it('rotates the refresh token when the server returns a new one', async () => {
    const f = fetchReturning(200, { access_token: 'at-3', refresh_token: 'new-rt', expires_in: 60 });
    const set = await refreshTokens(ep, { refreshToken: 'old-rt' }, f);
    expect(set.refreshToken).toBe('new-rt');
  });

  it('throws OAuthError(invalid_grant) on a 400 error body', async () => {
    const f = fetchReturning(400, { error: 'invalid_grant', error_description: 'expired' });
    await expect(refreshTokens(ep, { refreshToken: 'x' }, f)).rejects.toMatchObject({
      name: 'OAuthError',
      kind: 'invalid_grant',
    });
  });

  it('throws OAuthError(malformed) on non-JSON', async () => {
    const f = fetchReturning(200, 'not json');
    await expect(exchangeCode(ep, { code: 'c', verifier: 'v' }, f)).rejects.toBeInstanceOf(OAuthError);
  });
});
