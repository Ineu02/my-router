import { buildServer, type BuiltServer } from '../../apps/api/src/server.js';
import { startMockUpstream, MOCK_API_KEY, type MockServerHandle } from '../../apps/api/src/mock/server.js';
import type { RouterConfig } from '@router/config';

/**
 * Test harness.
 *
 * Every test gets a real Fastify instance, a real SQLite database and a real
 * HTTP upstream on a real socket — only the *provider* is fake. Nothing here
 * talks to a paid API, and no test can: the only credential in the config map
 * is the mock upstream's, which the local mock is the only thing that accepts.
 *
 * Requests go through `app.inject()` rather than a bound port. That is still the
 * full Fastify pipeline (hooks, auth, serialisation, streaming) but needs no
 * listening socket, so files stay fast and cannot collide on ports. Upstream
 * calls from the router to the mock are genuine sockets.
 */

export const ROUTER_KEY = 'sk-router-test-0000000000000000';
export const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';

/** In-memory config that never reads the developer's real .env. */
export function testConfig(overrides: Partial<RouterConfig> = {}): RouterConfig {
  return {
    nodeEnv: 'test',
    isProduction: false,
    port: 0,
    host: '127.0.0.1',
    logLevel: 'silent',

    bootstrapApiKey: ROUTER_KEY,
    requireApiKey: true,

    adminToken: ADMIN_TOKEN,
    sessionSecret: 'test-session-secret-0123456789abcdefghij',

    databaseUrl: ':memory:',
    databasePath: ':memory:',

    defaultProfile: 'general',
    maxFallbackAttempts: 4,
    // Short budgets: tests must fail fast, and the timeout path is asserted
    // against this number rather than a hardcoded one.
    requestTimeoutMs: 1_500,
    connectTimeoutMs: 1_000,
    globalDeadlineMs: 10_000,
    rotationStrategy: 'health-based',
    retryNetworkErrors: 1,

    healthFailureThreshold: 3,
    healthCooldownBaseMs: 1_000,
    healthMaxCooldownMs: 60_000,
    // Background probing off by default — tests drive probes explicitly so
    // nothing recovers behind their back.
    healthProbeIntervalMs: 0,
    healthSuccessReset: 1,

    rateLimitMax: 1_000,
    rateLimitWindowMs: 60_000,
    maxBodyBytes: 2_097_152,

    corsOrigins: ['*'],

    logRequests: true,
    logPrompts: false,
    logRetentionDays: 30,

    enableMockProvider: false, // the harness registers its own mock rows
    mockProviderPort: 0,

    customProvider: null,

    codexOAuth: null,
    credentialEncKey: 'test-credential-enc-key-0123456789abcdef',

    // Several env names, all resolving to the mock's single key. Credentials
    // dedupe on (provider, keyRef) — correctly, since the same env var on the
    // same provider *is* the same credential — so a test that wants two
    // credentials on one provider needs two names to point at.
    providerKeys: new Map([
      ['MOCK_PROVIDER_API_KEY', MOCK_API_KEY],
      ['MOCK_PROVIDER_API_KEY_2', MOCK_API_KEY],
      ['MOCK_PROVIDER_API_KEY_3', MOCK_API_KEY],
      ['MOCK_PROVIDER_API_KEY_4', MOCK_API_KEY],
    ]),
    providerBaseUrls: new Map(),
    ...overrides,
  };
}

export interface Harness {
  server: BuiltServer;
  upstream: MockServerHandle;
  /**
   * Make the next `count` upstream calls fail this way, whatever model they ask
   * for. Model-name failure modes are per *model*; this is per *call*, which is
   * how a test makes one credential fail and its sibling succeed.
   */
  failNext(mode: '429' | '500' | '401' | '404' | '400' | 'timeout' | 'malformed', count?: number): void;
  /** Advance the harness clock, in ms. Nothing here uses the wall clock. */
  advance(ms: number): void;
  /** Current harness time. */
  now(): number;
  close(): Promise<void>;
}

