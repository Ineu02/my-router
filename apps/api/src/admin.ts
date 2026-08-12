import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  HEALTH_RANK,
  HealthStatus,
  generateRouterKey,
  hashSecret,
  maskSecret,
  timingSafeEqual,
  type DashboardStats,
  type HealthSnapshot,
  type ProviderStatusView,
  type RouterEvent,
  type TopologyView,
} from '@router/shared';
import { BUILTIN_PROVIDERS } from '@router/providers';
import { toPublicConfig, type LogFilter } from '@router/config';
import type { RouteDeps } from './routes.js';

/**
 * Admin API — everything the dashboard reads and writes.
 *
 * Guarded by ADMIN_TOKEN, which is a different credential from the
 * `sk-router-…` client keys: a leaked client key can spend tokens but cannot
 * read configuration or change routing.
 *
 * The hard rule for this whole file: **no response ever contains provider key
 * material.** Credentials are exposed as `{ id, label, maskedKey, keyRef }`,
 * where `keyRef` is an env var NAME. Writes accept an env var name too — the
 * dashboard never transports a secret, so there is nothing to intercept.
 */

const SESSION_COOKIE = 'router_admin';

export function registerAdminRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { engine, repos, config } = deps;

  /* ── session ───────────────────────────────────────────────────────── */

  /**
   * Exchange ADMIN_TOKEN for an httpOnly cookie.
   *
   * The cookie holds a hash of the token, not the token — so an XSS that can
   * read `document.cookie` (it can't; httpOnly) still wouldn't yield anything
   * replayable outside this origin.
   */
  app.post('/api/admin/login', async (req, reply) => {
    const body = z.object({ token: z.string().min(1) }).safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'A token is required.' });
    }
    if (!config.adminToken) {
      return reply.code(503).send({
        error: 'ADMIN_TOKEN is not configured on the server. Set it in .env and restart.',
      });
    }
    if (!timingSafeEqual(body.data.token, config.adminToken)) {
      req.log.warn({ ip: req.ip }, 'admin login rejected');
      return reply.code(401).send({ error: 'Invalid admin token.' });
    }

    const session = await hashSecret(`${config.adminToken}:${config.sessionSecret}`);
    reply.setCookie(SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      path: '/',
      maxAge: 60 * 60 * 12,
    });
    return { ok: true };
  });

  app.post('/api/admin/logout', async (_req, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/admin/session', async (req) => ({
    authenticated: await isAuthorized(req, deps),
    adminTokenConfigured: config.adminToken.length > 0,
  }));

  /* ── guard ─────────────────────────────────────────────────────────── */

  app.addHook('preHandler', async (req, reply) => {
    const url = req.url.split('?')[0] ?? '';
    if (!url.startsWith('/api/admin')) return;
    if (url === '/api/admin/login' || url === '/api/admin/logout' || url === '/api/admin/session') {
      return;
    }
    if (await isAuthorized(req, deps)) return;
    return reply.code(401).send({ error: 'Admin authentication required.' });
  });

  /* ── overview ──────────────────────────────────────────────────────── */

  app.get('/api/admin/stats', async () => buildStats(deps));

  app.get('/api/admin/overview', async () => {
    const dayAgo = Date.now() - 86_400_000;
    return {
      stats: buildStats(deps),
      timeline: repos.logs.timeline(dayAgo, 24),
      recent: repos.logs.query({ limit: 12 }).map(publicLog),
      providers: buildProviderViews(deps),
      topology: buildTopology(deps),
    };
  });

  /** Nodes and edges for the 3D scene — derived entirely from live state. */
  app.get('/api/admin/topology', async () => buildTopology(deps));

  /* ── providers ─────────────────────────────────────────────────────── */

  app.get('/api/admin/providers', async () => ({ providers: buildProviderViews(deps) }));

  app.get<{ Params: { id: string } }>('/api/admin/providers/:id', async (req, reply) => {
    const view = buildProviderViews(deps).find((p) => p.id === req.params.id);
    if (!view) return reply.code(404).send({ error: 'Unknown provider.' });
    const provider = repos.providers.get(req.params.id)!;
    return {
      ...view,
      baseUrl: provider.baseUrl,
      credentialEnvHint: provider.credentialEnvHint ?? null,
      models: repos.models.list().filter((m) => m.provider === provider.id),
    };
  });

  const ProviderPatch = z.object({
    displayName: z.string().min(1).optional(),
    baseUrl: z.string().url().optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(100).optional(),
  });

  app.patch<{ Params: { id: string } }>('/api/admin/providers/:id', async (req, reply) => {
    const provider = repos.providers.get(req.params.id);
    if (!provider) return reply.code(404).send({ error: 'Unknown provider.' });

    const patch = ProviderPatch.safeParse(req.body);
    if (!patch.success) return reply.code(400).send({ error: issues(patch.error) });

    const p = patch.data;
    if (p.enabled !== undefined) repos.providers.setEnabled(provider.id, p.enabled);
    if (p.priority !== undefined) repos.providers.setPriority(provider.id, p.priority);
    if (p.displayName !== undefined || p.baseUrl !== undefined) {
      repos.providers.upsert({
        id: provider.id,
        displayName: p.displayName ?? provider.displayName,
        kind: provider.kind,
        baseUrl: p.baseUrl ?? provider.baseUrl,
        enabled: p.enabled ?? provider.enabled,
        priority: p.priority ?? provider.priority,
        credentialEnvHint: provider.credentialEnvHint,
        extraHeaders: repos.providers.extraHeaders(provider.id),
      });
    }
    return { ok: true, provider: repos.providers.get(provider.id) };
  });

  app.post<{ Params: { id: string } }>('/api/admin/providers/:id/test', async (req, reply) => {
    const creds = repos.credentials.listByProvider(req.params.id);
    if (creds.length === 0) {
      return reply.code(400).send({
        error: 'No credentials are registered for this provider. Add one to its env var and restart.',
      });
    }
    const results = await Promise.all(
      creds.map(async (c) => ({
        credentialId: c.id,
        label: c.label,
        ...(await engine.testCredential(c.id)),
      })),
    );
    return { results };
  });

  /** The catalogue of providers the router knows how to speak to. */
  app.get('/api/admin/provider-catalog', async () => ({
    providers: BUILTIN_PROVIDERS.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      kind: p.kind,
      defaultBaseUrl: p.defaultBaseUrl,
      envKey: p.envKey,
      envBaseUrl: p.envBaseUrl ?? null,
      models: p.models.map((m) => ({ id: m.id, model: m.model, displayName: m.displayName })),
      // Whether the operator has actually supplied this key.
      configured: repos.credentials.listByProvider(p.id).length > 0,
    })),
  }));

  /* ── credentials ───────────────────────────────────────────────────── */

  app.get('/api/admin/credentials', async () => ({
    credentials: repos.credentials.list().map((c) => publicCredential(c, engine)),
  }));

  app.patch<{ Params: { id: string } }>('/api/admin/credentials/:id', async (req, reply) => {
    const cred = repos.credentials.get(req.params.id);
    if (!cred) return reply.code(404).send({ error: 'Unknown credential.' });

    const patch = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!patch.success) return reply.code(400).send({ error: issues(patch.error) });

    repos.credentials.setEnabled(cred.id, patch.data.enabled);
    engine.health.setEnabled(cred.id, cred.providerId, patch.data.enabled, Date.now());
    engine.persistHealth();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/credentials/:id/test', async (req, reply) => {
    const cred = repos.credentials.get(req.params.id);
    if (!cred) return reply.code(404).send({ error: 'Unknown credential.' });
    return engine.testCredential(cred.id);
  });

  /* ── models ────────────────────────────────────────────────────────── */

  app.get('/api/admin/models', async () => {
    const usage = new Map(repos.logs.providerStats().map((s) => [s.provider, s]));
    return {
      models: repos.models.list().map((m) => ({
        ...m,
        providerEnabled: repos.providers.get(m.provider)?.enabled ?? false,
        providerRequests: usage.get(m.provider)?.requests ?? 0,
      })),
    };
  });

  const ModelPatch = z.object({
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(100).optional(),
    displayName: z.string().min(1).optional(),
    contextLength: z.number().int().positive().optional(),
    costTier: z.enum(['free', 'cheap', 'standard', 'premium']).optional(),
    capabilities: z.array(z.string()).optional(),
  });

  app.patch<{ Params: { id: string } }>('/api/admin/models/:id', async (req, reply) => {
    const model = repos.models.get(req.params.id);
    if (!model) return reply.code(404).send({ error: 'Unknown model.' });

    const patch = ModelPatch.safeParse(req.body);
    if (!patch.success) return reply.code(400).send({ error: issues(patch.error) });

    const p = patch.data;
    repos.models.upsert({
      id: model.id,
      provider: model.provider,
      model: model.model,
      displayName: p.displayName ?? model.displayName,
      capabilities: p.capabilities ?? model.capabilities,
      contextLength: p.contextLength ?? model.contextLength,
      maxOutputTokens: model.maxOutputTokens,
      enabled: p.enabled ?? model.enabled,
      priority: p.priority ?? model.priority,
      costTier: p.costTier ?? model.costTier,
    });
    if (p.enabled !== undefined) repos.models.setEnabled(model.id, p.enabled);
    return { ok: true, model: repos.models.get(model.id) };
  });

  const ModelCreate = z.object({
    id: z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/i, 'ids may contain letters, digits, . _ -'),
    provider: z.string().min(1),
    model: z.string().min(1),
    displayName: z.string().min(1),
    capabilities: z.array(z.string()).default(['chat']),
    contextLength: z.number().int().positive().default(128_000),
    priority: z.number().int().min(0).max(100).default(50),
    costTier: z.enum(['free', 'cheap', 'standard', 'premium']).default('standard'),
  });

  app.post('/api/admin/models', async (req, reply) => {
    const parsed = ModelCreate.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: issues(parsed.error) });
    if (!repos.providers.get(parsed.data.provider)) {
      return reply.code(400).send({ error: `Unknown provider '${parsed.data.provider}'.` });
    }
    if (repos.models.get(parsed.data.id)) {
      return reply.code(409).send({ error: `Model id '${parsed.data.id}' already exists.` });
    }
    return { ok: true, model: repos.models.upsert(parsed.data) };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/models/:id', async (req, reply) => {
    const model = repos.models.get(req.params.id);
    if (!model) return reply.code(404).send({ error: 'Unknown model.' });

    // Deleting a model that a profile still references would leave a dangling
    // ladder entry, so clean the references up in the same operation.
    for (const profile of repos.profiles.list()) {
      if (profile.models.includes(model.id)) {
        repos.profiles.setModels(
          profile.id,
          profile.models.filter((m) => m !== model.id),
        );
      }
    }
    repos.models.delete(model.id);
    return { ok: true };
  });

  /* ── profiles (the routing editor) ─────────────────────────────────── */

  app.get('/api/admin/profiles', async () => {
    const models = new Map(repos.models.list().map((m) => [m.id, m]));
    return {
      profiles: repos.profiles.list().map((p) => ({
        ...p,
        // Resolve the ladder so the editor can render it without a second call.
        ladder: p.models.map((id) => {
          const m = models.get(id);
          return m
            ? {
                id: m.id,
                provider: m.provider,
                model: m.model,
                displayName: m.displayName,
                enabled: m.enabled,
                missing: false,
              }
            : { id, provider: null, model: id, displayName: id, enabled: false, missing: true };
        }),
      })),
      availableModels: repos.models.list().map((m) => ({
        id: m.id,
        provider: m.provider,
        model: m.model,
        displayName: m.displayName,
        enabled: m.enabled,
        capabilities: m.capabilities,
      })),
      defaultProfile: repos.settings.get('default_profile') ?? config.defaultProfile,
    };
  });

  const ProfilePatch = z.object({
    models: z.array(z.string()).optional(),
    displayName: z.string().min(1).optional(),
    description: z.string().optional(),
    enabled: z.boolean().optional(),
  });

  app.patch<{ Params: { id: string } }>('/api/admin/profiles/:id', async (req, reply) => {
    const profile = repos.profiles.get(req.params.id);
    if (!profile) return reply.code(404).send({ error: 'Unknown profile.' });

    const patch = ProfilePatch.safeParse(req.body);
    if (!patch.success) return reply.code(400).send({ error: issues(patch.error) });

    const p = patch.data;
    if (p.models) {
      // Reject unknown ids outright: a silently-dropped entry in a reorder
      // would look like the drag didn't take.
      const known = new Set(repos.models.list().map((m) => m.id));
      const unknown = p.models.filter((m) => !known.has(m));
      if (unknown.length > 0) {
        return reply.code(400).send({ error: `Unknown model ids: ${unknown.join(', ')}` });
      }
    }

    repos.profiles.upsert({
      id: profile.id,
      displayName: p.displayName ?? profile.displayName,
      description: p.description ?? profile.description,
      models: p.models ?? profile.models,
      enabled: p.enabled ?? profile.enabled,
    });
    return { ok: true, profile: repos.profiles.get(profile.id) };
  });

  const ProfileCreate = z.object({
    id: z.string().min(1).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes only'),
    displayName: z.string().min(1),
    description: z.string().default(''),
    models: z.array(z.string()).default([]),
  });

  app.post('/api/admin/profiles', async (req, reply) => {
    const parsed = ProfileCreate.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: issues(parsed.error) });
    if (repos.profiles.get(parsed.data.id)) {
      return reply.code(409).send({ error: `Profile '${parsed.data.id}' already exists.` });
    }
    return { ok: true, profile: repos.profiles.upsert(parsed.data) };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/profiles/:id', async (req, reply) => {
    const profile = repos.profiles.get(req.params.id);
    if (!profile) return reply.code(404).send({ error: 'Unknown profile.' });

    const current = repos.settings.get('default_profile') ?? config.defaultProfile;
    if (profile.id === current || profile.id === 'auto') {
      return reply.code(400).send({
        error: `'${profile.id}' is in use as the default route. Point the default elsewhere first.`,
      });
    }
    repos.profiles.delete(profile.id);
    return { ok: true };
  });

  /* ── router API keys ───────────────────────────────────────────────── */

  app.get('/api/admin/keys', async () => ({
    // keyHash is deliberately dropped: it is not secret, but publishing it
    // invites offline guessing against a known target.
    keys: repos.routerKeys.list().map(({ keyHash: _h, ...k }) => k),
  }));

  app.post('/api/admin/keys', async (req, reply) => {
    const parsed = z
      .object({
        name: z.string().min(1).max(80),
        usageLimit: z.number().int().positive().nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: issues(parsed.error) });

    const key = generateRouterKey();
    const record = repos.routerKeys.create({
      name: parsed.data.name,
      keyHash: await hashSecret(key),
      keyPrefix: key.slice(0, 12),
      maskedKey: maskSecret(key),
      usageLimit: parsed.data.usageLimit ?? null,
    });

    const { keyHash: _h, ...safe } = record;
    // The only response in the entire admin API that contains a live secret,
    // and only because the operator just created it and cannot retrieve it
    // again. Nothing stores the plaintext.
    return reply.code(201).send({ ok: true, key: safe, plaintext: key });
  });

  app.patch<{ Params: { id: string } }>('/api/admin/keys/:id', async (req, reply) => {
    const key = repos.routerKeys.get(req.params.id);
    if (!key) return reply.code(404).send({ error: 'Unknown key.' });

    const patch = z
      .object({
        enabled: z.boolean().optional(),
        // Explicit null removes the cap; omitted leaves it as it is. Those are
        // different intents, so `.nullable().optional()` rather than one or the
        // other.
        usageLimit: z.number().int().positive().nullable().optional(),
      })
      .refine((p) => p.enabled !== undefined || p.usageLimit !== undefined, {
        message: 'Nothing to change: send `enabled` and/or `usageLimit`.',
      })
      .safeParse(req.body);
    if (!patch.success) return reply.code(400).send({ error: issues(patch.error) });

    if (patch.data.enabled !== undefined) repos.routerKeys.setEnabled(key.id, patch.data.enabled);
    if (patch.data.usageLimit !== undefined) repos.routerKeys.setLimit(key.id, patch.data.usageLimit);

    const { keyHash: _h, ...safe } = repos.routerKeys.get(key.id)!;
    return { ok: true, key: safe };
  });

  app.post<{ Params: { id: string } }>('/api/admin/keys/:id/revoke', async (req, reply) => {
    const key = repos.routerKeys.get(req.params.id);
    if (!key) return reply.code(404).send({ error: 'Unknown key.' });
    repos.routerKeys.revoke(key.id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/keys/:id', async (req, reply) => {
    const key = repos.routerKeys.get(req.params.id);
    if (!key) return reply.code(404).send({ error: 'Unknown key.' });
    repos.routerKeys.delete(key.id);
    return { ok: true };
  });

  /* ── request logs ──────────────────────────────────────────────────── */

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/admin/logs', async (req) => {
    const q = req.query;
    const filter: LogFilter = {
      provider: q.provider || undefined,
      model: q.model || undefined,
      status: q.status === 'success' || q.status === 'error' ? q.status : undefined,
      requestId: q.requestId || undefined,
      since: q.since ? Number(q.since) : undefined,
      until: q.until ? Number(q.until) : undefined,
      limit: q.limit ? Math.min(Number(q.limit), 500) : 100,
      offset: q.offset ? Number(q.offset) : 0,
    };
    return {
      logs: repos.logs.query(filter).map(publicLog),
      total: repos.logs.count(filter),
      filter,
    };
  });

  app.get<{ Params: { id: string } }>('/api/admin/logs/:id', async (req, reply) => {
    const log = repos.logs.query({ requestId: req.params.id, limit: 1 })[0];
    if (!log) return reply.code(404).send({ error: 'Unknown request id.' });
    return publicLog(log);
  });

  app.delete('/api/admin/logs', async () => {
    repos.logs.clear();
    return { ok: true };
  });

  /* ── settings ──────────────────────────────────────────────────────── */

  app.get('/api/admin/settings', async () => ({
    // toPublicConfig structurally omits every secret — see env.ts.
    config: toPublicConfig(config),
    overrides: repos.settings.all(),
    health: engine.health.getConfig(),
    // The writable tunables, with their effective value, where that value came
    // from, and the bounds the PATCH enforces. The dashboard renders its form
    // from this rather than duplicating the limits client-side.
    tunables: [
      tunable('request_timeout_ms', config.requestTimeoutMs, 1_000, 600_000, 'ms',
        'Per-attempt upstream budget. A hung provider is abandoned after this.'),
      tunable('global_deadline_ms', config.globalDeadlineMs, 1_000, 900_000, 'ms',
        'Ceiling for the whole fallback ladder, retries included.'),
      tunable('max_fallback_attempts', config.maxFallbackAttempts, 1, 10, 'attempts',
        'How many upstreams one request may try before returning 503.'),
      tunable('retry_network_errors', config.retryNetworkErrors, 0, 5, 'retries',
        'Extra tries on the same credential for transient network faults.'),
    ],
    // Which secrets exist, never what they are.
    credentialSources: repos.credentials.list().map((c) => ({
      providerId: c.providerId,
      keyRef: c.keyRef,
      maskedKey: c.maskedKey,
      enabled: c.enabled,
    })),
  }));

  function tunable(
    key: string,
    envDefault: number,
    min: number,
    max: number,
    unit: string,
    description: string,
  ) {
    const override = repos.settings.get(key);
    return {
      key,
      value: override === null ? envDefault : Number(override),
      envDefault,
      source: override === null ? ('env' as const) : ('override' as const),
      min,
      max,
      unit,
      description,
    };
  }

  /**
   * Runtime-tunable settings.
   *
   * Each key shadows the matching env default and takes effect on the next
   * request — no restart. Bounds are enforced here rather than trusted from the
   * client, because a zero or negative timeout would wedge the request path.
   * Anything absent from this schema stays env-only by design (ports, database
   * path, and every secret).
   */
  const SettingsPatch = z.object({
    default_profile: z.string().min(1).optional(),
    rotation_strategy: z
      .enum(['priority', 'round-robin', 'least-failures', 'health-based', 'weighted'])
      .optional(),
    /** Per-attempt upstream budget. Long generations legitimately need minutes. */
    request_timeout_ms: z.number().int().min(1_000).max(600_000).optional(),
    /** Wall-clock ceiling for the whole ladder, retries included. */
    global_deadline_ms: z.number().int().min(1_000).max(900_000).optional(),
    /** How many upstreams one request may try before giving up. */
    max_fallback_attempts: z.number().int().min(1).max(10).optional(),
    /** Extra tries on the SAME credential for transient network faults. */
    retry_network_errors: z.number().int().min(0).max(5).optional(),
  });

  const NUMERIC_SETTINGS = [
    'request_timeout_ms',
    'global_deadline_ms',
    'max_fallback_attempts',
    'retry_network_errors',
  ] as const;

  app.patch('/api/admin/settings', async (req, reply) => {
    const patch = SettingsPatch.safeParse(req.body);
    if (!patch.success) return reply.code(400).send({ error: issues(patch.error) });

    if (patch.data.default_profile) {
      if (!repos.profiles.get(patch.data.default_profile)) {
        return reply.code(400).send({ error: `Unknown profile '${patch.data.default_profile}'.` });
      }
      repos.settings.set('default_profile', patch.data.default_profile);
    }
    if (patch.data.rotation_strategy) {
      repos.settings.set('rotation_strategy', patch.data.rotation_strategy);
    }
    for (const key of NUMERIC_SETTINGS) {
      const value = patch.data[key];
      if (value !== undefined) repos.settings.set(key, String(value));
    }

    if (patch.data.global_deadline_ms !== undefined || patch.data.request_timeout_ms !== undefined) {
      // A per-attempt budget above the global deadline is not an error — the
      // ladder clamps each attempt to the remaining deadline — but it does mean
      // the second number is the one doing the work, so say so.
      const attempt = Number(repos.settings.get('request_timeout_ms') ?? config.requestTimeoutMs);
      const deadline = Number(repos.settings.get('global_deadline_ms') ?? config.globalDeadlineMs);
      if (attempt > deadline) {
        return {
          ok: true,
          overrides: repos.settings.all(),
          warning:
            `request_timeout_ms (${attempt}ms) exceeds global_deadline_ms (${deadline}ms); ` +
            'attempts will be clamped to the remaining deadline.',
        };
      }
    }

    return { ok: true, overrides: repos.settings.all() };
  });

  /** Drop an override and fall back to the env default. */
  app.delete('/api/admin/settings/:key', async (req, reply) => {
    const { key } = req.params as { key: string };
    const allowed: string[] = ['default_profile', 'rotation_strategy', ...NUMERIC_SETTINGS];
    if (!allowed.includes(key)) {
      return reply.code(400).send({ error: `Setting '${key}' is not operator-writable.` });
    }
    repos.settings.remove(key);
    return { ok: true, overrides: repos.settings.all() };
  });

  /* ── health ────────────────────────────────────────────────────────── */

  app.get('/api/admin/health', async () => {
    const creds = new Map(repos.credentials.list().map((c) => [c.id, c]));
    return {
      states: engine.health.snapshots().map((s) => ({
        ...s,
        label: creds.get(s.credentialId)?.label ?? s.credentialId,
        maskedKey: creds.get(s.credentialId)?.maskedKey ?? '—',
      })),
    };
  });

  app.post('/api/admin/health/probe', async () => {
    await engine.runProbes();
    return { ok: true, states: engine.health.snapshots() };
  });

  /**
   * Clear every tracked cooldown and failure counter.
   *
   * An operator escape hatch for when a provider is known to be back before
   * its backoff expires — and what the live verification script uses to give
   * each case a clean slate. It only forgets health history; it never touches
   * credentials, models, or routing.
   */
  app.post('/api/admin/health/reset', async () => {
    engine.health.reset();
    repos.health.clear();
    return { ok: true, states: engine.health.snapshots() };
  });

  /* ── live events ───────────────────────────────────────────────────── */

  /**
   * SSE feed driving the live dashboard and the 3D topology.
   *
   * One-way server→client, so no WebSocket upgrade and reconnection comes for
   * free from EventSource.
   */
  app.get('/api/admin/events', async (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const send = (event: RouterEvent | { type: 'hello'; at: number }) => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    };

    send({ type: 'hello', at: Date.now() });
    const unsubscribe = engine.onEvent(send);

    // Periodic stats keep the KPI tiles live without the client polling, and
    // double as the keep-alive that stops proxies closing an idle stream.
    const stats = setInterval(() => {
      send({ type: 'stats', stats: buildStats(deps), at: Date.now() });
    }, 5_000);
    stats.unref?.();

    const close = () => {
      clearInterval(stats);
      unsubscribe();
      if (!reply.raw.writableEnded) reply.raw.end();
    };
    req.raw.on('close', close);
    req.raw.on('error', close);
  });
}

