import {
  BUILTIN_PROVIDERS,
  DEFAULT_PROFILES,
  AUTO_PROFILE_ID,
  type ProviderDefinition,
} from '@router/providers';
import { hashSecret, maskSecret } from '@router/shared';
import type { RouterConfig } from './env.js';
import type { Repositories } from './repositories.js';

/**
 * First-boot seeding + per-boot credential reconciliation.
 *
 * The important invariant: provider secrets live in `process.env` only. What
 * lands in SQLite is the env var NAME (`keyRef`) plus a display mask. Reading
 * a credential row can never yield a usable key — resolution goes back to the
 * live config map at call time (see `resolveSecret`).
 */

export interface SeedResult {
  providersSeeded: number;
  modelsSeeded: number;
  profilesSeeded: number;
  credentialsRegistered: number;
  credentialsDisabled: number;
  bootstrapKey: string | null;
}

const SEED_VERSION_KEY = 'seed_version';
const SEED_VERSION = '1';

export async function seedDatabase(
  repos: Repositories,
  config: RouterConfig,
  opts: { bootstrapKeyPlaintext?: string } = {},
): Promise<SeedResult> {
  const fresh = repos.settings.get(SEED_VERSION_KEY) !== SEED_VERSION;

  const result: SeedResult = {
    providersSeeded: 0,
    modelsSeeded: 0,
    profilesSeeded: 0,
    credentialsRegistered: 0,
    credentialsDisabled: 0,
    bootstrapKey: null,
  };

  /* ── Providers + models ───────────────────────────────────────────── */
  // Upserted every boot so new builtin providers appear after an upgrade,
  // but operator edits (enabled, priority) are preserved: upsert never
  // resets `enabled`, only creation sets it.
  for (const def of BUILTIN_PROVIDERS) {
    const existing = repos.providers.get(def.id);
    repos.providers.upsert({
      id: def.id,
      displayName: def.displayName,
      kind: def.kind,
      baseUrl: resolveBaseUrl(def, config),
      enabled: existing?.enabled ?? true,
      priority: existing?.priority ?? def.priority,
      credentialEnvHint: def.envKey,
      extraHeaders: def.extraHeaders,
    });
    if (!existing) result.providersSeeded++;

    for (const m of def.models) {
      const had = repos.models.get(m.id);
      repos.models.upsert({
        id: m.id,
        provider: def.id,
        model: m.model,
        displayName: m.displayName,
        capabilities: m.capabilities,
        contextLength: m.contextLength,
        enabled: had?.enabled ?? true,
        priority: had?.priority ?? m.priority,
        costTier: m.costTier,
      });
      if (!had) result.modelsSeeded++;
    }
  }

  /* ── Custom OpenAI-compatible endpoint ────────────────────────────── */
  if (config.customProvider) {
    const existing = repos.providers.get('custom');
    repos.providers.upsert({
      id: 'custom',
      displayName: 'Custom endpoint',
      kind: 'openai-compatible',
      baseUrl: config.customProvider.baseUrl,
      enabled: existing?.enabled ?? true,
      priority: existing?.priority ?? 40,
      credentialEnvHint: 'CUSTOM_PROVIDER_API_KEY',
    });
    if (!existing) result.providersSeeded++;

    for (const [i, model] of config.customProvider.models.entries()) {
      const id = `custom-${slug(model)}`;
      const had = repos.models.get(id);
      repos.models.upsert({
        id,
        provider: 'custom',
        model,
        displayName: model,
        capabilities: ['chat'],
        contextLength: 128_000,
        enabled: had?.enabled ?? true,
        priority: had?.priority ?? Math.max(1, 40 - i),
        costTier: 'standard',
      });
      if (!had) result.modelsSeeded++;
    }
  }

  /* ── Mock upstream ────────────────────────────────────────────────── */
  // Registered as ordinary providers so the whole request path — auth,
  // routing, health, failover — is exercised for real without spending
  // a cent. They are just OpenAI-compatible endpoints.
  //
  // TWO provider rows, not one, and that matters: failover is the feature
  // this project exists for, and it only happens between provider/credential
  // pairs. With a single mock credential a 429 correctly parks that
  // credential and the ladder has nowhere to go, so a fresh checkout could
  // never demonstrate — or test — its own core behaviour. Both rows point at
  // the same upstream process; what differs is the credential and therefore
  // the health state tracked against it.
  if (config.enableMockProvider) {
    for (const inst of MOCK_INSTANCES) {
      const existing = repos.providers.get(inst.id);
      repos.providers.upsert({
        id: inst.id,
        displayName: inst.displayName,
        kind: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${config.mockProviderPort}/v1`,
        enabled: existing?.enabled ?? true,
        // Highest priority so a dev box with no real keys still routes.
        priority: existing?.priority ?? inst.priority,
        credentialEnvHint: 'MOCK_PROVIDER_API_KEY',
      });
      if (!existing) result.providersSeeded++;

      for (const m of inst.models) {
        const had = repos.models.get(m.id);
        repos.models.upsert({
          id: m.id,
          provider: inst.id,
          model: m.model,
          displayName: m.displayName,
          // MOCK_MODELS is `as const` so the mock upstream can key off the
          // literal ids; copy into a mutable array for the repo signature.
          capabilities: [...m.capabilities],
          contextLength: m.contextLength,
          enabled: had?.enabled ?? true,
          priority: had?.priority ?? m.priority,
          costTier: 'free',
        });
        if (!had) result.modelsSeeded++;
      }
    }
  }

  /* ── Codex / ChatGPT OAuth provider ───────────────────────────────── */
  // Registered when OAuth is enabled, with NO env credential — accounts are
  // added at runtime through the browser OAuth flow, each becoming its own
  // credential row (see the oauth routes). The model is seeded disabled-free
  // but only routes once at least one account is connected and healthy.
  if (config.codexOAuth) {
    const existing = repos.providers.get(CODEX_PROVIDER_ID);
    repos.providers.upsert({
      id: CODEX_PROVIDER_ID,
      displayName: 'ChatGPT / Codex (OAuth)',
      kind: 'openai-codex',
      baseUrl: config.codexOAuth.backendBaseUrl,
      enabled: existing?.enabled ?? true,
      priority: existing?.priority ?? 75,
    });
    if (!existing) result.providersSeeded++;

    for (const m of CODEX_MODELS) {
      const had = repos.models.get(m.id);
      repos.models.upsert({
        id: m.id,
        provider: CODEX_PROVIDER_ID,
        model: m.model,
        displayName: m.displayName,
        capabilities: [...m.capabilities],
        contextLength: m.contextLength,
        enabled: had?.enabled ?? true,
        priority: had?.priority ?? m.priority,
        costTier: 'standard',
      });
      if (!had) result.modelsSeeded++;
    }
  }

  /* ── Profiles ─────────────────────────────────────────────────────── */
  // Seeded once. After that they belong to the operator — re-running seed
  // must not silently undo a reordered ladder.
  if (fresh) {
    for (const p of DEFAULT_PROFILES) {
      repos.profiles.upsert({
        id: p.id,
        displayName: p.displayName,
        description: p.description,
        models: withMockFirst(p.models, config),
      });
      result.profilesSeeded++;
    }
    const general = DEFAULT_PROFILES.find((p) => p.id === 'general');
    repos.profiles.upsert({
      id: AUTO_PROFILE_ID,
      displayName: 'Auto',
      description: 'Default ladder used when the client sends model:"auto"',
      models: withMockFirst(general?.models ?? [], config),
    });
    result.profilesSeeded++;
  } else if (config.enableMockProvider) {
    // Mock was switched on, or a new mock row shipped in an upgrade, after
    // first boot. Append what's missing so `auto` still resolves on a machine
    // with no real credentials. Append-only: an operator's existing ladder
    // keeps both its membership and its order.
    for (const profile of repos.profiles.list()) {
      const missing = MOCK_LADDER.filter((id) => !profile.models.includes(id));
      if (missing.length > 0) {
        repos.profiles.setModels(profile.id, [...profile.models, ...missing]);
      }
    }
  }

  /* ── Credentials from env ─────────────────────────────────────────── */
  const seen = new Set<string>();

  for (const def of BUILTIN_PROVIDERS) {
    for (const { envVar, value, index } of collectKeys(def.envKey, config)) {
      const cred = repos.credentials.upsert({
        providerId: def.id,
        label: index === 1 ? `${def.displayName} primary` : `${def.displayName} #${index}`,
        keyRef: envVar,
        rawKeyForMask: value,
        priority: 100 - index,
      });
      seen.add(cred.id);
      result.credentialsRegistered++;
    }
  }

  if (config.customProvider) {
    const cred = repos.credentials.upsert({
      providerId: 'custom',
      label: 'Custom endpoint',
      keyRef: 'CUSTOM_PROVIDER_API_KEY',
      rawKeyForMask: config.customProvider.apiKey,
    });
    seen.add(cred.id);
    result.credentialsRegistered++;
  }

  if (config.enableMockProvider) {
    for (const inst of MOCK_INSTANCES) {
      const cred = repos.credentials.upsert({
        providerId: inst.id,
        label: inst.credentialLabel,
        keyRef: 'MOCK_PROVIDER_API_KEY',
        rawKeyForMask: MOCK_API_KEY,
        priority: inst.priority,
      });
      seen.add(cred.id);
      result.credentialsRegistered++;
    }
  }

  // A credential whose env var vanished is disabled rather than deleted, so
  // its accumulated health history survives a temporary unset. OAuth
  // credentials are exempt: they have no env var to vanish — their secret is
  // the encrypted token store, managed at runtime by the OAuth routes — so the
  // env-reconciliation sweep must never touch them.
  for (const cred of repos.credentials.list()) {
    if (seen.has(cred.id)) continue;
    if (cred.secretKind === 'oauth') continue;
    if (cred.enabled) {
      repos.credentials.setEnabled(cred.id, false);
      result.credentialsDisabled++;
    }
  }

  /* ── Bootstrap router API key ─────────────────────────────────────── */
  const plaintext = opts.bootstrapKeyPlaintext ?? config.bootstrapApiKey;
  if (plaintext && !plaintext.includes('CHANGE-ME')) {
    const hash = await hashSecret(plaintext);
    if (!repos.routerKeys.findByHash(hash)) {
      repos.routerKeys.create({
        name: 'Bootstrap key (from ROUTER_API_KEY)',
        keyHash: hash,
        keyPrefix: plaintext.slice(0, 12),
        maskedKey: maskSecret(plaintext),
      });
      result.bootstrapKey = maskSecret(plaintext);
    }
  }

  repos.settings.set(SEED_VERSION_KEY, SEED_VERSION);
  if (!repos.settings.get('rotation_strategy')) {
    repos.settings.set('rotation_strategy', config.rotationStrategy);
  }
  if (!repos.settings.get('default_profile')) {
    repos.settings.set('default_profile', config.defaultProfile);
  }

  return result;
}

