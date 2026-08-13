import {
  ERROR_POLICY,
  RouterError,
  generateRequestId,
  redactText,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ProviderAttempt,
  type RouterEvent,
  type RouterMetadata,
  type CredentialEntry,
} from '@router/shared';
import {
  AllProvidersFailedError,
  DEFAULT_HEALTH_CONFIG,
  HealthTracker,
  RoundRobinCursor,
  TokenManager,
  OAuthError,
  resolveEndpoints,
  detectRequiredCapabilities,
  executeWithFallback,
  resolveCandidates,
  withTimeout,
  type Candidate,
  type FallbackConfig,
} from '@router/router-core';
import { ProviderRegistry, stripRouterFields, type ProviderStreamResult } from '@router/providers';
import { resolveSecret, type Repositories, type RouterConfig } from '@router/config';
import { EncryptingOAuthStore } from './oauth-store.js';

/**
 * The routing engine.
 *
 * Owns the live health tracker and turns a client request into an upstream
 * call, with resolution → rotation → failover in between. Everything
 * provider-specific stays behind the adapter interface; everything
 * decision-making stays in router-core. This file is the wiring.
 */

export interface RouteRequestInput {
  request: ChatCompletionRequest;
  requestId: string;
  apiKeyId: string | null;
  clientIp: string | null;
  /** Aborted when the client disconnects. */
  signal?: AbortSignal;
}

export interface RouteResult {
  response: ChatCompletionResponse;
  meta: RouterMetadata;
}

export interface StreamRouteResult {
  first: ChatCompletionChunk;
  rest: AsyncIterable<ChatCompletionChunk>;
  meta: RouterMetadata;
}

type EventListener = (e: RouterEvent) => void;

export class RouterEngine {
  readonly health: HealthTracker;
  readonly providers = new ProviderRegistry();
  private cursor = new RoundRobinCursor();
  private listeners = new Set<EventListener>();
  private probeTimer: NodeJS.Timeout | null = null;
  private persistTimer: NodeJS.Timeout | null = null;

  /**
   * Present only when OAuth is configured. Owns access-token refresh +
   * refresh-token rotation for `secret_kind='oauth'` credentials, with
   * single-flight coalescing so concurrent requests can't race a refresh.
   * Env-key credentials never touch it — they resolve synchronously through
   * `resolveSecret`.
   */
  private readonly tokenManager: TokenManager | null;

  constructor(
    private repos: Repositories,
    private config: RouterConfig,
    private now: () => number = () => Date.now(),
  ) {
    // `now` is injected into every HealthTracker call rather than held by it —
    // the tracker stays pure so cooldown ramps are deterministic in tests.
    this.health = new HealthTracker({
      ...DEFAULT_HEALTH_CONFIG,
      failureThreshold: config.healthFailureThreshold,
      cooldownBaseMs: config.healthCooldownBaseMs,
      maxCooldownMs: config.healthMaxCooldownMs,
      successReset: config.healthSuccessReset,
    });

    // Restore health so a credential that was rate-limited at shutdown isn't
    // hammered again the instant we come back up.
    this.health.hydrate(this.repos.health.loadAll());

    for (const cred of this.repos.credentials.list()) {
      this.health.ensure(cred.id, cred.providerId);
      if (!cred.enabled) this.health.setEnabled(cred.id, cred.providerId, false, this.now());
    }

    this.health.onChange((state, previous) => {
      this.emit({
        type: 'health.change',
        credentialId: state.credentialId,
        providerId: state.providerId,
        from: previous,
        to: state.status,
        at: this.now(),
      });
    });

    // OAuth token machinery is optional: only wired when Codex OAuth is
    // configured. The encrypting store keeps the passphrase in this layer —
    // the TokenManager sees plaintext, the DB sees only ciphertext.
    if (this.config.codexOAuth) {
      const oauth = this.config.codexOAuth;
      this.tokenManager = new TokenManager({
        store: new EncryptingOAuthStore(this.repos, this.config.credentialEncKey),
        endpoints: resolveEndpoints({
          issuer: oauth.issuer,
          clientId: oauth.clientId,
          redirectUri: oauth.redirectUri,
        }),
        skewMs: oauth.refreshSkewMs,
        now: this.now,
        // A refresh that fails with invalid_grant means the account has been
        // revoked upstream. Park the credential through the same AUTH policy
        // that env-key auth failures use, so it drops out of rotation and only
        // returns through a fresh reconnect.
        onRefreshFailure: (credId) => {
          const cred = this.repos.credentials.get(credId);
          if (cred) this.health.recordFailure(credId, cred.providerId, 'AUTH', this.now());
        },
      });
    } else {
      this.tokenManager = null;
    }
  }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  start(): void {
    if (this.config.healthProbeIntervalMs > 0) {
      this.probeTimer = setInterval(() => {
        void this.runProbes().catch(() => undefined);
      }, this.config.healthProbeIntervalMs);
      this.probeTimer.unref?.();
    }
    // Health is written back periodically rather than per-request: it is a
    // cache of a live state machine, not the source of truth.
    this.persistTimer = setInterval(() => this.persistHealth(), 15_000);
    this.persistTimer.unref?.();
  }

