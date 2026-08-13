import { createHash, randomBytes } from 'node:crypto';

/**
 * Pure OAuth 2.0 Authorization Code + PKCE logic for the official ChatGPT/Codex
 * login flow. No storage, no side effects beyond `fetch` — everything here is
 * deterministic given its inputs, which is what makes it unit-testable against a
 * local mock authorization server.
 *
 * Official constants (verified against openai/codex `codex-rs/login`) are the
 * defaults; every one is overridable via {@link OAuthEndpoints} so tests (and a
 * self-hosted mock) can point the whole flow at localhost with no real login.
 */

/* ── Verified official defaults ───────────────────────────────────────── */

export const CODEX_DEFAULTS = {
  issuer: 'https://auth.openai.com',
  authorizePath: '/oauth/authorize',
  tokenPath: '/oauth/token',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  redirectUri: 'http://localhost:1455/auth/callback',
  scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
} as const;

/** JWT claim namespace carrying the ChatGPT account id in the id_token. */
const AUTH_CLAIM_NS = 'https://api.openai.com/auth';

export interface OAuthEndpoints {
  issuer: string;
  authorizePath: string;
  tokenPath: string;
  clientId: string;
  redirectUri: string;
  scope: string;
}

export function resolveEndpoints(overrides: Partial<OAuthEndpoints> = {}): OAuthEndpoints {
  return { ...CODEX_DEFAULTS, ...overrides };
}

/* ── PKCE ─────────────────────────────────────────────────────────────── */

export interface PkcePair {
  /** High-entropy secret kept by us and sent only on the token exchange. */
  verifier: string;
  /** SHA-256(verifier), base64url — sent on the authorize redirect. */
  challenge: string;
  method: 'S256';
}

/** Generate a PKCE verifier/challenge pair (RFC 7636, S256). */
export function generatePkce(): PkcePair {
  // 32 random bytes → 43-char base64url verifier (within the 43–128 spec range).
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
}

/** Opaque anti-CSRF state value tying an authorize redirect to its callback. */
export function generateState(): string {
  return randomBytes(24).toString('base64url');
}

/* ── Authorize URL ────────────────────────────────────────────────────── */

/**
 * Build the full authorize URL the operator's browser is sent to. Mirrors
 * Codex's `build_authorize_url`, including `id_token_add_organizations=true`.
 */
export function buildAuthorizeUrl(
  ep: OAuthEndpoints,
  args: { challenge: string; state: string },
): string {
  const url = new URL(ep.authorizePath, ep.issuer);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: ep.clientId,
    redirect_uri: ep.redirectUri,
    scope: ep.scope,
    code_challenge: args.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    state: args.state,
  }).toString();
  return url.toString();
}

/* ── Token responses ──────────────────────────────────────────────────── */

export interface TokenSet {
  accessToken: string;
  /** Refresh tokens ROTATE — persist whatever the server hands back. */
  refreshToken: string;
  idToken: string;
  /** Absolute epoch-ms expiry, computed from `expires_in` at receipt. */
  expiresAt: number;
  scope?: string;
  accountId: string | null;
  email: string | null;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

/**
 * Exchange an authorization code for tokens (the `authorization_code` grant).
 * Sends `code_verifier` per PKCE.
 */
export async function exchangeCode(
  ep: OAuthEndpoints,
  args: { code: string; verifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: ep.clientId,
    code: args.code,
    redirect_uri: ep.redirectUri,
    code_verifier: args.verifier,
  });
  return postToken(ep, body, fetchImpl);
}

/**
 * Redeem a refresh token for a fresh access token (the `refresh_token` grant).
 * The response's refresh token — which may differ — is returned so the caller
 * can persist the rotated value.
 */
export async function refreshTokens(
  ep: OAuthEndpoints,
  args: { refreshToken: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: ep.clientId,
    refresh_token: args.refreshToken,
    scope: ep.scope,
  });
  const set = await postToken(ep, body, fetchImpl);
  // Some servers omit the refresh token on refresh, meaning "reuse the old one".
  if (!set.refreshToken) set.refreshToken = args.refreshToken;
  return set;
}

async function postToken(
  ep: OAuthEndpoints,
  body: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetchImpl(new URL(ep.tokenPath, ep.issuer).toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch (err) {
    throw new OAuthError('network', `token endpoint unreachable: ${(err as Error).message}`);
  }

  const text = await res.text();
  let json: RawTokenResponse;
  try {
    json = text ? (JSON.parse(text) as RawTokenResponse) : {};
  } catch {
    throw new OAuthError('malformed', `token endpoint returned non-JSON (HTTP ${res.status})`);
  }

  if (!res.ok || json.error) {
    throw new OAuthError(
      res.status === 400 || res.status === 401 ? 'invalid_grant' : 'server',
      json.error_description || json.error || `token endpoint HTTP ${res.status}`,
      res.status,
    );
  }
  if (!json.access_token) {
    throw new OAuthError('malformed', 'token response missing access_token');
  }

  const idToken = json.id_token ?? '';
  const claims = idToken ? decodeIdToken(idToken) : null;
  const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? '',
    idToken,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: json.scope,
    accountId: claims ? accountIdFromClaims(claims) : null,
    email: claims ? (typeof claims.email === 'string' ? claims.email : null) : null,
  };
}

/* ── id_token decoding ────────────────────────────────────────────────── */

export type IdTokenClaims = Record<string, unknown>;

/**
 * Decode (NOT verify) a JWT's payload. Signature verification against OpenAI's
 * JWKS is a follow-up; for now the id_token is only read to extract the account
 * id, and it arrives over TLS directly from the token endpoint we just called.
 */
export function decodeIdToken(jwt: string): IdTokenClaims | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1]!, 'base64url').toString('utf8');
    return JSON.parse(payload) as IdTokenClaims;
  } catch {
    return null;
  }
}

/** Pull `chatgpt_account_id` from the OpenAI auth-claim namespace. */
export function accountIdFromClaims(claims: IdTokenClaims): string | null {
  const ns = claims[AUTH_CLAIM_NS];
  if (ns && typeof ns === 'object') {
    const id = (ns as Record<string, unknown>).chatgpt_account_id;
    if (typeof id === 'string' && id) return id;
  }
  // Fallback: some tokens carry it top-level.
  const flat = claims.chatgpt_account_id;
  return typeof flat === 'string' && flat ? flat : null;
}

/* ── Expiry ───────────────────────────────────────────────────────────── */

/** True if the token is expired or within `skewMs` of expiring. */
export function isExpired(expiresAt: number, skewMs = 60_000, now = Date.now()): boolean {
  return now >= expiresAt - skewMs;
}

/* ── Errors ───────────────────────────────────────────────────────────── */

export type OAuthErrorKind = 'network' | 'malformed' | 'invalid_grant' | 'server';

/** A failure in the OAuth flow itself (distinct from a routing RouterError). */
export class OAuthError extends Error {
  constructor(
    readonly kind: OAuthErrorKind,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}