/* ── authorization ─────────────────────────────────────────────────────── */

async function isAuthorized(req: FastifyRequest, deps: RouteDeps): Promise<boolean> {
  const { config } = deps;
  // An unset ADMIN_TOKEN means the admin API is closed, not open.
  if (!config.adminToken) return false;

  const header = req.headers['x-router-admin-token'];
  if (typeof header === 'string' && timingSafeEqual(header, config.adminToken)) return true;

  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (bearer && timingSafeEqual(bearer, config.adminToken)) return true;

  const cookie = req.cookies?.[SESSION_COOKIE];
  if (cookie) {
    const expected = await hashSecret(`${config.adminToken}:${config.sessionSecret}`);
    if (timingSafeEqual(cookie, expected)) return true;
  }
  return false;
}

/* ── projections ───────────────────────────────────────────────────────── */

function buildStats(deps: RouteDeps): DashboardStats {
  const { repos, engine, config } = deps;
  const all = repos.logs.stats();
  const day = repos.logs.stats(Date.now() - 86_400_000);
  const providers = repos.providers.list();
  const now = Date.now();

  const activeProviders = providers.filter((p) => {
    if (!p.enabled) return false;
    return repos.credentials
      .listByProvider(p.id)
      .some((c) => c.enabled && engine.health.isAvailable(c.id, now));
  }).length;

  return {
    totalRequests: all.total,
    successRate: all.total === 0 ? 1 : all.successes / all.total,
    activeProviders,
    totalProviders: providers.length,
    avgLatencyMs: all.avgLatency,
    failoverEvents: all.failovers,
    currentProfile: repos.settings.get('default_profile') ?? config.defaultProfile,
    requestsLast24h: day.total,
    streamingRequests: all.streamed,
    totalTokens: all.totalTokens,
  };
}

