import { z } from 'zod';
import type { ProviderAttempt } from './openai.js';

/* ═══════════════════════════════════════════════════════════════════
   Health — tracked per CREDENTIAL, not per provider, so one exhausted
   account never condemns its siblings.
   ═══════════════════════════════════════════════════════════════════ */

export const HealthStatus = {
  ONLINE: 'ONLINE',
  DEGRADED: 'DEGRADED',
  RATE_LIMITED: 'RATE_LIMITED',
  OFFLINE: 'OFFLINE',
  DISABLED: 'DISABLED',
} as const;

export type HealthStatus = (typeof HealthStatus)[keyof typeof HealthStatus];

/** Statuses eligible to serve traffic right now (subject to cooldown). */
export const SERVEABLE_STATUSES: HealthStatus[] = ['ONLINE', 'DEGRADED'];

/** Ordering preference — lower sorts first. */
export const HEALTH_RANK: Record<HealthStatus, number> = {
  ONLINE: 0,
  DEGRADED: 1,
  RATE_LIMITED: 2,
  OFFLINE: 3,
  DISABLED: 4,
};

export interface HealthState {
  /** Credential this state belongs to. */
  credentialId: string;
  providerId: string;
  status: HealthStatus;
  /** Consecutive failures since the last success. */
  consecutiveFailures: number;
  totalRequests: number;
  totalSuccesses: number;
  totalFailures: number;
  totalTimeouts: number;
  totalRateLimits: number;
  /** Epoch ms; requests are refused until this passes. */
  cooldownUntil: number | null;
  /** How many cooldowns in a row — drives exponential backoff. */
  cooldownLevel: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastErrorClass: string | null;
  /** Rolling latency samples (ms) for p50/p95. */
  latencySamples: number[];
}

export interface HealthSnapshot {
  credentialId: string;
  providerId: string;
  status: HealthStatus;
  successRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  totalRequests: number;
  totalFailures: number;
  totalTimeouts: number;
  consecutiveFailures: number;
  cooldownUntil: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastErrorClass: string | null;
}

/* ═══════════════════════════════════════════════════════════════════
   Model registry
   ═══════════════════════════════════════════════════════════════════ */

export const Capability = {
  CHAT: 'chat',
  VISION: 'vision',
  TOOLS: 'tools',
  REASONING: 'reasoning',
  EMBEDDING: 'embedding',
  IMAGE: 'image',
  TTS: 'tts',
  STT: 'stt',
  WEB: 'web',
} as const;

export type Capability = (typeof Capability)[keyof typeof Capability];

export const CostTier = {
  FREE: 'free',
  CHEAP: 'cheap',
  STANDARD: 'standard',
  PREMIUM: 'premium',
} as const;

export type CostTier = (typeof CostTier)[keyof typeof CostTier];

export interface ModelEntry {
  /** Registry id, e.g. "gemini-main". Unique. */
  id: string;
  /** Provider this model belongs to. */
  provider: string;
  /** The id sent upstream, e.g. "gemini-2.0-flash". */
  model: string;
  displayName: string;
  capabilities: Capability[];
  contextLength: number;
  maxOutputTokens?: number;
  enabled: boolean;
  /** Higher wins when ordering candidates. */
  priority: number;
  costTier: CostTier;
  createdAt: number;
  updatedAt: number;
}

export const ModelEntrySchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  displayName: z.string().min(1),
  capabilities: z.array(z.string()).default(['chat']),
  contextLength: z.number().int().positive().default(128_000),
  maxOutputTokens: z.number().int().positive().optional(),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(50),
  costTier: z.enum(['free', 'cheap', 'standard', 'premium']).default('standard'),
});

/* ═══════════════════════════════════════════════════════════════════
   Providers & credentials
   ═══════════════════════════════════════════════════════════════════ */

/** Wire protocol an adapter speaks. */
export const ProviderKind = {
  OPENAI_COMPATIBLE: 'openai-compatible',
  ANTHROPIC: 'anthropic',
  GEMINI: 'gemini',
} as const;

export type ProviderKind = (typeof ProviderKind)[keyof typeof ProviderKind];