  stop(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.probeTimer = null;
    this.persistTimer = null;
    this.persistHealth();
  }

  persistHealth(): void {
    try {
      this.repos.health.saveMany(this.health.all());
    } catch {
      /* a failed health write must never take down the request path */
    }
  }

  /* ── events ────────────────────────────────────────────────────────── */

  onEvent(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: RouterEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        /* a broken SSE subscriber must not break routing */
      }
    }
  }

  /* ── resolution ────────────────────────────────────────────────────── */

  resolve(req: ChatCompletionRequest): { candidates: Candidate[]; profile: string | null } {
    const requiredCapabilities = detectRequiredCapabilities(req.messages ?? []);
    return resolveCandidates({
      requested: req.model,
      forceProfile: req.router_profile,
      restrictProviders: req.router_providers,
      requiredCapabilities,
      models: this.repos.models.list(),
      providers: this.repos.providers.list(),
      credentials: this.repos.credentials.list(),
      profiles: this.repos.profiles.list(),
      health: this.health,
      now: this.now(),
      defaultProfile: this.settingDefaultProfile(),
    });
  }

  private settingDefaultProfile(): string {
    return this.repos.settings.get('default_profile') ?? this.config.defaultProfile;
  }

  /**
   * Read a numeric tunable, preferring the operator's stored override over the
   * env default. Read per request, not cached: changing a timeout from the
   * dashboard has to take effect without a restart, and these are cheap
   * prepared-statement reads against a local SQLite page cache.
   */
  private tunable(key: string, fallback: number): number {
    const raw = this.repos.settings.get(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  /** Per-attempt upstream budget, in ms. */
  requestTimeoutMs(): number {
    return this.tunable('request_timeout_ms', this.config.requestTimeoutMs);
  }

  /**
   * The engine's clock.
   *
   * Every health transition is stamped with this rather than with `Date.now()`,
   * so the route layer must read time through it too — otherwise a cooldown set
   * on the injected clock is compared against the wall clock and looks unset.
   */
  nowMs(): number {
    return this.now();
  }

  private fallbackConfig(): FallbackConfig {
    const stored = this.repos.settings.get('rotation_strategy');
    return {
      maxAttempts: this.tunable('max_fallback_attempts', this.config.maxFallbackAttempts),
      globalDeadlineMs: this.tunable('global_deadline_ms', this.config.globalDeadlineMs),
      // Zero is a meaningful value here, so it cannot go through `tunable`.
      retryNetworkErrors: this.retryNetworkErrors(),
      strategy: (stored as FallbackConfig['strategy']) ?? this.config.rotationStrategy,
    };
  }

  private retryNetworkErrors(): number {
    const raw = this.repos.settings.get('retry_network_errors');
    if (raw === null) return this.config.retryNetworkErrors;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : this.config.retryNetworkErrors;
  }

  /* ── non-streaming ─────────────────────────────────────────────────── */

  async route(input: RouteRequestInput): Promise<RouteResult> {
    const { candidates, profile } = this.resolve(input.request);
    this.emitRoute(input.requestId, input.request.model, profile, candidates);

    const upstreamReq = stripRouterFields(input.request as unknown as Record<string, unknown>) as
      unknown as ChatCompletionRequest;

    const result = await executeWithFallback<{ response: ChatCompletionResponse; status: number }>({
      candidates,
      config: this.fallbackConfig(),
      health: this.health,
      cursor: this.cursor,
      attemptTimeoutMs: this.requestTimeoutMs(),
      now: this.now,
      onAttempt: (a) => this.emit({ type: 'request.attempt', requestId: input.requestId, attempt: a }),
      onFallback: (from, to, reason) =>
        this.emit({ type: 'request.fallback', requestId: input.requestId, from, to, reason }),
      onDisableModel: (id, reason) => this.disableModel(id, reason),
      execute: async (ctx) => {
        const call = await this.callOptions(ctx.candidate, ctx.credential, ctx.timeoutMs);
        const adapter = this.adapterFor(ctx.candidate);
        return withTimeout(
          ctx.timeoutMs,
          (signal) =>
            adapter.chat({ ...upstreamReq, model: ctx.candidate.model.model }, { ...call, signal }),
          input.signal,
        );
      },
    });

    const meta = this.buildMeta(input, profile, result.candidate, result.attempts, result.fallbackCount, result.totalLatencyMs);
    const response = { ...result.value.response, model: input.request.model };

    this.logSuccess(input, meta, result.value.response, false);
    this.emit({ type: 'request.end', requestId: input.requestId, status: 'success', latencyMs: meta.total_latency_ms });

    return { response, meta };
  }

  /* ── streaming ─────────────────────────────────────────────────────── */

  /**
   * Failover applies only up to the first token. The adapter peeks the first
   * chunk before returning, so a dead upstream can still be swapped out; once
   * the client's body has started, the HTTP response is committed and a
   * mid-stream death has to be surfaced as an error frame instead.
   */
  async routeStream(input: RouteRequestInput): Promise<StreamRouteResult> {
    const { candidates, profile } = this.resolve(input.request);
    this.emitRoute(input.requestId, input.request.model, profile, candidates);

    const upstreamReq = stripRouterFields(input.request as unknown as Record<string, unknown>) as
      unknown as ChatCompletionRequest;

    const result = await executeWithFallback<ProviderStreamResult>({
      candidates,
      config: this.fallbackConfig(),
      health: this.health,
      cursor: this.cursor,
      attemptTimeoutMs: this.requestTimeoutMs(),
      now: this.now,
      onAttempt: (a) => this.emit({ type: 'request.attempt', requestId: input.requestId, attempt: a }),
      onFallback: (from, to, reason) =>
        this.emit({ type: 'request.fallback', requestId: input.requestId, from, to, reason }),
      onDisableModel: (id, reason) => this.disableModel(id, reason),
      execute: async (ctx) => {
        const call = await this.callOptions(ctx.candidate, ctx.credential, ctx.timeoutMs);
        const adapter = this.adapterFor(ctx.candidate);
        // Only the time-to-first-token is bounded by the attempt timeout; the
        // body may legitimately take much longer than that to finish.
        return withTimeout(
          ctx.timeoutMs,
          (signal) =>
            adapter.stream({ ...upstreamReq, model: ctx.candidate.model.model }, { ...call, signal }),
          input.signal,
        );
      },
    });

    const meta = this.buildMeta(input, profile, result.candidate, result.attempts, result.fallbackCount, result.totalLatencyMs);

    return {
      first: { ...result.value.first, model: input.request.model },
      rest: this.tagStream(result.value.rest, input, meta),
      meta,
    };
  }

  /** Rewrite the upstream model name back to what the client asked for. */
  private async *tagStream(
    source: AsyncIterable<ChatCompletionChunk>,
    input: RouteRequestInput,
    meta: RouterMetadata,
  ): AsyncGenerator<ChatCompletionChunk> {
    let usage: ChatCompletionResponse['usage'] | undefined;
    try {
      for await (const chunk of source) {
        if (chunk.usage) usage = chunk.usage;
        yield { ...chunk, model: input.request.model };
      }
      this.logSuccess(input, meta, usage ? ({ usage }) : undefined, true);
      this.emit({
        type: 'request.end',
        requestId: input.requestId,
        status: 'success',
        latencyMs: this.now() - meta_start(meta),
      });
    } catch (err) {
      // The body is already committed, so this cannot fail over. Record it and
      // let the route layer emit a terminating error frame.
      const routerErr = err instanceof RouterError ? err : new RouterError('MALFORMED_RESPONSE', String(err));
      this.logFailure(input, meta, routerErr, true);
      this.emit({ type: 'request.end', requestId: input.requestId, status: 'error', latencyMs: 0 });
      throw routerErr;
    }
  }

  /* ── health probes ─────────────────────────────────────────────────── */

  /** Slow background recovery: the only path back for AUTH-disabled keys. */
  async runProbes(): Promise<void> {
    // The tracker decides who is due; we only need the rows to call with.
    const due = new Set(this.health.dueForProbe(this.now()).map((s) => s.credentialId));
    const creds = this.repos.credentials.list().filter((c) => c.enabled && due.has(c.id));

    await Promise.all(
      creds.map(async (cred) => {
        const provider = this.repos.providers.get(cred.providerId);
        if (!provider || !provider.enabled) return;

        const model = this.repos.models
          .list()
          .find((m) => m.provider === provider.id && m.enabled);
        const resolved = await this.probeSecret(cred, provider.id);
        if (!resolved) {
          this.health.setEnabled(cred.id, cred.providerId, false, this.now());
          return;
        }

        const adapter = this.providers.ensure(
          provider.id,
          provider.kind,
          model ? [model.model] : [],
          this.repos.providers.extraHeaders(provider.id),
        );

        try {
          const res = await adapter.healthCheck({
            apiKey: resolved.apiKey,
            baseUrl: provider.baseUrl,
            signal: AbortSignal.timeout(this.config.connectTimeoutMs),
            timeoutMs: this.config.connectTimeoutMs,
            model: model?.model,
            headers: resolved.headers,
          });
          this.health.recordProbe(cred.id, provider.id, res.ok, res.latencyMs, this.now());
        } catch {
          this.health.recordProbe(cred.id, provider.id, false, 0, this.now());
        }
      }),
    );

    this.persistHealth();
  }

  /** Test one credential on demand, from the dashboard. */
  async testCredential(credentialId: string): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const cred = this.repos.credentials.get(credentialId);
    if (!cred) return { ok: false, latencyMs: 0, detail: 'Unknown credential' };

    const provider = this.repos.providers.get(cred.providerId);
    if (!provider) return { ok: false, latencyMs: 0, detail: 'Unknown provider' };

    const resolved = await this.probeSecret(cred, provider.id);
    if (!resolved) {
      const detail =
        cred.secretKind === 'oauth'
          ? 'No valid OAuth token — reconnect the account'
          : `Environment variable ${cred.keyRef} is not set`;
      return { ok: false, latencyMs: 0, detail };
    }

    const model = this.repos.models.list().find((m) => m.provider === provider.id && m.enabled);
    const adapter = this.providers.ensure(
      provider.id,
      provider.kind,
      model ? [model.model] : [],
      this.repos.providers.extraHeaders(provider.id),
    );

    try {
      const res = await adapter.healthCheck({
        apiKey: resolved.apiKey,
        baseUrl: provider.baseUrl,
        signal: AbortSignal.timeout(this.config.connectTimeoutMs),
        timeoutMs: this.config.connectTimeoutMs,
        model: model?.model,
        headers: resolved.headers,
      });
      this.health.recordProbe(cred.id, provider.id, res.ok, res.latencyMs, this.now());
      this.persistHealth();
      return { ok: res.ok, latencyMs: res.latencyMs, detail: res.detail ? redactText(res.detail) : undefined };
    } catch (err) {
      this.health.recordProbe(cred.id, provider.id, false, 0, this.now());
      return { ok: false, latencyMs: 0, detail: redactText(String(err)) };
    }
  }

  /* ── internals ─────────────────────────────────────────────────────── */

  private adapterFor(candidate: Candidate) {
    return this.providers.ensure(
      candidate.provider.id,
      candidate.provider.kind,
      [candidate.model.model],
      this.repos.providers.extraHeaders(candidate.provider.id),
    );
  }

  /**
   * Resolve a live bearer + headers for a health probe against one credential,
   * or null if none can be produced (env var unset, or OAuth refresh failed).
   * Mirrors the two credential kinds handled in `callOptions`, but never throws
   * — a probe just wants a token or an "unusable" answer.
   */
  private async probeSecret(
    cred: CredentialEntry,
    providerId: string,
  ): Promise<{ apiKey: string; headers: Record<string, string> } | null> {
    const headers: Record<string, string> = { ...this.repos.providers.extraHeaders(providerId) };
    if (cred.secretKind === 'oauth') {
      if (!this.tokenManager) return null;
      try {
        const { accessToken, accountId } = await this.tokenManager.getAccessToken(cred.id);
        if (accountId) headers['chatgpt-account-id'] = accountId;
        return { apiKey: accessToken, headers };
      } catch {
        return null;
      }
    }
    const secret = resolveSecret(cred.keyRef, this.config);
    return secret ? { apiKey: secret, headers } : null;
  }

  /**
   * Resolve a credential reference to a live set of call options.
   *
   * Two credential kinds meet here. Env-key credentials resolve synchronously
   * through `resolveSecret`, reading the in-memory config map — never the
   * database. OAuth credentials go through the {@link TokenManager}, which
   * hands back a fresh bearer (refreshing + rotating if needed) plus the
   * account id the codex adapter promotes to the `chatgpt-account-id` header.
   * This is the only place in the request path that touches key material.
   */
  private async callOptions(candidate: Candidate, credential: CredentialEntry, timeoutMs: number) {
    const baseHeaders = this.repos.providers.extraHeaders(candidate.provider.id);

    if (credential.secretKind === 'oauth') {
      if (!this.tokenManager) {
        throw new RouterError('AUTH', `OAuth is not configured for ${candidate.provider.id}`, {
          provider: candidate.provider.id,
        });
      }
      try {
        const { accessToken, accountId } = await this.tokenManager.getAccessToken(credential.id);
        const headers = { ...baseHeaders };
        if (accountId) headers['chatgpt-account-id'] = accountId;
        return {
          model: candidate.model.model,
          apiKey: accessToken,
          baseUrl: candidate.provider.baseUrl,
          timeoutMs,
          headers,
        };
      } catch (err) {
        // A refresh failure is an auth failure from the ladder's point of view:
        // fail over to the next credential rather than crashing the request.
        if (err instanceof OAuthError) {
          throw new RouterError('AUTH', `OAuth token unavailable for ${candidate.provider.id}: ${err.kind}`, {
            provider: candidate.provider.id,
          });
        }
        throw err;
      }
    }

    const apiKey = resolveSecret(credential.keyRef, this.config);
    if (!apiKey) {
      throw new RouterError('AUTH', `No credential available for ${candidate.provider.id}`, {
        provider: candidate.provider.id,
      });
    }
    return {
      model: candidate.model.model,
      apiKey,
      baseUrl: candidate.provider.baseUrl,
      timeoutMs,
      headers: baseHeaders,
    };
  }

  private disableModel(modelId: string, reason: string): void {
    const model = this.repos.models.get(modelId);
    if (!model || !model.enabled) return;
    this.repos.models.setEnabled(modelId, false);
    this.emit({ type: 'model.disabled', modelId, reason, at: this.now() });
  }

  private emitRoute(
    requestId: string,
    requested: string,
    profile: string | null,
    candidates: Candidate[],
  ): void {
    this.emit({
      type: 'request.route',
      requestId,
      requestedModel: requested,
      profile,
      ladder: candidates.map((c) => `${c.provider.id}/${c.model.model}`),
      at: this.now(),
    });
  }

  private buildMeta(
    input: RouteRequestInput,
    profile: string | null,
    candidate: Candidate,
    attempts: ProviderAttempt[],
    fallbackCount: number,
    latencyMs: number,
  ): RouterMetadata {
    return {
      request_id: input.requestId,
      requested_model: input.request.model,
      resolved_profile: profile ?? undefined,
      selected_provider: candidate.provider.id,
      selected_model: candidate.model.model,
      fallback_count: fallbackCount,
      total_latency_ms: latencyMs,
      provider_attempts: attempts,
      started_at: this.now() - latencyMs,
    };
  }

  logSuccess(
    input: RouteRequestInput,
    meta: RouterMetadata,
    response: Pick<ChatCompletionResponse, 'usage'> | undefined,
    streamed: boolean,
  ): void {
    if (!this.config.logRequests) return;
    this.repos.logs.insert({
      requestId: meta.request_id,
      timestamp: this.now(),
      requestedModel: meta.requested_model,
      resolvedProfile: meta.resolved_profile ?? null,
      selectedProvider: meta.selected_provider,
      selectedModel: meta.selected_model,
      status: 'success',
      httpStatus: 200,
      latencyMs: meta.total_latency_ms,
      fallbackCount: meta.fallback_count,
      promptTokens: response?.usage?.prompt_tokens ?? null,
      completionTokens: response?.usage?.completion_tokens ?? null,
      totalTokens: response?.usage?.total_tokens ?? null,
      streamed,
      errorClass: null,
      errorMessage: null,
      attempts: JSON.stringify(meta.provider_attempts),
      apiKeyId: input.apiKeyId,
      clientIp: input.clientIp,
    });
  }

  logFailure(
    input: RouteRequestInput,
    meta: Partial<RouterMetadata>,
    err: RouterError,
    streamed: boolean,
  ): void {
    if (!this.config.logRequests) return;
    const attempts =
      err instanceof AllProvidersFailedError ? err.attempts : meta.provider_attempts ?? [];
    this.repos.logs.insert({
      requestId: meta.request_id ?? input.requestId,
      timestamp: this.now(),
      requestedModel: input.request.model,
      resolvedProfile: meta.resolved_profile ?? null,
      selectedProvider: meta.selected_provider ?? attempts[attempts.length - 1]?.provider ?? null,
      selectedModel: meta.selected_model ?? attempts[attempts.length - 1]?.model ?? null,
      status: 'error',
      httpStatus: ERROR_POLICY[err.errorClass].clientStatus,
      latencyMs: meta.total_latency_ms ?? 0,
      fallbackCount: Math.max(0, attempts.length - 1),
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      streamed,
      errorClass: err.errorClass,
      // Upstreams occasionally echo the key back in an error string.
      errorMessage: redactText(err.message).slice(0, 500),
      attempts: JSON.stringify(attempts),
      apiKeyId: input.apiKeyId,
      clientIp: input.clientIp,
    });
  }

  newRequestId(): string {
    return generateRequestId('req');
  }
}

function meta_start(meta: RouterMetadata): number {
  return meta.started_at ?? Date.now();
}