/**
 * Turn a credential row back into a usable secret.
 *
 * This is the ONLY function that produces raw key material, and it reads from
 * the in-memory config map — never from the database. Nothing in the admin
 * API calls it.
 */
export function resolveSecret(keyRef: string, config: RouterConfig): string | null {
  if (keyRef === 'MOCK_PROVIDER_API_KEY') return MOCK_API_KEY;
  if (keyRef === 'CUSTOM_PROVIDER_API_KEY') return config.customProvider?.apiKey ?? null;
  return config.providerKeys.get(keyRef) ?? process.env[keyRef] ?? null;
}

/* ── helpers ─────────────────────────────────────────────────────────── */

/** Provider id for the OAuth ChatGPT/Codex connection. */
export const CODEX_PROVIDER_ID = 'openai-codex';

/**
 * Models routed to a connected ChatGPT/Codex account. Kept minimal — the
 * account, not the model list, is what a user connects. Overridable later via
 * the admin API like any other model row.
 */
export const CODEX_MODELS = [
  {
    id: 'codex-gpt-5',
    model: 'gpt-5-codex',
    displayName: 'ChatGPT Codex',
    capabilities: ['chat', 'tools', 'reasoning'],
    contextLength: 128_000,
    priority: 75,
  },
] as const;

/** The mock upstream accepts exactly this key — it is not a secret. */
export const MOCK_API_KEY = 'mock-local-key';