export interface ProviderEntry {
  id: string;
  displayName: string;
  kind: ProviderKind;
  baseUrl: string;
  enabled: boolean;
  priority: number;
  /** Env var the credential was loaded from — for operator display only. */
  credentialEnvHint?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * A single account/key for a provider.
 *
 * NOTE: the key material itself lives ONLY in the server-side store and is
 * never included in this shape when it crosses an API boundary. `keyRef` is
 * an opaque handle; `maskedKey` is display-only ("sk-…4f2a").
 */
export interface CredentialEntry {
  id: string;
  providerId: string;
  label: string;
  keyRef: string;
  maskedKey: string;
  enabled: boolean;
  priority: number;
  weight: number;
  createdAt: number;
}

/* ═══════════════════════════════════════════════════════════════════
   Routing profiles
   ═══════════════════════════════════════════════════════════════════ */

export interface RoutingProfile {
  /** "auto" | "coding" | "cheap" | ... — used directly as a model name. */
  id: string;
  displayName: string;
  description: string;
  /** Ordered model registry ids. Position 0 is tried first. */
  models: string[];
  enabled: boolean;
  updatedAt: number;
}

export const RotationStrategy = {
  PRIORITY: 'priority',
  ROUND_ROBIN: 'round-robin',
  LEAST_FAILURES: 'least-failures',
  HEALTH_BASED: 'health-based',
  WEIGHTED: 'weighted',
} as const;

export type RotationStrategy = (typeof RotationStrategy)[keyof typeof RotationStrategy];

/* ═══════════════════════════════════════════════════════════════════
   Router API keys (client auth)
   ═══════════════════════════════════════════════════════════════════ */

export interface RouterApiKey {
  id: string;
  name: string;
  /** SHA-256 of the key. The raw key is shown exactly once, at creation. */
  keyHash: string;
  keyPrefix: string;
  maskedKey: string;
  enabled: boolean;
  revokedAt: number | null;
  /** Optional cap on total requests. null = unlimited. */
  usageLimit: number | null;
  usageCount: number;
  lastUsedAt: number | null;
  createdAt: number;
}

/* ═══════════════════════════════════════════════════════════════════
   Request logs
   ═══════════════════════════════════════════════════════════════════ */

export interface RequestLogEntry {
  id: string;
  requestId: string;
  timestamp: number;
  requestedModel: string;
  resolvedProfile: string | null;
  selectedProvider: string | null;
  selectedModel: string | null;
  status: 'success' | 'error';
  httpStatus: number;
  latencyMs: number;
  fallbackCount: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  streamed: boolean;
  errorClass: string | null;
  errorMessage: string | null;
  /** JSON-serialised ProviderAttempt[]. */
  attempts: string;
  apiKeyId: string | null;
  clientIp: string | null;
}

/* ═══════════════════════════════════════════════════════════════════
   Dashboard aggregates
   ═══════════════════════════════════════════════════════════════════ */

export interface DashboardStats {
  totalRequests: number;
  successRate: number;
  activeProviders: number;
  totalProviders: number;
  avgLatencyMs: number;
  failoverEvents: number;
  currentProfile: string;
  requestsLast24h: number;
  streamingRequests: number;
  totalTokens: number;
}

export interface ProviderStatusView {
  id: string;
  displayName: string;
  kind: ProviderKind;
  enabled: boolean;
  priority: number;
  status: HealthStatus;
  modelCount: number;
  credentialCount: number;
  avgLatencyMs: number;
  successRate: number;
  totalRequests: number;
  totalFailures: number;
  lastSuccessAt: number | null;
  /** Per-credential health, credentials identified by id/label only. */
  credentials: Array<{
    id: string;
    label: string;
    maskedKey: string;
    enabled: boolean;
    health: HealthSnapshot | null;
  }>;
}

/* ═══════════════════════════════════════════════════════════════════
   Topology — the graph the 3D scene renders: CLIENT → ROUTER → PROVIDERS.

   Every field maps to a visual property: `status` drives node colour,
   `priority` its size, `latencyMs` its ring, `share` the edge weight,
   `ladderRank`/`rank` the failover ordering. The dashboard reuses these
   types verbatim rather than restating the shape client-side.
   ═══════════════════════════════════════════════════════════════════ */

export interface TopologyRouter {
  id: string;
  profile: string;
  totalRequests: number;
  providers: number;
}

export interface TopologyNode {
  id: string;
  label: string;
  status: HealthStatus;
  enabled: boolean;
  priority: number;
  latencyMs: number;
  successRate: number;
  requests: number;
  credentials: number;
  models: number;
  /** Position in the active profile's ladder, or null if not on it. */
  ladderRank: number | null;
}

export interface TopologyEdge {
  /** Always the router node id for now — the graph is a star. */
  from: string;
  to: string;
  /** Fraction of recent traffic this edge carried, 0..1. */
  share: number;
  active: boolean;
  rank: number | null;
}

export interface TopologyView {
  router: TopologyRouter;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

/**
 * Server→client SSE event pushed to the dashboard.
 *
 * These drive the 3D topology directly: `request.route` supplies the ladder to
 * light up, `request.attempt` and `request.fallback` supply the pulse and its
 * deflection, `health.change` recolours a node.
 */
export type RouterEvent =
  | { type: 'request.start'; requestId: string; model: string; at: number }
  | {
      type: 'request.route';
      requestId: string;
      requestedModel: string;
      profile: string | null;
      /** Ordered "provider/model" ladder that will be walked. */
      ladder: string[];
      at: number;
    }
  | { type: 'request.attempt'; requestId: string; attempt: ProviderAttempt }
  | {
      type: 'request.fallback';
      requestId: string;
      from: string;
      to: string;
      reason: string;
    }
  | {
      type: 'request.end';
      requestId: string;
      status: 'success' | 'error';
      latencyMs: number;
    }
  | {
      type: 'health.change';
      providerId: string;
      credentialId: string;
      from: HealthStatus;
      to: HealthStatus;
      at: number;
    }
  | { type: 'model.disabled'; modelId: string; reason: string; at: number }
  | { type: 'stats'; stats: DashboardStats; at: number };
