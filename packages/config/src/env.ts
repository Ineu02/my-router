import { z } from 'zod';
import { config as loadDotenv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Environment loading and validation.
 *
 * Secrets are read here, held in memory, and never re-exported in a form
 * that can reach the dashboard. `RouterConfig.providerKeys` is deliberately
 * kept out of every serialisation path — see `toPublicConfig()`.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v.toLowerCase() === 'true' || v === '1'));

const int = (def: number, min = 0) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      const n = Number(v);
      return Number.isFinite(n) && n >= min ? Math.floor(n) : def;
    });

const EnvSchema = z.object({
  NODE_ENV: z.string().optional().default('development'),
  ROUTER_PORT: int(20128, 1),
  ROUTER_HOST: z.string().optional().default('127.0.0.1'),
  LOG_LEVEL: z.string().optional().default('info'),

  ROUTER_API_KEY: z.string().optional().default(''),
  REQUIRE_API_KEY: bool(true),

  ADMIN_TOKEN: z.string().optional().default(''),
  SESSION_SECRET: z.string().optional().default(''),

  DATABASE_URL: z.string().optional().default('file:./data/router.db'),

  DEFAULT_PROFILE: z.string().optional().default('general'),
  MAX_FALLBACK_ATTEMPTS: int(4, 1),
  REQUEST_TIMEOUT_MS: int(60_000, 100),
  CONNECT_TIMEOUT_MS: int(10_000, 100),
  GLOBAL_DEADLINE_MS: int(120_000, 100),
  ROTATION_STRATEGY: z
    .enum(['priority', 'round-robin', 'least-failures', 'health-based', 'weighted'])
    .optional()
    .default('health-based'),
  RETRY_NETWORK_ERRORS: int(1, 0),

  HEALTH_FAILURE_THRESHOLD: int(3, 1),
  HEALTH_COOLDOWN_BASE_MS: int(5_000, 100),
  HEALTH_MAX_COOLDOWN_MS: int(300_000, 1000),
  HEALTH_PROBE_INTERVAL_MS: int(60_000, 1000),
  HEALTH_SUCCESS_RESET: int(1, 1),

  RATE_LIMIT_MAX: int(120, 1),
  RATE_LIMIT_WINDOW_MS: int(60_000, 1000),
  MAX_BODY_BYTES: int(2_097_152, 1024),

  CORS_ORIGINS: z.string().optional().default('http://localhost:3000'),

  LOG_REQUESTS: bool(true),
  LOG_PROMPTS: bool(false),
  LOG_RETENTION_DAYS: int(30, 1),

  ENABLE_MOCK_PROVIDER: bool(false),
  MOCK_PROVIDER_PORT: int(20129, 1),

  /* ── Static dashboard hosting (production single-origin) ───────────── */
  // When true, the router also serves the built web dashboard from its own
  // origin, so one port exposes both the API (/v1, /api) and the UI (/).
  // Off by default: dev uses the Vite server, and the test suite never builds
  // the web bundle, so leaving this off keeps both untouched.
  SERVE_WEB: bool(false),
  // Overrides where the built dashboard is read from. Empty → apps/web/dist.
  WEB_DIST_DIR: z.string().optional().default(''),

  CUSTOM_PROVIDER_BASE_URL: z.string().optional().default(''),
  CUSTOM_PROVIDER_API_KEY: z.string().optional().default(''),
  CUSTOM_PROVIDER_MODELS: z.string().optional().default(''),

  /* ── Codex / ChatGPT OAuth (optional, all local-overridable) ───────── */
  CODEX_OAUTH_ENABLED: bool(false),
  CODEX_OAUTH_ISSUER: z.string().optional().default('https://auth.openai.com'),
  CODEX_OAUTH_CLIENT_ID: z.string().optional().default('app_EMoamEEZ73f0CkXaXp7hrann'),
  CODEX_OAUTH_REDIRECT_PORT: int(1455, 1),
  // Where the codex adapter sends chat/completions. The real ChatGPT backend
  // speaks a Responses API (documented follow-up); for local verification this
  // points at the mock upstream. Defaults to OpenAI's public base as a marker.
  CODEX_BACKEND_BASE_URL: z.string().optional().default('https://api.openai.com/v1'),
  CODEX_OAUTH_REFRESH_SKEW_MS: int(60_000, 0),
  // Passphrase used to encrypt OAuth tokens at rest. Falls back to SESSION_SECRET.
  CREDENTIAL_ENC_KEY: z.string().optional().default(''),
});

