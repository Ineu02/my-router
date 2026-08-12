import {
  HEALTH_RANK,
  HealthStatus,
  RouterError,
  RouterErrorCode,
  type Capability,
  type CredentialEntry,
  type ModelEntry,
  type ProviderEntry,
  type RoutingProfile,
} from '@router/shared';
import type { HealthTracker } from './health.js';

/**
 * Model resolution: turn the client's `model` string into an ordered ladder
 * of concrete candidates.
 *
 * Three accepted forms, resolved in this order:
 *   1. profile     — "auto", "coding", "cheap", ...   → the profile's model list
 *   2. prefixed id — "openai/gpt-4o"                  → pins provider + model
 *   3. bare alias  — "gemini", "claude"               → provider's best model
 *
 * Nothing here is hardcoded: even "auto" is just a profile row in the DB.
 */

export interface Candidate {
  model: ModelEntry;
  provider: ProviderEntry;
  credentials: CredentialEntry[];
}

export interface ResolveInput {
  requested: string;
  /** Overrides the model string entirely when set (router_profile). */
  forceProfile?: string;
  /** Restrict the ladder to these provider ids (router_providers). */
  restrictProviders?: string[];
  /** Capabilities the request demands, e.g. ['vision'] when images present. */
  requiredCapabilities?: Capability[];
  /** Minimum context window the request needs. */
  minContextLength?: number;

  models: ModelEntry[];
  providers: ProviderEntry[];
  credentials: CredentialEntry[];
  profiles: RoutingProfile[];
  health: HealthTracker;
  now: number;
  /** Fallback profile when the client says "auto" but no such profile exists. */
  defaultProfile: string;
}

export interface ResolveResult {
  candidates: Candidate[];
  /** Set when the request resolved through a profile. */
  profile: string | null;
}

