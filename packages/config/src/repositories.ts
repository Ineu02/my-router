import {
  generateId,
  maskSecret,
  type CredentialEntry,
  type HealthState,
  type ModelEntry,
  type ProviderEntry,
  type ProviderKind,
  type RequestLogEntry,
  type RouterApiKey,
  type RoutingProfile,
  type Capability,
  type CostTier,
  type HealthStatus,
} from '@router/shared';
import type { DB } from './db.js';

/**
 * Repositories — the whole data layer's public surface.
 *
 * Callers never see SQL. Swapping SQLite for Postgres means reimplementing
 * these classes against a different driver; no route or engine code changes.
 */

/* ── providers ───────────────────────────────────────────────────────── */

export class ProviderRepo {
  constructor(private db: DB) {}

  list(): ProviderEntry[] {
    return this.db
      .prepare('SELECT * FROM providers ORDER BY priority DESC, id ASC')
      .all()
      .map(rowToProvider);
  }

  get(id: string): ProviderEntry | null {
    const row = this.db.prepare('SELECT * FROM providers WHERE id = ?').get(id);
    return row ? rowToProvider(row) : null;
  }

  upsert(p: {
    id: string;
    displayName: string;
    kind: ProviderKind;
    baseUrl: string;
    enabled?: boolean;
    priority?: number;
    credentialEnvHint?: string;
    extraHeaders?: Record<string, string>;
  }): ProviderEntry {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO providers (id, display_name, kind, base_url, enabled, priority, credential_env_hint, extra_headers, created_at, updated_at)
         VALUES (@id, @displayName, @kind, @baseUrl, @enabled, @priority, @hint, @headers, @now, @now)
         ON CONFLICT(id) DO UPDATE SET
           display_name = @displayName,
           kind         = @kind,
           base_url     = @baseUrl,
           priority     = @priority,
           credential_env_hint = @hint,
           extra_headers = @headers,
           updated_at   = @now`,
      )
      .run({
        id: p.id,
        displayName: p.displayName,
        kind: p.kind,
        baseUrl: p.baseUrl,
        enabled: p.enabled === false ? 0 : 1,
        priority: p.priority ?? 50,
        hint: p.credentialEnvHint ?? null,
        headers: p.extraHeaders ? JSON.stringify(p.extraHeaders) : null,
        now,
      });
    return this.get(p.id)!;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare('UPDATE providers SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, Date.now(), id);
  }

  setPriority(id: string, priority: number): void {
    this.db
      .prepare('UPDATE providers SET priority = ?, updated_at = ? WHERE id = ?')
      .run(priority, Date.now(), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM providers WHERE id = ?').run(id);
  }

  extraHeaders(id: string): Record<string, string> | undefined {
    const row = this.db.prepare('SELECT extra_headers FROM providers WHERE id = ?').get(id) as
      | { extra_headers: string | null }
      | undefined;
    if (!row?.extra_headers) return undefined;
    try {
      return JSON.parse(row.extra_headers) as Record<string, string>;
    } catch {
      return undefined;
    }
  }
}

/* ── credentials ─────────────────────────────────────────────────────── */

export class CredentialRepo {
  constructor(private db: DB) {}

  list(): CredentialEntry[] {
    return this.db
      .prepare('SELECT * FROM credentials ORDER BY provider_id, priority DESC')
      .all()
      .map(rowToCredential);
  }

  listByProvider(providerId: string): CredentialEntry[] {
    return this.db
      .prepare('SELECT * FROM credentials WHERE provider_id = ? ORDER BY priority DESC')
      .all(providerId)
      .map(rowToCredential);
  }

  get(id: string): CredentialEntry | null {
    const row = this.db.prepare('SELECT * FROM credentials WHERE id = ?').get(id);
    return row ? rowToCredential(row) : null;
  }

  /**
   * `keyRef` is an env var name or secret-store handle — never the secret.
   * `rawKeyForMask` is used only to compute the display mask and is not stored.
   */
  upsert(c: {
    id?: string;
    providerId: string;
    label: string;
    keyRef: string;
    rawKeyForMask: string;
    enabled?: boolean;
    priority?: number;
    weight?: number;
  }): CredentialEntry {
    const existing = this.db
      .prepare('SELECT id FROM credentials WHERE provider_id = ? AND key_ref = ?')
      .get(c.providerId, c.keyRef) as { id: string } | undefined;

    const id = c.id ?? existing?.id ?? generateId('cred');
    const now = Date.now();

    this.db
      .prepare(
        `INSERT INTO credentials (id, provider_id, label, key_ref, masked_key, enabled, priority, weight, created_at)
         VALUES (@id, @providerId, @label, @keyRef, @masked, @enabled, @priority, @weight, @now)
         ON CONFLICT(id) DO UPDATE SET
           label      = @label,
           key_ref    = @keyRef,
           masked_key = @masked,
           priority   = @priority,
           weight     = @weight`,
      )
      .run({
        id,
        providerId: c.providerId,
        label: c.label,
        keyRef: c.keyRef,
        masked: maskSecret(c.rawKeyForMask),
        enabled: c.enabled === false ? 0 : 1,
        priority: c.priority ?? 50,
        weight: c.weight ?? 1,
        now,
      });

    return this.get(id)!;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE credentials SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
  }
}

/* ── models ──────────────────────────────────────────────────────────── */

export class ModelRepo {
  constructor(private db: DB) {}

  list(): ModelEntry[] {
    return this.db
      .prepare('SELECT * FROM models ORDER BY priority DESC, id ASC')
      .all()
      .map(rowToModel);
  }

  listEnabled(): ModelEntry[] {
    return this.db
      .prepare('SELECT * FROM models WHERE enabled = 1 ORDER BY priority DESC, id ASC')
      .all()
      .map(rowToModel);
  }

  get(id: string): ModelEntry | null {
    const row = this.db.prepare('SELECT * FROM models WHERE id = ?').get(id);
    return row ? rowToModel(row) : null;
  }

  upsert(m: {
    id: string;
    provider: string;
    model: string;
    displayName: string;
    capabilities?: string[];
    contextLength?: number;
    maxOutputTokens?: number;
    enabled?: boolean;
    priority?: number;
    costTier?: CostTier;
  }): ModelEntry {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO models (id, provider_id, model, display_name, capabilities, context_length, max_output_tokens, enabled, priority, cost_tier, created_at, updated_at)
         VALUES (@id, @provider, @model, @displayName, @caps, @ctx, @maxOut, @enabled, @priority, @cost, @now, @now)
         ON CONFLICT(id) DO UPDATE SET
           provider_id    = @provider,
           model          = @model,
           display_name   = @displayName,
           capabilities   = @caps,
           context_length = @ctx,
           max_output_tokens = @maxOut,
           priority       = @priority,
           cost_tier      = @cost,
           updated_at     = @now`,
      )
      .run({
        id: m.id,
        provider: m.provider,
        model: m.model,
        displayName: m.displayName,
        caps: JSON.stringify(m.capabilities ?? ['chat']),
        ctx: m.contextLength ?? 128_000,
        maxOut: m.maxOutputTokens ?? null,
        enabled: m.enabled === false ? 0 : 1,
        priority: m.priority ?? 50,
        cost: m.costTier ?? 'standard',
        now,
      });
    return this.get(m.id)!;
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare('UPDATE models SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, Date.now(), id);
  }

