import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite storage.
 *
 * Every query lives behind a repository (see repositories.ts) so the driver
 * is swappable — moving to Postgres later means writing new repository
 * implementations, not touching callers.
 */

export type DB = Database.Database;

export function openDatabase(path: string): DB {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);

  // WAL lets the dashboard read while the router writes.
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  migrate(db);
  return db;
}

interface Migration {
  version: number;
  name: string;
  up: (db: DB) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE providers (
          id                   TEXT PRIMARY KEY,
          display_name         TEXT NOT NULL,
          kind                 TEXT NOT NULL,
          base_url             TEXT NOT NULL,
          enabled              INTEGER NOT NULL DEFAULT 1,
          priority             INTEGER NOT NULL DEFAULT 50,
          credential_env_hint  TEXT,
          extra_headers        TEXT,
          created_at           INTEGER NOT NULL,
          updated_at           INTEGER NOT NULL
        );

        -- Credentials store only a REFERENCE to the secret (the env var name
        -- or an encrypted blob), plus a masked form for display. Raw key
        -- material never lands in this table.
        CREATE TABLE credentials (
          id           TEXT PRIMARY KEY,
          provider_id  TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
          label        TEXT NOT NULL,
          key_ref      TEXT NOT NULL,
          masked_key   TEXT NOT NULL,
          enabled      INTEGER NOT NULL DEFAULT 1,
          priority     INTEGER NOT NULL DEFAULT 50,
          weight       INTEGER NOT NULL DEFAULT 1,
          created_at   INTEGER NOT NULL
        );
        CREATE INDEX idx_credentials_provider ON credentials(provider_id);

        CREATE TABLE models (
          id                TEXT PRIMARY KEY,
          provider_id       TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
          model             TEXT NOT NULL,
          display_name      TEXT NOT NULL,
          capabilities      TEXT NOT NULL DEFAULT '["chat"]',
          context_length    INTEGER NOT NULL DEFAULT 128000,
          max_output_tokens INTEGER,
          enabled           INTEGER NOT NULL DEFAULT 1,
          priority          INTEGER NOT NULL DEFAULT 50,
          cost_tier         TEXT NOT NULL DEFAULT 'standard',
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL
        );
        CREATE INDEX idx_models_provider ON models(provider_id);
        CREATE INDEX idx_models_enabled ON models(enabled);

        CREATE TABLE profiles (
          id           TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          description  TEXT NOT NULL DEFAULT '',
          models       TEXT NOT NULL DEFAULT '[]',
          enabled      INTEGER NOT NULL DEFAULT 1,
          updated_at   INTEGER NOT NULL
        );

        -- Only a SHA-256 hash is stored. The raw key is shown exactly once,
        -- at creation, and is unrecoverable afterwards.
        CREATE TABLE router_keys (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          key_hash    TEXT NOT NULL UNIQUE,
          key_prefix  TEXT NOT NULL,
          masked_key  TEXT NOT NULL,
          enabled     INTEGER NOT NULL DEFAULT 1,
          revoked_at  INTEGER,
          usage_limit INTEGER,
          usage_count INTEGER NOT NULL DEFAULT 0,
          last_used_at INTEGER,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX idx_router_keys_hash ON router_keys(key_hash);

        CREATE TABLE request_logs (
          id                TEXT PRIMARY KEY,
          request_id        TEXT NOT NULL,
          timestamp         INTEGER NOT NULL,
          requested_model   TEXT NOT NULL,
          resolved_profile  TEXT,
          selected_provider TEXT,
          selected_model    TEXT,
          status            TEXT NOT NULL,
          http_status       INTEGER NOT NULL,
          latency_ms        INTEGER NOT NULL,
          fallback_count    INTEGER NOT NULL DEFAULT 0,
          prompt_tokens     INTEGER,
          completion_tokens INTEGER,
          total_tokens      INTEGER,
          streamed          INTEGER NOT NULL DEFAULT 0,
          error_class       TEXT,
          error_message     TEXT,
          attempts          TEXT NOT NULL DEFAULT '[]',
          api_key_id        TEXT,
          client_ip         TEXT
        );
        CREATE INDEX idx_logs_timestamp ON request_logs(timestamp DESC);
        CREATE INDEX idx_logs_request_id ON request_logs(request_id);
        CREATE INDEX idx_logs_provider ON request_logs(selected_provider);
        CREATE INDEX idx_logs_status ON request_logs(status);

        -- Health survives restarts so a known-bad credential isn't
        -- immediately retried on boot.
        CREATE TABLE health_states (
          credential_id        TEXT PRIMARY KEY,
          provider_id          TEXT NOT NULL,
          status               TEXT NOT NULL DEFAULT 'ONLINE',
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          total_requests       INTEGER NOT NULL DEFAULT 0,
          total_successes      INTEGER NOT NULL DEFAULT 0,
          total_failures       INTEGER NOT NULL DEFAULT 0,
          total_timeouts       INTEGER NOT NULL DEFAULT 0,
          total_rate_limits    INTEGER NOT NULL DEFAULT 0,
          cooldown_until       INTEGER,
          cooldown_level       INTEGER NOT NULL DEFAULT 0,
          last_success_at      INTEGER,
          last_failure_at      INTEGER,
          last_error_class     TEXT,
          latency_samples      TEXT NOT NULL DEFAULT '[]',
          updated_at           INTEGER NOT NULL
        );

        CREATE TABLE settings (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    name: 'oauth_credentials',
    up: (db) => {
      // Distinguish env-backed credentials (the secret is an env var name) from
      // OAuth ones (tokens live encrypted in the new table below). Existing rows
      // default to 'env', so nothing about the current providers changes.
      db.exec(`ALTER TABLE credentials ADD COLUMN secret_kind TEXT NOT NULL DEFAULT 'env';`);

      // Encrypted-at-rest OAuth token storage, one row per connected account.
      // enc_* columns hold AES-256-GCM blobs (see crypto.ts) — raw tokens never
      // touch this table. Deleting the credential cascades the tokens away.
      db.exec(`
        CREATE TABLE oauth_credentials (
          credential_id TEXT PRIMARY KEY REFERENCES credentials(id) ON DELETE CASCADE,
          account_id    TEXT,
          email         TEXT,
          enc_access    TEXT NOT NULL,
          enc_refresh   TEXT NOT NULL,
          enc_id        TEXT,
          expires_at    INTEGER NOT NULL,
          scope         TEXT,
          updated_at    INTEGER NOT NULL
        );
        CREATE INDEX idx_oauth_account ON oauth_credentials(account_id);
      `);
    },
  },
];

function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version),
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const run = db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        Date.now(),
      );
    });
    run();
  }
}

export function currentSchemaVersion(db: DB): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row?.v ?? 0;
}