export function resolveCandidates(input: ResolveInput): ResolveResult {
  const {
    requested,
    forceProfile,
    restrictProviders,
    requiredCapabilities = [],
    minContextLength,
    models,
    providers,
    credentials,
    profiles,
    health,
    now,
  } = input;

  const providerById = new Map(providers.map((p) => [p.id, p]));
  const modelById = new Map(models.map((m) => [m.id, m]));
  const credsByProvider = new Map<string, CredentialEntry[]>();
  for (const c of credentials) {
    const list = credsByProvider.get(c.providerId) ?? [];
    list.push(c);
    credsByProvider.set(c.providerId, list);
  }

  const name = (forceProfile ?? requested).trim();
  if (!name) {
    throw new RouterError('BAD_REQUEST', 'The `model` field is required', {
      detail: RouterErrorCode.INVALID_MODEL_FORMAT,
    });
  }

  let orderedModels: ModelEntry[] = [];
  let profileUsed: string | null = null;

  /* ── 1. Profile (includes "auto") ─────────────────────────────────── */
  const profile =
    profiles.find((p) => p.id.toLowerCase() === name.toLowerCase() && p.enabled) ??
    (name.toLowerCase() === 'auto'
      ? profiles.find((p) => p.id === input.defaultProfile && p.enabled)
      : undefined);

  if (profile) {
    profileUsed = profile.id;
    orderedModels = profile.models
      .map((id) => modelById.get(id))
      .filter((m): m is ModelEntry => m !== undefined);
  } else if (name.includes('/')) {
    /* ── 2. provider/model ──────────────────────────────────────────── */
    const slash = name.indexOf('/');
    const providerId = name.slice(0, slash).toLowerCase();
    const modelName = name.slice(slash + 1);

    const exact = models.filter(
      (m) =>
        m.provider.toLowerCase() === providerId &&
        (m.model === modelName || m.id === modelName || m.model.toLowerCase() === modelName.toLowerCase()),
    );

    if (exact.length > 0) {
      orderedModels = exact;
    } else if (providerById.has(providerId)) {
      // Provider is known but this exact model isn't in the registry. Pass it
      // through as an ephemeral entry — the upstream is the authority on which
      // model names it accepts, and pinning shouldn't require pre-registration.
      const p = providerById.get(providerId)!;
      orderedModels = [ephemeralModel(p, modelName)];
    }
  } else {
    /* ── 3. bare alias: provider name, registry id, or upstream name ─── */
    const byRegistryId = modelById.get(name);
    if (byRegistryId) {
      orderedModels = [byRegistryId];
    } else {
      const byProvider = models
        .filter((m) => m.provider.toLowerCase() === name.toLowerCase())
        .sort((a, b) => b.priority - a.priority);
      if (byProvider.length > 0) {
        orderedModels = byProvider;
      } else {
        const byModelName = models.filter(
          (m) => m.model === name || m.model.toLowerCase() === name.toLowerCase(),
        );
        orderedModels = byModelName;
      }
    }
  }

  if (orderedModels.length === 0) {
    throw new RouterError(
      'BAD_REQUEST',
      `Invalid model format: '${name}' does not match any profile, provider, or registered model. ` +
        `List available ids with GET /v1/models.`,
      { detail: RouterErrorCode.INVALID_MODEL_FORMAT },
    );
  }

  /* ── Filter to viable candidates ─────────────────────────────────── */
  const candidates: Candidate[] = [];
  for (const m of orderedModels) {
    if (!m.enabled) continue;

    const provider = providerById.get(m.provider);
    if (!provider || !provider.enabled) continue;

    if (restrictProviders && restrictProviders.length > 0) {
      if (!restrictProviders.map((s) => s.toLowerCase()).includes(provider.id.toLowerCase())) continue;
    }

    if (requiredCapabilities.length > 0) {
      const caps = new Set(m.capabilities);
      if (!requiredCapabilities.every((c) => caps.has(c))) continue;
    }

    if (minContextLength !== undefined && m.contextLength < minContextLength) continue;

    const creds = (credsByProvider.get(provider.id) ?? []).filter(
      (c) => c.enabled && health.isAvailable(c.id, now),
    );
    // Every credential cooling down ⇒ this candidate can't serve right now.
    if (creds.length === 0) continue;

    candidates.push({ model: m, provider, credentials: creds });
  }

  if (candidates.length === 0) {
    throw new RouterError(
      'PROVIDER_UNAVAILABLE',
      'No healthy provider is currently available for the requested model',
      { detail: RouterErrorCode.NO_CANDIDATES },
    );
  }

  /* ── Order the ladder ────────────────────────────────────────────── */
  // A profile's order is the operator's explicit intent, so we preserve it and
  // only sink candidates that are visibly unhealthy. Non-profile resolutions
  // sort purely by health then priority.
  const scored = candidates.map((c, idx) => ({
    c,
    idx,
    rank: bestHealthRank(c, health),
  }));

  if (profileUsed) {
    scored.sort((a, b) => {
      // Healthy-vs-degraded matters more than list position; among equally
      // healthy candidates, the operator's ordering wins.
      const aBad = a.rank >= HEALTH_RANK[HealthStatus.RATE_LIMITED] ? 1 : 0;
      const bBad = b.rank >= HEALTH_RANK[HealthStatus.RATE_LIMITED] ? 1 : 0;
      if (aBad !== bBad) return aBad - bBad;
      return a.idx - b.idx;
    });
  } else {
    scored.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.c.model.priority !== b.c.model.priority) return b.c.model.priority - a.c.model.priority;
      return a.idx - b.idx;
    });
  }

  return { candidates: scored.map((s) => s.c), profile: profileUsed };
}

/** The health rank of a candidate's best available credential. */
function bestHealthRank(c: Candidate, health: HealthTracker): number {
  let best = HEALTH_RANK[HealthStatus.DISABLED];
  for (const cred of c.credentials) {
    const st = health.get(cred.id);
    const rank = HEALTH_RANK[st?.status ?? HealthStatus.ONLINE];
    if (rank < best) best = rank;
  }
  return best;
}

/**
 * A model pinned by the client but absent from the registry. Given generous
 * defaults — the upstream will reject it if it truly doesn't exist, and that
 * surfaces as MODEL_UNAVAILABLE rather than a router-side 400.
 */
function ephemeralModel(provider: ProviderEntry, modelName: string): ModelEntry {
  return {
    id: `${provider.id}/${modelName}`,
    provider: provider.id,
    model: modelName,
    displayName: modelName,
    capabilities: ['chat'],
    contextLength: 128_000,
    enabled: true,
    priority: 50,
    costTier: 'standard',
    createdAt: 0,
    updatedAt: 0,
  };
}

/** Does this request carry images? Drives the `vision` capability filter. */
export function detectRequiredCapabilities(messages: unknown[]): Capability[] {
  const caps: Capability[] = [];
  for (const msg of messages) {
    const content = (msg as { content?: unknown })?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const t = (part as { type?: string })?.type;
        if (t === 'image_url' || t === 'image' || t === 'input_image') {
          caps.push('vision');
          return caps;
        }
      }
    }
  }
  return caps;
}