  setPriority(id: string, priority: number): void {
    this.db
      .prepare('UPDATE models SET priority = ?, updated_at = ? WHERE id = ?')
      .run(priority, Date.now(), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM models WHERE id = ?').run(id);
  }
}

/* ── profiles ────────────────────────────────────────────────────────── */

export class ProfileRepo {
  constructor(private db: DB) {}

  list(): RoutingProfile[] {
    return this.db.prepare('SELECT * FROM profiles ORDER BY id ASC').all().map(rowToProfile);
  }

  get(id: string): RoutingProfile | null {
    const row = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    return row ? rowToProfile(row) : null;
  }

  upsert(p: {
    id: string;
    displayName: string;
    description?: string;
    models: string[];
    enabled?: boolean;
  }): RoutingProfile {
    this.db
      .prepare(
        `INSERT INTO profiles (id, display_name, description, models, enabled, updated_at)
         VALUES (@id, @displayName, @description, @models, @enabled, @now)
         ON CONFLICT(id) DO UPDATE SET
           display_name = @displayName,
           description  = @description,
           models       = @models,
           enabled      = @enabled,
           updated_at   = @now`,
      )
      .run({
        id: p.id,
        displayName: p.displayName,
        description: p.description ?? '',
        models: JSON.stringify(p.models),
        enabled: p.enabled === false ? 0 : 1,
        now: Date.now(),
      });
    return this.get(p.id)!;
  }