export interface RouterConfig {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  host: string;
  logLevel: string;

  bootstrapApiKey: string;
  requireApiKey: boolean;

  adminToken: string;
  sessionSecret: string;

  databaseUrl: string;
  databasePath: string;

  defaultProfile: string;
  maxFallbackAttempts: number;
  requestTimeoutMs: number;
  connectTimeoutMs: number;
  globalDeadlineMs: number;
  rotationStrategy: 'priority' | 'round-robin' | 'least-failures' | 'health-based' | 'weighted';
  retryNetworkErrors: number;

  healthFailureThreshold: number;
  healthCooldownBaseMs: number;
  healthMaxCooldownMs: number;
  healthProbeIntervalMs: number;
  healthSuccessReset: number;

  rateLimitMax: number;
  rateLimitWindowMs: number;
  maxBodyBytes: number;

  corsOrigins: string[];

  logRequests: boolean;
  logPrompts: boolean;
  logRetentionDays: number;

  enableMockProvider: boolean;
  mockProviderPort: number;

  /** Serve the built web dashboard from the router's own origin. */
  serveWeb: boolean;
  /** Absolute path to the built dashboard (apps/web/dist by default). */
  webDistDir: string;

  customProvider: { baseUrl: string; apiKey: string; models: string[] } | null;

  /**
   * Codex/ChatGPT OAuth. `null` when disabled. Endpoints are overridable so a
   * local mock authorization server can stand in with no real login.
   */
  codexOAuth: {
    enabled: boolean;
    issuer: string;
    clientId: string;
    redirectPort: number;
    redirectUri: string;
    backendBaseUrl: string;
    refreshSkewMs: number;
  } | null;

  /**
   * Passphrase for encrypting OAuth tokens at rest. Never serialised. Falls
   * back to SESSION_SECRET so a working install exists out of the box, though a
   * dedicated key is recommended (rotating SESSION_SECRET would orphan tokens).
   */
  credentialEncKey: string;

  /**
   * Provider credentials keyed by env var name.
   * NEVER serialise this. `toPublicConfig()` exists so nothing accidentally
   * does — it is the only sanctioned way to send config over the wire.
   */
  providerKeys: Map<string, string>;
  providerBaseUrls: Map<string, string>;
}

export interface ConfigWarning {
  level: 'warn' | 'error';
  message: string;
}

let cached: { config: RouterConfig; warnings: ConfigWarning[] } | null = null;

