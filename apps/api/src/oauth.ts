import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  exchangeCode,
  resolveEndpoints,
  OAuthError,
  type OAuthEndpoints,
  type StoredTokenSet,
} from '@router/router-core';
import { CODEX_PROVIDER_ID } from '@router/config';
import { EncryptingOAuthStore } from './oauth-store.js';
import type { RouteDeps } from './routes.js';

/**
 * Codex / ChatGPT OAuth lifecycle routes (Authorization Code + PKCE).
 *
 * Three admin-guarded endpoints plus one loopback callback:
 *
 *   POST /api/admin/providers/codex/connect            → start a flow, get URL
 *   GET  /auth/callback                                → browser lands here
 *   GET  /api/admin/providers/codex/accounts           → list (masked + status)
 *   POST /api/admin/providers/codex/accounts/:id/disconnect
 *
 * The connect/list/disconnect endpoints sit under `/api/admin` and are covered
 * by the admin-token guard in admin.ts. The callback is deliberately NOT under
 * `/api/admin` (the browser redirect carries no admin cookie), so it protects
 * itself with the single-use `state` value minted at connect time.
 *
 * Security invariants for this whole file:
 *  - No response ever contains an access/refresh/id token. Accounts are exposed
 *    as { accountId, email, maskedKey, status } only.
 *  - Tokens are persisted through {@link EncryptingOAuthStore}, i.e. encrypted
 *    at rest; the plaintext never touches the DB layer.
 *  - `state` is single-use and time-boxed, defeating CSRF on the callback.
 */

const STATE_TTL_MS = 10 * 60_000; // a pending authorize is good for 10 minutes

interface PendingAuth {
  verifier: string;
  createdAt: number;
}