function buildProviderViews(deps: RouteDeps): ProviderStatusView[] {
  const { repos, engine } = deps;
  const stats = new Map(repos.logs.providerStats().map((s) => [s.provider, s]));
  const models = repos.models.list();

  return repos.providers.list().map((p) => {
    const creds = repos.credentials.listByProvider(p.id);
    const snapshots = creds
      .map((c) => engine.health.snapshot(c.id))
      .filter((s): s is HealthSnapshot => s !== null);
    const stat = stats.get(p.id);

    // A provider is as healthy as its healthiest credential — one exhausted
    // account shouldn't paint the whole provider red.
    let status: HealthStatus = p.enabled ? HealthStatus.OFFLINE : HealthStatus.DISABLED;
    if (p.enabled) {
      for (const s of snapshots) {
        if (HEALTH_RANK[s.status] < HEALTH_RANK[status]) status = s.status;
      }
      if (snapshots.length === 0) status = HealthStatus.OFFLINE;
    }

    const latencies = snapshots.filter((s) => s.avgLatencyMs > 0).map((s) => s.avgLatencyMs);

    return {
      id: p.id,
      displayName: p.displayName,
      kind: p.kind,
      enabled: p.enabled,
      priority: p.priority,
      status,
      modelCount: models.filter((m) => m.provider === p.id).length,
      credentialCount: creds.length,
      avgLatencyMs:
        latencies.length > 0
          ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
          : (stat?.avgLatency ?? 0),
      successRate:
        stat && stat.requests > 0
          ? stat.successes / stat.requests
          : snapshots.length > 0
            ? snapshots.reduce((a, s) => a + s.successRate, 0) / snapshots.length
            : 1,
      totalRequests: stat?.requests ?? 0,
      totalFailures: stat?.failures ?? 0,
      lastSuccessAt: snapshots.reduce<number | null>(
        (acc, s) => (s.lastSuccessAt && (!acc || s.lastSuccessAt > acc) ? s.lastSuccessAt : acc),
        null,
      ),
      credentials: creds.map((c) => ({
        id: c.id,
        label: c.label,
        maskedKey: c.maskedKey, // display-only, computed at seed time
        enabled: c.enabled,
        health: engine.health.snapshot(c.id),
      })),
    };
  });
}