/** Walk up from this file to find the repo root (where .env lives). */
function findRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'packages'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function loadConfig(opts: { reload?: boolean; envPath?: string } = {}): {
  config: RouterConfig;
  warnings: ConfigWarning[];
} {
  if (cached && !opts.reload) return cached;

  const root = findRoot();
  const envPath = opts.envPath ?? resolve(root, '.env');
  if (existsSync(envPath)) loadDotenv({ path: envPath, override: false });

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;
  const warnings: ConfigWarning[] = [];

  /* ── Collect provider credentials ─────────────────────────────────── */
  // Any *_API_KEY is picked up, including _2/_3 suffixes for extra accounts.
  const providerKeys = new Map<string, string>();
  const providerBaseUrls = new Map<string, string>();
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (/_API_KEY(_\d+)?$/.test(k) && !k.startsWith('ROUTER_')) providerKeys.set(k, v);
    if (/_BASE_URL$/.test(k)) providerBaseUrls.set(k, v);
  }

  /* ── Security checks ──────────────────────────────────────────────── */
  const isProd = e.NODE_ENV === 'production';

  if (e.REQUIRE_API_KEY && !e.ROUTER_API_KEY) {
    warnings.push({
      level: 'warn',
      message:
        'REQUIRE_API_KEY is on but ROUTER_API_KEY is empty. A bootstrap key will be generated and printed once at startup.',
    });
  }
  if (e.ROUTER_API_KEY.includes('CHANGE-ME')) {
    warnings.push({
      level: isProd ? 'error' : 'warn',
      message: 'ROUTER_API_KEY still contains the placeholder value from .env.example.',
    });
  }
  if (!e.ADMIN_TOKEN) {
    warnings.push({
      level: isProd ? 'error' : 'warn',
      message: 'ADMIN_TOKEN is not set — the admin dashboard API will refuse all requests.',
    });
  } else if (e.ADMIN_TOKEN.includes('CHANGE-ME') || e.ADMIN_TOKEN.length < 16) {
    warnings.push({
      level: isProd ? 'error' : 'warn',
      message: 'ADMIN_TOKEN is a placeholder or shorter than 16 characters.',
    });
  }
  if (e.SESSION_SECRET && e.SESSION_SECRET.length < 32) {
    warnings.push({
      level: isProd ? 'error' : 'warn',
      message: 'SESSION_SECRET should be at least 32 characters.',
    });
  }
  if (!e.REQUIRE_API_KEY && e.ROUTER_HOST !== '127.0.0.1' && e.ROUTER_HOST !== 'localhost') {
    warnings.push({
      level: 'error',
      message: `REQUIRE_API_KEY=false while binding ${e.ROUTER_HOST} — the gateway would be open to the network.`,
    });
  }
  if (e.LOG_PROMPTS) {
    warnings.push({
      level: 'warn',
      message: 'LOG_PROMPTS=true will persist prompt content to the request log.',
    });
  }
  if (isProd && e.ENABLE_MOCK_PROVIDER) {
    warnings.push({
      level: 'warn',
      message: 'ENABLE_MOCK_PROVIDER=true in production — the fake upstream is registered as a provider.',
    });
  }
  if (e.CODEX_OAUTH_ENABLED && !e.CREDENTIAL_ENC_KEY) {
    warnings.push({
      level: isProd ? 'error' : 'warn',
      message:
        'CODEX_OAUTH_ENABLED=true without CREDENTIAL_ENC_KEY — OAuth tokens will be encrypted with SESSION_SECRET/ADMIN_TOKEN; set a dedicated CREDENTIAL_ENC_KEY so rotating the session secret does not orphan stored tokens.',
    });
  }

  const databasePath = e.DATABASE_URL.startsWith('file:')
    ? resolve(root, e.DATABASE_URL.slice(5))
    : resolve(root, 'data/router.db');

  const webDistDir = e.WEB_DIST_DIR ? resolve(root, e.WEB_DIST_DIR) : resolve(root, 'apps/web/dist');
  if (e.SERVE_WEB && !existsSync(resolve(webDistDir, 'index.html'))) {
    warnings.push({
      level: 'warn',
      message: `SERVE_WEB=true but no dashboard build was found at ${webDistDir} — run \`npm run build --workspace=@router/web\`. The API still serves normally.`,
    });
  }
  if (isProd && e.SERVE_WEB && e.ROUTER_HOST !== '127.0.0.1' && e.ROUTER_HOST !== 'localhost') {
    warnings.push({
      level: 'warn',
      message:
        'Dashboard is served on a public interface without TLS awareness here — front it with a TLS-terminating reverse proxy (or restrict the port by firewall) so the admin login is not sent in the clear.',
    });
  }

  const customModels = e.CUSTOM_PROVIDER_MODELS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const config: RouterConfig = {
    nodeEnv: e.NODE_ENV,
    isProduction: isProd,
    port: e.ROUTER_PORT,
    host: e.ROUTER_HOST,
    logLevel: e.LOG_LEVEL,

    bootstrapApiKey: e.ROUTER_API_KEY,
    requireApiKey: e.REQUIRE_API_KEY,

    adminToken: e.ADMIN_TOKEN,
    sessionSecret: e.SESSION_SECRET || e.ADMIN_TOKEN,

    databaseUrl: e.DATABASE_URL,
    databasePath,

    defaultProfile: e.DEFAULT_PROFILE,
    maxFallbackAttempts: e.MAX_FALLBACK_ATTEMPTS,
    requestTimeoutMs: e.REQUEST_TIMEOUT_MS,
    connectTimeoutMs: e.CONNECT_TIMEOUT_MS,
    globalDeadlineMs: e.GLOBAL_DEADLINE_MS,
    rotationStrategy: e.ROTATION_STRATEGY,
    retryNetworkErrors: e.RETRY_NETWORK_ERRORS,

    healthFailureThreshold: e.HEALTH_FAILURE_THRESHOLD,
    healthCooldownBaseMs: e.HEALTH_COOLDOWN_BASE_MS,
    healthMaxCooldownMs: e.HEALTH_MAX_COOLDOWN_MS,
    healthProbeIntervalMs: e.HEALTH_PROBE_INTERVAL_MS,
    healthSuccessReset: e.HEALTH_SUCCESS_RESET,

    rateLimitMax: e.RATE_LIMIT_MAX,
    rateLimitWindowMs: e.RATE_LIMIT_WINDOW_MS,
    maxBodyBytes: e.MAX_BODY_BYTES,

    corsOrigins: e.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    logRequests: e.LOG_REQUESTS,
    logPrompts: e.LOG_PROMPTS,
    logRetentionDays: e.LOG_RETENTION_DAYS,

    enableMockProvider: e.ENABLE_MOCK_PROVIDER,
    mockProviderPort: e.MOCK_PROVIDER_PORT,

    serveWeb: e.SERVE_WEB,
    webDistDir,

    customProvider:
      e.CUSTOM_PROVIDER_BASE_URL && e.CUSTOM_PROVIDER_API_KEY
        ? {
            baseUrl: e.CUSTOM_PROVIDER_BASE_URL,
            apiKey: e.CUSTOM_PROVIDER_API_KEY,
            models: customModels.length > 0 ? customModels : ['custom-default'],
          }
        : null,

    codexOAuth: e.CODEX_OAUTH_ENABLED
      ? {
          enabled: true,
          issuer: e.CODEX_OAUTH_ISSUER,
          clientId: e.CODEX_OAUTH_CLIENT_ID,
          redirectPort: e.CODEX_OAUTH_REDIRECT_PORT,
          redirectUri: `http://localhost:${e.CODEX_OAUTH_REDIRECT_PORT}/auth/callback`,
          backendBaseUrl: e.CODEX_BACKEND_BASE_URL,
          refreshSkewMs: e.CODEX_OAUTH_REFRESH_SKEW_MS,
        }
      : null,

    credentialEncKey: e.CREDENTIAL_ENC_KEY || e.SESSION_SECRET || e.ADMIN_TOKEN,

    providerKeys,
    providerBaseUrls,
  };

  cached = { config, warnings };
  return cached;
}