export const MOCK_MODELS = [
  {
    id: 'mock-fast',
    model: 'mock-fast',
    displayName: 'Mock Fast',
    capabilities: ['chat', 'tools'],
    contextLength: 32_000,
    priority: 100,
  },
  {
    id: 'mock-smart',
    model: 'mock-smart',
    displayName: 'Mock Smart',
    capabilities: ['chat', 'tools', 'reasoning', 'vision'],
    contextLength: 128_000,
    priority: 95,
  },
] as const;

/** The standby instance's models. Same upstream, separate credential. */
export const MOCK_BACKUP_MODELS = [
  {
    id: 'mock-backup',
    model: 'mock-backup',
    displayName: 'Mock Backup',
    capabilities: ['chat', 'tools'],
    contextLength: 32_000,
    priority: 90,
  },
  {
    id: 'mock-backup-smart',
    model: 'mock-smart',
    displayName: 'Mock Backup Smart',
    capabilities: ['chat', 'tools', 'reasoning', 'vision'],
    contextLength: 128_000,
    priority: 85,
  },
] as const;

/**
 * The two mock provider rows. `mock` is primary; `mock-standby` is what the
 * ladder falls over to when `mock`'s credential gets parked.
 */
export const MOCK_INSTANCES = [
  {
    id: 'mock',
    displayName: 'Mock upstream (local)',
    credentialLabel: 'Mock upstream',
    priority: 100,
    models: MOCK_MODELS,
  },
  {
    id: 'mock-standby',
    displayName: 'Mock upstream standby (local)',
    credentialLabel: 'Mock upstream standby',
    priority: 90,
    models: MOCK_BACKUP_MODELS,
  },
] as const;