/**
 * The graph the 3D scene renders: CLIENT → ROUTER → PROVIDERS.
 *
 * Every visual property has a data source — node colour is `status`, size is
 * `priority`, ring is `latencyMs`, edge weight is `share` of recent traffic.
 * Nothing in the scene is decorative.
 */
function buildTopology(deps: RouteDeps): TopologyView {
  const { repos, config } = deps;
  const views = buildProviderViews(deps);
  const stats = repos.logs.providerStats();
  const totalRequests = stats.reduce((a, s) => a + s.requests, 0);
  const activeProfileId = repos.settings.get('default_profile') ?? config.defaultProfile;
  const activeProfile = repos.profiles.get(activeProfileId);
  const models = new Map(repos.models.list().map((m) => [m.id, m]));

  // Ladder position drives edge ordering in the scene, so the visual reflects
  // the actual failover order rather than an arbitrary layout.
  const ladderRank = new Map<string, number>();
  activeProfile?.models.forEach((modelId, i) => {
    const providerId = models.get(modelId)?.provider;
    if (providerId && !ladderRank.has(providerId)) ladderRank.set(providerId, i);
  });

  return {
    router: {
      id: 'router',
      profile: activeProfileId,
      totalRequests,
      providers: views.length,
    },
    nodes: views.map((v) => ({
      id: v.id,
      label: v.displayName,
      status: v.status,
      enabled: v.enabled,
      priority: v.priority,
      latencyMs: v.avgLatencyMs,
      successRate: v.successRate,
      requests: v.totalRequests,
      credentials: v.credentialCount,
      models: v.modelCount,
      ladderRank: ladderRank.get(v.id) ?? null,
    })),
    edges: views.map((v) => ({
      from: 'router',
      to: v.id,
      share: totalRequests === 0 ? 0 : v.totalRequests / totalRequests,
      active: v.enabled && v.status !== HealthStatus.OFFLINE && v.status !== HealthStatus.DISABLED,
      rank: ladderRank.get(v.id) ?? null,
    })),
  };
}

