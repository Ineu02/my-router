import { encryptSecret, decryptSecret, type OAuthTokenRow, type Repositories } from '@router/config';
import type { OAuthTokenStore, StoredTokenSet } from '@router/router-core';

/**
 * Bridges the plaintext {@link OAuthTokenStore} the TokenManager expects to the
 * encrypted-at-rest `oauth_credentials` table.
 *
 * Encryption happens here and only here on the persistence path: the repo below
 * stores opaque blobs, and the TokenManager above sees only plaintext. The
 * passphrase (config.credentialEncKey) never travels further down than this
 * adapter.
 */
export class EncryptingOAuthStore implements OAuthTokenStore {
  constructor(
    private readonly repos: Repositories,
    private readonly encKey: string,
  ) {}

  load(credentialId: string): StoredTokenSet | null {
    const row = this.repos.oauth.get(credentialId);
    if (!row) return null;
    try {
      return {
        accessToken: decryptSecret(row.encAccess, this.encKey),
        refreshToken: decryptSecret(row.encRefresh, this.encKey),
        idToken: row.encId ? decryptSecret(row.encId, this.encKey) : null,
        expiresAt: row.expiresAt,
        scope: row.scope,
        accountId: row.accountId,
        email: row.email,
      };
    } catch {
      // A blob that won't decrypt (wrong/rotated key) is unusable — surface it
      // as "no tokens" so the credential fails closed rather than serving a
      // corrupt bearer.
      return null;
    }
  }

  save(credentialId: string, tokens: StoredTokenSet): void {
    const row: OAuthTokenRow = {
      credentialId,
      accountId: tokens.accountId,
      email: tokens.email,
      encAccess: encryptSecret(tokens.accessToken, this.encKey),
      encRefresh: encryptSecret(tokens.refreshToken, this.encKey),
      encId: tokens.idToken ? encryptSecret(tokens.idToken, this.encKey) : null,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
      updatedAt: Date.now(),
    };
    this.repos.oauth.upsert(row);
  }
}