/** Env vars for a provider, including `_2`/`_3` extra accounts. */
function collectKeys(
  envKey: string,
  config: RouterConfig,
): Array<{ envVar: string; value: string; index: number }> {
  const out: Array<{ envVar: string; value: string; index: number }> = [];
  const primary = config.providerKeys.get(envKey);
  if (primary) out.push({ envVar: envKey, value: primary, index: 1 });

  for (const [name, value] of config.providerKeys) {
    const m = name.match(new RegExp(`^${escapeRegex(envKey)}_(\\d+)$`));
    if (m?.[1]) out.push({ envVar: name, value, index: Number(m[1]) });
  }
  return out.sort((a, b) => a.index - b.index);
}

function resolveBaseUrl(def: ProviderDefinition, config: RouterConfig): string {
  if (def.envBaseUrl) {
    const override = config.providerBaseUrls.get(def.envBaseUrl);
    if (override) return override.replace(/\/+$/, '');
  }
  return def.defaultBaseUrl;
}

/**
 * Put the mock ladder in front when the mock upstream is on, so a fresh
 * checkout with zero credentials still serves `model:"auto"` end to end —
 * and still crosses a provider boundary when the first one fails.
 */
function withMockFirst(models: string[], config: RouterConfig): string[] {
  if (!config.enableMockProvider) return models;
  const missing = MOCK_LADDER.filter((id) => !models.includes(id));
  return [...missing, ...models];
}

/** Router-facing model ids of the mock ladder, primary instance first. */
const MOCK_LADDER: string[] = MOCK_INSTANCES.flatMap((i) => i.models.map((m) => m.id));

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