export interface HarnessOptions {
  config?: Partial<RouterConfig>;
  /**
   * Provider rows to register, in ladder order. Each becomes one provider with
   * one credential and one model, all pointing at the same mock upstream — what
   * differs is the upstream model name, which is how the mock decides whether
   * to succeed or to fail, and how.
   */
  providers?: TestProvider[];
  /** Extra models on existing providers. */
  extraModels?: TestModel[];
  /** Profile ladders, keyed by profile id. Values are router-facing model ids. */
  profiles?: Record<string, string[]>;
  /**
   * Credentials beyond the one each provider gets automatically. Each is given
   * its own key ref (see `testConfig`) so it is a genuinely separate credential
   * — which is what the per-credential health state machine is there for.
   */
  extraCredentials?: Array<{ providerId: string; label: string; priority?: number; weight?: number }>;
}

export interface TestProvider {
  id: string;
  /** Upstream model name — drives the mock's behaviour. Defaults to `mock-fast`. */
  upstreamModel?: string;
  /** Router-facing model id. Defaults to `${id}-model`. */
  modelId?: string;
  priority?: number;
  capabilities?: string[];
  contextLength?: number;
  enabled?: boolean;
}

export interface TestModel {
  id: string;
  providerId: string;
  upstreamModel: string;
  priority?: number;
  capabilities?: string[];
  contextLength?: number;
  enabled?: boolean;
}

const DEFAULT_PROVIDERS: TestProvider[] = [
  { id: 'primary', upstreamModel: 'mock-fast', priority: 100 },
  { id: 'secondary', upstreamModel: 'mock-smart', priority: 90 },
  { id: 'third', upstreamModel: 'mock-backup', priority: 80 },
];

/**
 * Boot a router with a controllable upstream.
 *
 * The clock is injected and frozen: health cooldowns, probe scheduling and
 * latency arithmetic are all driven by `advance()`, so no test sleeps and no
 * test is flaky on a loaded CI box. Real network latency still happens — it
 * just doesn't move the router's clock.
 */