/**
 * The ONLY shape allowed to cross an API boundary. Credential maps and the
 * admin token are structurally absent, so a careless `res.send(config)`
 * cannot leak them.
 */
export function toPublicConfig(c: RouterConfig) {
  return {
    port: c.port,
    host: c.host,
    nodeEnv: c.nodeEnv,
    requireApiKey: c.requireApiKey,
    defaultProfile: c.defaultProfile,
    maxFallbackAttempts: c.maxFallbackAttempts,
    requestTimeoutMs: c.requestTimeoutMs,
    connectTimeoutMs: c.connectTimeoutMs,
    globalDeadlineMs: c.globalDeadlineMs,
    rotationStrategy: c.rotationStrategy,
    retryNetworkErrors: c.retryNetworkErrors,
    health: {
      failureThreshold: c.healthFailureThreshold,
      cooldownBaseMs: c.healthCooldownBaseMs,
      maxCooldownMs: c.healthMaxCooldownMs,
      probeIntervalMs: c.healthProbeIntervalMs,
      successReset: c.healthSuccessReset,
    },
    rateLimit: { max: c.rateLimitMax, windowMs: c.rateLimitWindowMs },
    maxBodyBytes: c.maxBodyBytes,
    corsOrigins: c.corsOrigins,
    logging: {
      requests: c.logRequests,
      prompts: c.logPrompts,
      retentionDays: c.logRetentionDays,
    },
    mockProviderEnabled: c.enableMockProvider,
    codexOAuthEnabled: c.codexOAuth !== null,
  };
}

export function resetConfigCache(): void {
  cached = null;
}
