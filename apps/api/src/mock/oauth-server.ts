import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

/**
 * Local mock OAuth 2.0 authorization server — a real HTTP server that stands in
 * for `https://auth.openai.com` so the whole Codex login flow can be verified
 * end to end with no real credentials and no billable login.
 *
 * It implements exactly the two endpoints the router's `codex-oauth` client
 * calls:
 *
 *   GET  /oauth/authorize   validates PKCE params, mints a one-time code,
 *                           302-redirects to redirect_uri?code=..&state=..
 *   POST /oauth/token       authorization_code  → issues a token set
 *                           refresh_token        → ROTATES the refresh token
 *
 * The id_token is a real (unsigned-payload) JWT carrying
 * `https://api.openai.com/auth`.chatgpt_account_id, which is what the adapter
 * promotes to the `chatgpt-account-id` header.
 *
 * PKCE S256 is genuinely enforced: the code_verifier presented at /oauth/token
 * must hash to the code_challenge presented at /oauth/authorize, or the grant is
 * rejected. Refresh tokens rotate and old ones are invalidated, so a
 * double-spend (the race single-flight exists to prevent) surfaces as
 * invalid_grant — the test can assert on that.
 *
 *   POST /__control  { "expiresInSec": 1 }   // shorten token lifetime
 *   POST /__control  { "reset": true }
 *   GET  /__control  → issued/refresh tallies + last account id
 */

export interface MockOAuthState {
  /** Lifetime handed back in `expires_in`. Small values force a refresh. */
  expiresInSec: number;
  /** The account id embedded in every minted id_token. */
  accountId: string;
  email: string;
  /** Tallies for assertions. */
  tokenRequests: number;
  codeExchanges: number;
  refreshes: number;
  /** Pending authorize codes → the PKCE challenge they were bound to. */
  codes: Map<string, string>;
  /** Live refresh tokens. A rotated-away token is deleted → reuse fails. */
  refreshTokens: Set<string>;
}

function freshState(): MockOAuthState {
  return {
    expiresInSec: 3600,
    accountId: 'acct_mock_00000000',
    email: 'codex-user@example.com',
    tokenRequests: 0,
    codeExchanges: 0,
    refreshes: 0,
    codes: new Map(),
    refreshTokens: new Set(),
  };
}

export interface MockOAuthHandle {
  server: Server;
  port: number;
  url: string;
  state: MockOAuthState;
  reset(): void;
  close(): Promise<void>;
}