export async function harness(opts: HarnessOptions = {}): Promise<Harness> {
  const upstream = await startMockUpstream(0);

  let clock = 1_700_000_000_000;
  const now = () => clock;

  const server = await buildServer({
    config: testConfig(opts.config),
    databasePath: ':memory:',
    skipMock: true,
    logger: false,
    now,
    bootstrapKey: ROUTER_KEY,
  });

  const { repos } = server;

  // Everything the real seed installed is disabled: a test must see only the
  // ladder it declared, or an unrelated builtin could satisfy a request and
  // quietly invalidate the assertion.
  for (const p of repos.providers.list()) repos.providers.setEnabled(p.id, false);
  for (const m of repos.models.list()) repos.models.setEnabled(m.id, false);

  const providers = opts.providers ?? DEFAULT_PROVIDERS;
  const ladder: string[] = [];

  for (const p of providers) {
    repos.providers.upsert({
      id: p.id,
      displayName: `Test ${p.id}`,
      kind: 'openai-compatible',
      baseUrl: `${upstream.url}/v1`,
      enabled: p.enabled ?? true,
      priority: p.priority ?? 50,
      credentialEnvHint: 'MOCK_PROVIDER_API_KEY',
    });
    repos.providers.setEnabled(p.id, p.enabled ?? true);

    const modelId = p.modelId ?? `${p.id}-model`;
    repos.models.upsert({
      id: modelId,
      provider: p.id,
      model: p.upstreamModel ?? 'mock-fast',
      displayName: modelId,
      capabilities: p.capabilities ?? ['chat', 'tools'],
      contextLength: p.contextLength ?? 32_000,
      enabled: true,
      priority: p.priority ?? 50,
      costTier: 'free',
    });
    repos.models.setEnabled(modelId, true);
    ladder.push(modelId);

    const cred = repos.credentials.upsert({
      providerId: p.id,
      label: `${p.id} key`,
      keyRef: 'MOCK_PROVIDER_API_KEY',
      rawKeyForMask: MOCK_API_KEY,
      priority: 100,
    });
    repos.credentials.setEnabled(cred.id, true);
    server.engine.health.ensure(cred.id, p.id);
  }

  for (const m of opts.extraModels ?? []) {
    repos.models.upsert({
      id: m.id,
      provider: m.providerId,
      model: m.upstreamModel,
      displayName: m.id,
      capabilities: m.capabilities ?? ['chat'],
      contextLength: m.contextLength ?? 32_000,
      enabled: m.enabled ?? true,
      priority: m.priority ?? 50,
      costTier: 'free',
    });
    repos.models.setEnabled(m.id, m.enabled ?? true);
  }

  let nextKeyRef = 2;
  for (const c of opts.extraCredentials ?? []) {
    const cred = repos.credentials.upsert({
      providerId: c.providerId,
      label: c.label,
      keyRef: `MOCK_PROVIDER_API_KEY_${nextKeyRef++}`,
      rawKeyForMask: MOCK_API_KEY,
      priority: c.priority ?? 50,
      weight: c.weight,
    });
    repos.credentials.setEnabled(cred.id, true);
    server.engine.health.ensure(cred.id, c.providerId);
  }

  // Point every profile at the declared ladder unless the test says otherwise,
  // so `model:"auto"` resolves to exactly the providers under test.
  const profiles = opts.profiles ?? {};
  for (const existing of repos.profiles.list()) {
    repos.profiles.setModels(existing.id, profiles[existing.id] ?? ladder);
  }
  for (const [id, models] of Object.entries(profiles)) {
    if (!repos.profiles.get(id)) {
      repos.profiles.upsert({ id, displayName: id, description: `test profile ${id}`, models });
    }
  }

  return {
    server,
    upstream,
    failNext: (mode, count = 1) => {
      upstream.state.fail = mode;
      upstream.state.remaining = count;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    now,
    close: async () => {
      await server.close();
      await upstream.close();
    },
  };
}

/* ── request helpers ─────────────────────────────────────────────────── */

export const authHeaders = {
  authorization: `Bearer ${ROUTER_KEY}`,
  'content-type': 'application/json',
};

export const adminHeaders = { 'x-router-admin-token': ADMIN_TOKEN };

export interface ChatBody {
  model?: string;
  messages?: unknown;
  stream?: boolean;
  router_debug?: boolean;
  [k: string]: unknown;
}

/** POST /v1/chat/completions with router debug metadata on. */
export async function chat(h: Harness, body: ChatBody = {}, headers = authHeaders) {
  const res = await h.server.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers,
    payload: {
      model: 'auto',
      messages: [{ role: 'user', content: 'hello' }],
      router_debug: true,
      ...body,
    },
  });
  return { res, json: parse(res.payload), text: res.payload };
}

/** Attempt trail from a debug response. */
export function trail(json: unknown): Array<{
  provider: string;
  model: string;
  status: string;
  error_class?: string;
  credential_id?: string;
  latency_ms: number;
}> {
  const meta = (json as { _router?: { provider_attempts?: unknown[] } } | null)?._router;
  return (meta?.provider_attempts ?? []) as ReturnType<typeof trail>;
}

export function meta(json: unknown): Record<string, unknown> {
  return ((json as { _router?: Record<string, unknown> } | null)?._router ?? {});
}

/** Parse SSE text into its data payloads, `[DONE]` included as a marker. */
export function sseFrames(text: string): { chunks: unknown[]; done: boolean; raw: string[] } {
  const raw = text
    .split('\n\n')
    .map((f) => f.trim())
    .filter((f) => f.startsWith('data:'))
    .map((f) => f.slice(5).trim());

  const done = raw.includes('[DONE]');
  const chunks = raw.filter((r) => r !== '[DONE]').map((r) => JSON.parse(r) as unknown);
  return { chunks, done, raw };
}

/** Assemble delta content from parsed chunks. */
export function assembleDeltas(chunks: unknown[]): string {
  return chunks
    .map((c) => {
      const choice = (c as { choices?: Array<{ delta?: { content?: string } }> }).choices?.[0];
      return choice?.delta?.content ?? '';
    })
    .join('');
}

function parse(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}
