import {
  refreshTokens,
  isExpired,
  OAuthError,
  type OAuthEndpoints,
} from './codex-oauth.js';

/**
 * Runtime access-token provider for OAuth credentials.
 *
 * The routing engine asks for a bearer token by credential id; this class hands
 * back a still-valid access token, refreshing transparently when the stored one
 * is at (or within skew of) expiry. Two properties matter:
 *
 *  - **Single-flight**: N concurrent requests that all find the token expired
 *    trigger exactly ONE refresh. The rest await the same in-flight promise, so
 *    a rotating refresh token is never spent twice in a race (which would
 *    invalidate it and lock the account out).
 *  - **Rotation-safe persistence**: the refresh response's refresh token — which
 *    may differ — is always written back before the access token is returned.
 *
 * Crypto and storage live behind {@link OAuthTokenStore}: this class only ever
 * sees plaintext token sets, never the database or the encryption key.
 */

export interface StoredTokenSet {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  /** Absolute epoch-ms expiry. */
  expiresAt: number;
  scope: string | null;
  accountId: string | null;
  email: string | null;
}

export interface OAuthTokenStore {
  /** Decrypted tokens for a credential, or null if none are stored. */
  load(credentialId: string): StoredTokenSet | null;
  /** Persist (encrypting) the given tokens for a credential. */
  save(credentialId: string, tokens: StoredTokenSet): void;
}

export interface TokenManagerOptions {
  store: OAuthTokenStore;
  endpoints: OAuthEndpoints;
  fetchImpl?: typeof fetch;
  /** Refresh this many ms before actual expiry. Default 60s. */
  skewMs?: number;
  now?: () => number;
  /**
   * Called when a refresh fails in a way that means the account is done for
   * (an `invalid_grant` — the refresh token itself is dead). The engine wires
   * this to the AUTH health policy so the credential leaves rotation.
   */
  onRefreshFailure?: (credentialId: string, err: OAuthError) => void;
  /** Called after a successful refresh, for observability (SSE/health). */
  onRefresh?: (credentialId: string, tokens: StoredTokenSet) => void;
}

export interface AccessContext {
  accessToken: string;
  /** Sent as the `chatgpt-account-id` header by the codex adapter. */
  accountId: string | null;
}

export class TokenManager {
  private readonly store: OAuthTokenStore;
  private readonly endpoints: OAuthEndpoints;
  private readonly fetchImpl: typeof fetch;
  private readonly skewMs: number;
  private readonly now: () => number;
  private readonly onRefreshFailure?: (credentialId: string, err: OAuthError) => void;
  private readonly onRefresh?: (credentialId: string, tokens: StoredTokenSet) => void;

  /** credentialId → in-flight refresh, so concurrent callers coalesce. */
  private readonly inflight = new Map<string, Promise<StoredTokenSet>>();

  constructor(opts: TokenManagerOptions) {
    this.store = opts.store;
    this.endpoints = opts.endpoints;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.skewMs = opts.skewMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.onRefreshFailure = opts.onRefreshFailure;
    this.onRefresh = opts.onRefresh;
  }

  /**
   * Return a valid access token for a credential, refreshing if necessary.
   * Throws {@link OAuthError} if no tokens are stored or the refresh fails.
   */
  async getAccessToken(credentialId: string): Promise<AccessContext> {
    const current = this.store.load(credentialId);
    if (!current) {
      throw new OAuthError('invalid_grant', `no OAuth tokens stored for credential ${credentialId}`);
    }
    if (!isExpired(current.expiresAt, this.skewMs, this.now())) {
      return { accessToken: current.accessToken, accountId: current.accountId };
    }
    const refreshed = await this.refresh(credentialId, current);
    return { accessToken: refreshed.accessToken, accountId: refreshed.accountId };
  }

  /** Force a refresh regardless of expiry (used by tests and manual re-auth). */
  async forceRefresh(credentialId: string): Promise<StoredTokenSet> {
    const current = this.store.load(credentialId);
    if (!current) {
      throw new OAuthError('invalid_grant', `no OAuth tokens stored for credential ${credentialId}`);
    }
    return this.refresh(credentialId, current);
  }

  private refresh(credentialId: string, current: StoredTokenSet): Promise<StoredTokenSet> {
    const existing = this.inflight.get(credentialId);
    if (existing) return existing;

    const p = this.doRefresh(credentialId, current).finally(() => {
      this.inflight.delete(credentialId);
    });
    this.inflight.set(credentialId, p);
    return p;
  }

  private async doRefresh(credentialId: string, current: StoredTokenSet): Promise<StoredTokenSet> {
    let fresh;
    try {
      fresh = await refreshTokens(
        this.endpoints,
        { refreshToken: current.refreshToken },
        this.fetchImpl,
      );
    } catch (err) {
      // A dead refresh token can't be retried — park the credential. Transient
      // failures (network/server) bubble up without disabling, so the next
      // request can try again.
      if (err instanceof OAuthError && err.kind === 'invalid_grant') {
        this.onRefreshFailure?.(credentialId, err);
      }
      throw err;
    }

    const merged: StoredTokenSet = {
      accessToken: fresh.accessToken,
      // refreshTokens() already falls back to the old token when the server
      // omits one; persist whatever it resolved to.
      refreshToken: fresh.refreshToken || current.refreshToken,
      idToken: fresh.idToken || current.idToken,
      expiresAt: fresh.expiresAt,
      scope: fresh.scope ?? current.scope,
      accountId: fresh.accountId ?? current.accountId,
      email: fresh.email ?? current.email,
    };

    this.store.save(credentialId, merged);
    this.onRefresh?.(credentialId, merged);
    return merged;
  }
}