/** Boot the mock OAuth server. Port 0 picks a free one (used by tests). */
export function startMockOAuth(port = 0): Promise<MockOAuthHandle> {
  let state = freshState();
  const reset = () => {
    state = freshState();
  };

  const server = createServer((req, res) => {
    void handle(req, res, state, reset).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'server_error', error_description: String(err) }));
      } else {
        res.end();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        port: actual,
        url: `http://127.0.0.1:${actual}`,
        get state() {
          return state;
        },
        reset,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  state: MockOAuthState,
  reset: () => void,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  /* ── control plane ─────────────────────────────────────────────────── */
  if (path === '/__control') {
    if (req.method === 'GET') {
      return json(res, 200, {
        expiresInSec: state.expiresInSec,
        accountId: state.accountId,
        email: state.email,
        tokenRequests: state.tokenRequests,
        codeExchanges: state.codeExchanges,
        refreshes: state.refreshes,
        liveRefreshTokens: state.refreshTokens.size,
      });
    }
    const parsed = safeJSON(await readBody(req)) as
      | { expiresInSec?: number; accountId?: string; email?: string; reset?: boolean }
      | null;
    if (parsed?.reset) {
      reset();
      return json(res, 200, { ok: true, reset: true });
    }
    if (parsed) {
      if (typeof parsed.expiresInSec === 'number') state.expiresInSec = parsed.expiresInSec;
      if (typeof parsed.accountId === 'string') state.accountId = parsed.accountId;
      if (typeof parsed.email === 'string') state.email = parsed.email;
    }
    return json(res, 200, { ok: true });
  }

  /* ── authorize ─────────────────────────────────────────────────────── */
  if (path === '/oauth/authorize' && req.method === 'GET') {
    const redirectUri = url.searchParams.get('redirect_uri');
    const stateParam = url.searchParams.get('state') ?? '';
    const challenge = url.searchParams.get('code_challenge');
    const method = url.searchParams.get('code_challenge_method');

    if (!redirectUri || !challenge || method !== 'S256') {
      return json(res, 400, { error: 'invalid_request', error_description: 'missing PKCE params' });
    }

    // Mint a one-time code bound to this PKCE challenge, then behave like a
    // user who just approved: 302 straight back to the loopback callback.
    const code = randomBytes(24).toString('base64url');
    state.codes.set(code, challenge);

    const location = new URL(redirectUri);
    location.searchParams.set('code', code);
    if (stateParam) location.searchParams.set('state', stateParam);
    res.writeHead(302, { location: location.toString() });
    res.end();
    return;
  }

  /* ── token ─────────────────────────────────────────────────────────── */
  if (path === '/oauth/token' && req.method === 'POST') {
    state.tokenRequests++;
    const form = new URLSearchParams(await readBody(req));
    const grant = form.get('grant_type');

    if (grant === 'authorization_code') {
      const code = form.get('code') ?? '';
      const verifier = form.get('code_verifier') ?? '';
      const challenge = state.codes.get(code);
      if (!challenge) {
        return tokenError(res, 'invalid_grant', 'unknown or used authorization code');
      }
      state.codes.delete(code); // one-time use
      if (!verifierMatches(verifier, challenge)) {
        return tokenError(res, 'invalid_grant', 'PKCE verifier does not match challenge');
      }
      state.codeExchanges++;
      return issueTokens(res, state);
    }

    if (grant === 'refresh_token') {
      const presented = form.get('refresh_token') ?? '';
      if (!state.refreshTokens.has(presented)) {
        // Either never issued or already rotated away — a dead refresh token.
        return tokenError(res, 'invalid_grant', 'refresh token is invalid or has been rotated');
      }
      state.refreshTokens.delete(presented); // rotate: old token dies now
      state.refreshes++;
      return issueTokens(res, state);
    }

    return tokenError(res, 'unsupported_grant_type', `grant_type ${grant ?? '(none)'} not supported`);
  }

  return json(res, 404, { error: 'not_found', error_description: `${req.method} ${path}` });
}

/* ── token minting ──────────────────────────────────────────────────────── */

function issueTokens(res: ServerResponse, state: MockOAuthState): void {
  const refreshToken = `rt_${randomBytes(18).toString('base64url')}`;
  state.refreshTokens.add(refreshToken);

  const body = {
    access_token: `at_${randomBytes(18).toString('base64url')}`,
    refresh_token: refreshToken,
    id_token: mintIdToken(state.accountId, state.email),
    token_type: 'Bearer',
    expires_in: state.expiresInSec,
    scope: 'openid profile email offline_access api.connectors.read api.connectors.invoke',
  };
  return json(res, 200, body);
}

/**
 * Mint a JWT whose payload carries the account id where the real id_token does:
 * the `https://api.openai.com/auth` claim namespace. The signature is a
 * placeholder — the client decodes, it does not verify (matching the documented
 * follow-up in codex-oauth.ts).
 */
function mintIdToken(accountId: string, email: string): string {
  const header = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      sub: accountId,
      email,
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
      iat: Math.floor(Date.now() / 1000),
    }),
  );
  return `${header}.${payload}.mock-signature`;
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function verifierMatches(verifier: string, challenge: string): boolean {
  if (!verifier) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  return computed === challenge;
}

function tokenError(res: ServerResponse, error: string, description: string): void {
  return json(res, 400, { error, error_description: description });
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeJSON(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