function publicCredential(
  c: { id: string; providerId: string; label: string; keyRef: string; maskedKey: string; enabled: boolean; priority: number; weight: number },
  engine: RouteDeps['engine'],
) {
  return {
    id: c.id,
    providerId: c.providerId,
    label: c.label,
    // An env var NAME, not a value. Safe to display; useless to an attacker.
    keyRef: c.keyRef,
    maskedKey: c.maskedKey,
    enabled: c.enabled,
    priority: c.priority,
    weight: c.weight,
    health: engine.health.snapshot(c.id),
  };
}

/** Parse the stored attempt trail so the log row expands without client work. */
function publicLog(l: {
  id: string;
  requestId: string;
  timestamp: number;
  requestedModel: string;
  resolvedProfile: string | null;
  selectedProvider: string | null;
  selectedModel: string | null;
  status: string;
  httpStatus: number;
  latencyMs: number;
  fallbackCount: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  streamed: boolean;
  errorClass: string | null;
  errorMessage: string | null;
  attempts: string;
  apiKeyId: string | null;
}) {
  let attempts: unknown[] = [];
  try {
    attempts = JSON.parse(l.attempts) as unknown[];
  } catch {
    /* a malformed trail must not break the log view */
  }
  // clientIp is intentionally not projected — the dashboard has no use for it
  // and it is the one field here with privacy weight.
  return { ...l, attempts };
}

function issues(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
}

export { buildStats, buildProviderViews, buildTopology };