  setModels(id: string, models: string[]): void {
    this.db
      .prepare('UPDATE profiles SET models = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(models), Date.now(), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  }
}

/* ── router API keys ─────────────────────────────────────────────────── */

export class RouterKeyRepo {
  constructor(private db: DB) {}

  list(): RouterApiKey[] {
    return this.db.prepare('SELECT * FROM router_keys ORDER BY created_at DESC').all().map(rowToKey);
  }

  findByHash(hash: string): RouterApiKey | null {
    const row = this.db.prepare('SELECT * FROM router_keys WHERE key_hash = ?').get(hash);
    return row ? rowToKey(row) : null;
  }

  get(id: string): RouterApiKey | null {
    const row = this.db.prepare('SELECT * FROM router_keys WHERE id = ?').get(id);
    return row ? rowToKey(row) : null;
  }

  create(k: {
    name: string;
    keyHash: string;
    keyPrefix: string;
    maskedKey: string;
    usageLimit?: number | null;
  }): RouterApiKey {
    const id = generateId('key');
    this.db
      .prepare(
        `INSERT INTO router_keys (id, name, key_hash, key_prefix, masked_key, enabled, usage_limit, usage_count, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?)`,
      )
      .run(id, k.name, k.keyHash, k.keyPrefix, k.maskedKey, k.usageLimit ?? null, Date.now());
    return this.get(id)!;
  }

  recordUsage(id: string): void {
    this.db
      .prepare('UPDATE router_keys SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?')
      .run(Date.now(), id);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE router_keys SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  /**
   * Change a key's request cap. `null` removes the cap.
   *
   * The count is deliberately left alone: raising a limit on an exhausted key
   * should let it through again, and zeroing the counter instead would erase the
   * usage history the operator is looking at while making the decision.
   */
  setLimit(id: string, usageLimit: number | null): void {
    this.db.prepare('UPDATE router_keys SET usage_limit = ? WHERE id = ?').run(usageLimit, id);
  }

  revoke(id: string): void {
    this.db
      .prepare('UPDATE router_keys SET revoked_at = ?, enabled = 0 WHERE id = ?')
      .run(Date.now(), id);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM router_keys WHERE id = ?').run(id);
  }
}

/* ── request logs ────────────────────────────────────────────────────── */

export interface LogFilter {
  provider?: string;
  model?: string;
  status?: 'success' | 'error';
  requestId?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

export class RequestLogRepo {
  constructor(private db: DB) {}

  insert(e: Omit<RequestLogEntry, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO request_logs (id, request_id, timestamp, requested_model, resolved_profile,
           selected_provider, selected_model, status, http_status, latency_ms, fallback_count,
           prompt_tokens, completion_tokens, total_tokens, streamed, error_class, error_message,
           attempts, api_key_id, client_ip)
         VALUES (@id, @requestId, @timestamp, @requestedModel, @resolvedProfile, @selectedProvider,
           @selectedModel, @status, @httpStatus, @latencyMs, @fallbackCount, @promptTokens,
           @completionTokens, @totalTokens, @streamed, @errorClass, @errorMessage, @attempts,
           @apiKeyId, @clientIp)`,
      )
      .run({
        id: generateId('log'),
        requestId: e.requestId,
        timestamp: e.timestamp,
        requestedModel: e.requestedModel,
        resolvedProfile: e.resolvedProfile,
        selectedProvider: e.selectedProvider,
        selectedModel: e.selectedModel,
        status: e.status,
        httpStatus: e.httpStatus,
        latencyMs: e.latencyMs,
        fallbackCount: e.fallbackCount,
        promptTokens: e.promptTokens,
        completionTokens: e.completionTokens,
        totalTokens: e.totalTokens,
        streamed: e.streamed ? 1 : 0,
        errorClass: e.errorClass,
        errorMessage: e.errorMessage,
        attempts: e.attempts,
        apiKeyId: e.apiKeyId,
        clientIp: e.clientIp,
      });
  }

  query(f: LogFilter = {}): RequestLogEntry[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};

    if (f.provider) {
      where.push('selected_provider = @provider');
      params.provider = f.provider;
    }
    if (f.model) {
      where.push('(selected_model = @model OR requested_model = @model)');
      params.model = f.model;
    }
    if (f.status) {
      where.push('status = @status');
      params.status = f.status;
    }
    if (f.requestId) {
      where.push('request_id LIKE @requestId');
      params.requestId = `%${f.requestId}%`;
    }
    if (f.since !== undefined) {
      where.push('timestamp >= @since');
      params.since = f.since;
    }
    if (f.until !== undefined) {
      where.push('timestamp <= @until');
      params.until = f.until;
    }

    const sql = `SELECT * FROM request_logs
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY timestamp DESC
      LIMIT @limit OFFSET @offset`;

    params.limit = Math.min(f.limit ?? 100, 1000);
    params.offset = f.offset ?? 0;

    return this.db.prepare(sql).all(params).map(rowToLog);
  }

  count(f: LogFilter = {}): number {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (f.provider) {
      where.push('selected_provider = @provider');
      params.provider = f.provider;
    }
    if (f.status) {
      where.push('status = @status');
      params.status = f.status;
    }
    if (f.since !== undefined) {
      where.push('timestamp >= @since');
      params.since = f.since;
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM request_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`)
      .get(params) as { n: number };
    return row.n;
  }

  stats(since?: number): {
    total: number;
    successes: number;
    avgLatency: number;
    failovers: number;
    streamed: number;
    totalTokens: number;
  } {
    const clause = since !== undefined ? 'WHERE timestamp >= @since' : '';
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*)                                        AS total,
           SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
           AVG(latency_ms)                                 AS avgLatency,
           SUM(CASE WHEN fallback_count > 0 THEN 1 ELSE 0 END) AS failovers,
           SUM(streamed)                                   AS streamed,
           SUM(COALESCE(total_tokens, 0))                  AS totalTokens
         FROM request_logs ${clause}`,
      )
      .get(since !== undefined ? { since } : {}) as {
      total: number;
      successes: number | null;
      avgLatency: number | null;
      failovers: number | null;
      streamed: number | null;
      totalTokens: number | null;
    };

    return {
      total: row.total ?? 0,
      successes: row.successes ?? 0,
      avgLatency: Math.round(row.avgLatency ?? 0),
      failovers: row.failovers ?? 0,
      streamed: row.streamed ?? 0,
      totalTokens: row.totalTokens ?? 0,
    };
  }

  /** Per-provider aggregates for the providers page. */
  providerStats(): Array<{
    provider: string;
    requests: number;
    successes: number;
    failures: number;
    avgLatency: number;
  }> {
    return this.db
      .prepare(
        `SELECT selected_provider AS provider,
                COUNT(*) AS requests,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
                SUM(CASE WHEN status = 'error'   THEN 1 ELSE 0 END) AS failures,
                AVG(latency_ms) AS avgLatency
         FROM request_logs
         WHERE selected_provider IS NOT NULL
         GROUP BY selected_provider`,
      )
      .all()
      .map((r) => {
        const row = r as {
          provider: string;
          requests: number;
          successes: number;
          failures: number;
          avgLatency: number | null;
        };
        return {
          provider: row.provider,
          requests: row.requests,
          successes: row.successes,
          failures: row.failures,
          avgLatency: Math.round(row.avgLatency ?? 0),
        };
      });
  }

  /** Requests bucketed by hour, for the dashboard timeline. */
  timeline(since: number, buckets = 24): Array<{ t: number; total: number; errors: number }> {
    const rows = this.db
      .prepare(
        `SELECT timestamp, status FROM request_logs WHERE timestamp >= ? ORDER BY timestamp ASC`,
      )
      .all(since) as Array<{ timestamp: number; status: string }>;

    const now = Date.now();
    const span = Math.max(1, now - since);
    const width = span / buckets;
    const out = Array.from({ length: buckets }, (_, i) => ({
      t: Math.round(since + i * width),
      total: 0,
      errors: 0,
    }));

    for (const r of rows) {
      const idx = Math.min(buckets - 1, Math.floor((r.timestamp - since) / width));
      const bucket = out[idx];
      if (!bucket) continue;
      bucket.total++;
      if (r.status === 'error') bucket.errors++;
    }
    return out;
  }

  pruneOlderThan(cutoff: number): number {
    const info = this.db.prepare('DELETE FROM request_logs WHERE timestamp < ?').run(cutoff);
    return info.changes;
  }

  clear(): void {
    this.db.prepare('DELETE FROM request_logs').run();
  }
}

/* ── health persistence ──────────────────────────────────────────────── */

export class HealthRepo {
  constructor(private db: DB) {}

  loadAll(): HealthState[] {
    return this.db.prepare('SELECT * FROM health_states').all().map(rowToHealth);
  }

  save(s: HealthState): void {
    this.db
      .prepare(
        `INSERT INTO health_states (credential_id, provider_id, status, consecutive_failures,
           total_requests, total_successes, total_failures, total_timeouts, total_rate_limits,
           cooldown_until, cooldown_level, last_success_at, last_failure_at, last_error_class,
           latency_samples, updated_at)
         VALUES (@credentialId, @providerId, @status, @consecutiveFailures, @totalRequests,
           @totalSuccesses, @totalFailures, @totalTimeouts, @totalRateLimits, @cooldownUntil,
           @cooldownLevel, @lastSuccessAt, @lastFailureAt, @lastErrorClass, @latencySamples, @now)
         ON CONFLICT(credential_id) DO UPDATE SET
           status = @status, consecutive_failures = @consecutiveFailures,
           total_requests = @totalRequests, total_successes = @totalSuccesses,
           total_failures = @totalFailures, total_timeouts = @totalTimeouts,
           total_rate_limits = @totalRateLimits, cooldown_until = @cooldownUntil,
           cooldown_level = @cooldownLevel, last_success_at = @lastSuccessAt,
           last_failure_at = @lastFailureAt, last_error_class = @lastErrorClass,
           latency_samples = @latencySamples, updated_at = @now`,
      )
      .run({
        credentialId: s.credentialId,
        providerId: s.providerId,
        status: s.status,
        consecutiveFailures: s.consecutiveFailures,
        totalRequests: s.totalRequests,
        totalSuccesses: s.totalSuccesses,
        totalFailures: s.totalFailures,
        totalTimeouts: s.totalTimeouts,
        totalRateLimits: s.totalRateLimits,
        cooldownUntil: s.cooldownUntil,
        cooldownLevel: s.cooldownLevel,
        lastSuccessAt: s.lastSuccessAt,
        lastFailureAt: s.lastFailureAt,
        lastErrorClass: s.lastErrorClass,
        latencySamples: JSON.stringify(s.latencySamples.slice(-50)),
        now: Date.now(),
      });
  }

  saveMany(states: HealthState[]): void {
    const tx = this.db.transaction((list: HealthState[]) => {
      for (const s of list) this.save(s);
    });
    tx(states);
  }

  clear(): void {
    this.db.prepare('DELETE FROM health_states').run();
  }
}

/* ── settings ────────────────────────────────────────────────────────── */

export class SettingsRepo {
  constructor(private db: DB) {}

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  getJSON<T>(key: string, fallback: T): T {
    const raw = this.get(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  setJSON(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }

  /** Drop an override so the env default applies again. */
  remove(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  all(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string;
      value: string;
    }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }
}

/* ── row mappers ─────────────────────────────────────────────────────── */

function rowToProvider(r: unknown): ProviderEntry {
  const row = r as Record<string, unknown>;
  return {
    id: row.id as string,
    displayName: row.display_name as string,
    kind: row.kind as ProviderKind,
    baseUrl: row.base_url as string,
    enabled: Boolean(row.enabled),
    priority: row.priority as number,
    credentialEnvHint: (row.credential_env_hint as string) ?? undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToCredential(r: unknown): CredentialEntry {
  const row = r as Record<string, unknown>;
  return {
    id: row.id as string,
    providerId: row.provider_id as string,
    label: row.label as string,
    keyRef: row.key_ref as string,
    maskedKey: row.masked_key as string,
    enabled: Boolean(row.enabled),
    priority: row.priority as number,
    weight: row.weight as number,
    createdAt: row.created_at as number,
  };
}

function rowToModel(r: unknown): ModelEntry {
  const row = r as Record<string, unknown>;
  let caps: Capability[] = ['chat'];
  try {
    caps = JSON.parse(row.capabilities as string) as Capability[];
  } catch {
    /* keep default */
  }
  return {
    id: row.id as string,
    provider: row.provider_id as string,
    model: row.model as string,
    displayName: row.display_name as string,
    capabilities: caps,
    contextLength: row.context_length as number,
    maxOutputTokens: (row.max_output_tokens as number) ?? undefined,
    enabled: Boolean(row.enabled),
    priority: row.priority as number,
    costTier: row.cost_tier as CostTier,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToProfile(r: unknown): RoutingProfile {
  const row = r as Record<string, unknown>;
  let models: string[] = [];
  try {
    models = JSON.parse(row.models as string) as string[];
  } catch {
    /* keep default */
  }
  return {
    id: row.id as string,
    displayName: row.display_name as string,
    description: row.description as string,
    models,
    enabled: Boolean(row.enabled),
    updatedAt: row.updated_at as number,
  };
}

function rowToKey(r: unknown): RouterApiKey {
  const row = r as Record<string, unknown>;
  return {
    id: row.id as string,
    name: row.name as string,
    keyHash: row.key_hash as string,
    keyPrefix: row.key_prefix as string,
    maskedKey: row.masked_key as string,
    enabled: Boolean(row.enabled),
    revokedAt: (row.revoked_at as number) ?? null,
    usageLimit: (row.usage_limit as number) ?? null,
    usageCount: row.usage_count as number,
    lastUsedAt: (row.last_used_at as number) ?? null,
    createdAt: row.created_at as number,
  };
}

function rowToLog(r: unknown): RequestLogEntry {
  const row = r as Record<string, unknown>;
  return {
    id: row.id as string,
    requestId: row.request_id as string,
    timestamp: row.timestamp as number,
    requestedModel: row.requested_model as string,
    resolvedProfile: (row.resolved_profile as string) ?? null,
    selectedProvider: (row.selected_provider as string) ?? null,
    selectedModel: (row.selected_model as string) ?? null,
    status: row.status as 'success' | 'error',
    httpStatus: row.http_status as number,
    latencyMs: row.latency_ms as number,
    fallbackCount: row.fallback_count as number,
    promptTokens: (row.prompt_tokens as number) ?? null,
    completionTokens: (row.completion_tokens as number) ?? null,
    totalTokens: (row.total_tokens as number) ?? null,
    streamed: Boolean(row.streamed),
    errorClass: (row.error_class as string) ?? null,
    errorMessage: (row.error_message as string) ?? null,
    attempts: (row.attempts as string) ?? '[]',
    apiKeyId: (row.api_key_id as string) ?? null,
    clientIp: (row.client_ip as string) ?? null,
  };
}

function rowToHealth(r: unknown): HealthState {
  const row = r as Record<string, unknown>;
  let samples: number[] = [];
  try {
    samples = JSON.parse(row.latency_samples as string) as number[];
  } catch {
    /* keep default */
  }
  return {
    credentialId: row.credential_id as string,
    providerId: row.provider_id as string,
    status: row.status as HealthStatus,
    consecutiveFailures: row.consecutive_failures as number,
    totalRequests: row.total_requests as number,
    totalSuccesses: row.total_successes as number,
    totalFailures: row.total_failures as number,
    totalTimeouts: row.total_timeouts as number,
    totalRateLimits: row.total_rate_limits as number,
    cooldownUntil: (row.cooldown_until as number) ?? null,
    cooldownLevel: row.cooldown_level as number,
    lastSuccessAt: (row.last_success_at as number) ?? null,
    lastFailureAt: (row.last_failure_at as number) ?? null,
    lastErrorClass: (row.last_error_class as string) ?? null,
    latencySamples: samples,
  };
}

/** All repositories, constructed once and passed around as a unit. */
export interface Repositories {
  providers: ProviderRepo;
  credentials: CredentialRepo;
  models: ModelRepo;
  profiles: ProfileRepo;
  routerKeys: RouterKeyRepo;
  logs: RequestLogRepo;
  health: HealthRepo;
  settings: SettingsRepo;
}

export function createRepositories(db: DB): Repositories {
  return {
    providers: new ProviderRepo(db),
    credentials: new CredentialRepo(db),
    models: new ModelRepo(db),
    profiles: new ProfileRepo(db),
    routerKeys: new RouterKeyRepo(db),
    logs: new RequestLogRepo(db),
    health: new HealthRepo(db),
    settings: new SettingsRepo(db),
  };
}