export function registerOAuthRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { engine, repos, config } = deps;

  // Registered only when OAuth is configured. With it off, none of these routes
  // exist and the provider simply has no way to gain credentials — which is the
  // correct closed-by-default posture.
  if (!config.codexOAuth) return;

  const oauth = config.codexOAuth;
  const endpoints: OAuthEndpoints = resolveEndpoints({
    issuer: oauth.issuer,
    clientId: oauth.clientId,
    redirectUri: oauth.redirectUri,
  });
  const store = new EncryptingOAuthStore(repos, config.credentialEncKey);

  // Pending flows keyed by `state`. In-memory and per-instance: a pending
  // authorize is meaningless across a restart (the browser tab is gone), so
  // there is nothing to persist.
  const pending = new Map<string, PendingAuth>();

  const prunePending = (now: number) => {
    for (const [state, p] of pending) {
      if (now - p.createdAt > STATE_TTL_MS) pending.delete(state);
    }
  };

  /* ── connect: mint PKCE + state, hand back the authorize URL ─────────── */

  app.post('/api/admin/providers/codex/connect', async () => {
    const now = Date.now();
    prunePending(now);

    const pkce = generatePkce();
    const state = generateState();
    pending.set(state, { verifier: pkce.verifier, createdAt: now });

    const authorizeUrl = buildAuthorizeUrl(endpoints, { challenge: pkce.challenge, state });
    // The operator opens this URL; the browser returns to /auth/callback.
    return { ok: true, authorizeUrl, state };
  });

  /* ── callback: exchange the code, persist encrypted tokens ───────────── */

  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/auth/callback',
    async (req, reply) => {
      const q = req.query;

      // An OAuth error came back instead of a code (user declined, etc.).
      if (q.error) {
        return page(reply, 400, 'Authorization failed', q.error_description || q.error);
      }

      const parsed = z
        .object({ code: z.string().min(1), state: z.string().min(1) })
        .safeParse({ code: q.code, state: q.state });
      if (!parsed.success) {
        return page(reply, 400, 'Invalid callback', 'Missing authorization code or state.');
      }

      const now = Date.now();
      prunePending(now);
      const flow = pending.get(parsed.data.state);
      if (!flow) {
        // Unknown/expired/replayed state — the CSRF guard doing its job.
        return page(reply, 400, 'Invalid or expired request', 'Start the connection again.');
      }
      pending.delete(parsed.data.state); // single use

      let tokens;
      try {
        tokens = await exchangeCode(endpoints, {
          code: parsed.data.code,
          verifier: flow.verifier,
        });
      } catch (err) {
        const msg =
          err instanceof OAuthError ? err.message : 'Token exchange failed unexpectedly.';
        req.log.warn({ kind: (err as OAuthError).kind }, 'codex token exchange failed');
        return page(reply, 502, 'Could not complete sign-in', msg);
      }

      const accountId = tokens.accountId ?? `codex-${Date.now().toString(36)}`;
      const label = tokens.email ?? accountId;

      // One credential per account. `keyRef` namespaces on the account id so a
      // reconnect of the same account updates in place rather than duplicating
      // (credentials dedupe on providerId + keyRef).
      const cred = repos.credentials.upsert({
        providerId: CODEX_PROVIDER_ID,
        label,
        keyRef: `oauth:${accountId}`,
        rawKeyForMask: `chatgpt:${accountId}`,
        secretKind: 'oauth',
        priority: 75,
      });

      const stored: StoredTokenSet = {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        idToken: tokens.idToken || null,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope ?? null,
        accountId: tokens.accountId,
        email: tokens.email,
      };
      store.save(cred.id, stored);

      repos.credentials.setEnabled(cred.id, true);
      engine.health.ensure(cred.id, CODEX_PROVIDER_ID);
      engine.persistHealth();

      return page(
        reply,
        200,
        'Connected',
        `${label} is now connected. You can close this tab and return to the dashboard.`,
      );
    },
  );

  /* ── list: masked accounts + status (never tokens) ───────────────────── */

  app.get('/api/admin/providers/codex/accounts', async () => {
    const creds = repos.credentials
      .listByProvider(CODEX_PROVIDER_ID)
      .filter((c) => c.secretKind === 'oauth');

    return {
      accounts: creds.map((c) => {
        const row = repos.oauth.get(c.id);
        return {
          credentialId: c.id,
          accountId: row?.accountId ?? null,
          email: row?.email ?? null,
          label: c.label,
          maskedKey: c.maskedKey,
          enabled: c.enabled,
          scope: row?.scope ?? null,
          // A hint at token freshness without ever revealing the token itself.
          expiresAt: row?.expiresAt ?? null,
          expired: row ? Date.now() >= row.expiresAt : true,
          health: engine.health.snapshot(c.id),
        };
      }),
    };
  });

  /* ── disconnect: drop the account and its tokens ─────────────────────── */

  app.post<{ Params: { id: string } }>(
    '/api/admin/providers/codex/accounts/:id/disconnect',
    async (req, reply) => {
      const cred = repos.credentials.get(req.params.id);
      if (!cred || cred.providerId !== CODEX_PROVIDER_ID || cred.secretKind !== 'oauth') {
        return reply.code(404).send({ error: 'Unknown Codex account.' });
      }

      // Tokens first, then the credential row: never leave orphaned secrets.
      repos.oauth.delete(cred.id);
      repos.credentials.delete(cred.id);
      engine.health.setEnabled(cred.id, cred.providerId, false, Date.now());
      engine.persistHealth();

      return { ok: true };
    },
  );
}

/* ── helpers ──────────────────────────────────────────────────────────── */

/**
 * A minimal HTML landing page for the browser that lands on the callback. Plain
 * text would work, but the operator sees this in a real tab, so give it a shape.
 */
function page(reply: FastifyReply, status: number, title: string, detail: string): FastifyReply {
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch,
  );
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;color:#e6e6e6;background:#0e1116}
h1{font-size:1.4rem;margin:0 0 .5rem}p{color:#9aa4b2}</style></head>
<body><h1>${esc(title)}</h1><p>${esc(detail)}</p></body></html>`;
  return reply.code(status).type('text/html; charset=utf-8').send(body);
}
