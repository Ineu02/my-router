import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ChatCompletionRequestSchema,
  AnthropicRequestSchema,
  RouterError,
  RouterErrorCode,
  type AnthropicRequest,
  type AnthropicResponse,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ModelListEntry,
  type RouterMetadata,
} from '@router/shared';
import { AllProvidersFailedError } from '@router/router-core';
import { SSE_DONE } from '@router/providers';
import type { Repositories, RouterConfig } from '@router/config';
import type { RouterEngine } from './engine.js';
import { clientIp, sendRouterError } from './auth.js';

/**
 * The public API surface — the one endpoint everything points at.
 *
 *   GET  /health              liveness
 *   GET  /api/health          liveness (reference-compatible shape)
 *   GET  /v1/models           chat models (default)
 *   GET  /v1/models/:cap      capability-scoped listing
 *   GET  /v1/models/info      per-model metadata
 *   POST /v1/chat/completions OpenAI shape
 *   POST /v1/messages         Anthropic shape
 */

export interface RouteDeps {
  engine: RouterEngine;
  repos: Repositories;
  config: RouterConfig;
  startedAt: number;
}

export function registerPublicRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { engine, repos } = deps;

  /* ── health ────────────────────────────────────────────────────────── */

  const healthPayload = () => {
    const providers = repos.providers.list();
    const credentials = repos.credentials.list().filter((c) => c.enabled);
    const healthy = credentials.filter((c) => engine.health.isAvailable(c.id, Date.now()));
    return {
      ok: true,
      status: healthy.length > 0 ? 'healthy' : credentials.length > 0 ? 'degraded' : 'no_credentials',
      uptime_s: Math.round((Date.now() - deps.startedAt) / 1000),
      providers: {
        total: providers.length,
        enabled: providers.filter((p) => p.enabled).length,
      },
      credentials: { total: credentials.length, available: healthy.length },
      models: {
        total: repos.models.list().length,
        enabled: repos.models.listEnabled().length,
      },
      version: '0.1.0',
    };
  };

  // No auth: this is a liveness probe, and it exposes no configuration.
  app.get('/health', async () => healthPayload());
  app.get('/api/health', async () => healthPayload());

  /* ── models ────────────────────────────────────────────────────────── */

  /**
   * The client-facing model listing.
   *
   * Only models the router will actually attempt appear here: a disabled model,
   * or one whose provider is disabled, is omitted rather than advertised with a
   * `disabled` status. An OpenAI SDK populates its model picker from this
   * response, so listing something the router would reject is a trap. The admin
   * API (`/api/admin/models`) is where disabled rows are still visible.
   *
   * `cooling_down` entries ARE listed: that state is temporary by definition,
   * other credentials on the same provider may be fine, and the cooldown will
   * have expired by the time many clients get around to using the id.
   */
  const listModels = (capability: string | null): ModelListEntry[] => {
    const providers = new Map(repos.providers.list().map((p) => [p.id, p]));
    const creds = repos.credentials.list();
    const now = Date.now();

    const entries: ModelListEntry[] = [];

    for (const m of repos.models.list()) {
      const provider = providers.get(m.provider);
      if (!provider) continue;
      if (!m.enabled || !provider.enabled) continue;
      if (capability && !m.capabilities.includes(capability as never)) continue;

      const providerCreds = creds.filter((c) => c.providerId === m.provider && c.enabled);
      const available = providerCreds.some((c) => engine.health.isAvailable(c.id, now));
      const status = available ? 'available' : 'cooling_down';

      entries.push({
        id: m.id,
        object: 'model',
        created: Math.floor(m.createdAt / 1000),
        owned_by: m.provider,
        context_length: m.contextLength,
        capabilities: m.capabilities,
        status,
      });
      // Also advertise the provider-prefixed form so clients can pin directly.
      entries.push({
        id: `${m.provider}/${m.model}`,
        object: 'model',
        created: Math.floor(m.createdAt / 1000),
        owned_by: m.provider,
        context_length: m.contextLength,
        capabilities: m.capabilities,
        status,
      });
    }

    // Profiles are addressable as model names — that is the whole point of
    // `model: "auto"`, and it means an OpenAI SDK's model picker shows them.
    // An empty ladder is omitted for the same reason a disabled model is: the
    // router could not serve it if a client picked it.
    if (!capability || capability === 'chat') {
      for (const p of repos.profiles.list()) {
        if (!p.enabled || p.models.length === 0) continue;
        entries.unshift({
          id: p.id,
          object: 'model',
          created: Math.floor(p.updatedAt / 1000),
          owned_by: 'router',
          capabilities: ['chat'],
          status: 'available',
        });
      }
    }

    return entries;
  };

  app.get('/v1/models', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return { object: 'list', data: listModels('chat') };
  });

  app.get('/v1/models/all', async () => ({ object: 'list', data: listModels(null) }));

  app.get<{ Querystring: { id?: string } }>('/v1/models/info', async (req, reply) => {
    const id = req.query.id;
    if (!id) {
      return sendRouterError(
        reply,
        new RouterError('BAD_REQUEST', 'Query parameter `id` is required.'),
      );
    }

    const profile = repos.profiles.list().find((p) => p.id === id);
    if (profile) {
      return {
        id: profile.id,
        object: 'model',
        type: 'profile',
        display_name: profile.displayName,
        description: profile.description,
        ladder: profile.models,
        enabled: profile.enabled,
      };
    }

    const model =
      repos.models.get(id) ??
      repos.models.list().find((m) => `${m.provider}/${m.model}` === id || m.model === id);

    if (!model) {
      return sendRouterError(reply, new RouterError('BAD_REQUEST', `Unknown model '${id}'.`));
    }

    return {
      id: model.id,
      object: 'model',
      type: 'model',
      owned_by: model.provider,
      display_name: model.displayName,
      upstream_model: model.model,
      contextWindow: model.contextLength,
      max_output_tokens: model.maxOutputTokens ?? null,
      capabilities: model.capabilities,
      cost_tier: model.costTier,
      priority: model.priority,
      enabled: model.enabled,
    };
  });

  // Capability-scoped listings, e.g. /v1/models/vision.
  app.get<{ Params: { capability: string } }>('/v1/models/:capability', async (req, reply) => {
    const cap = req.params.capability;
    const known = ['chat', 'vision', 'tools', 'reasoning', 'embedding', 'image', 'tts', 'stt', 'web'];
    if (!known.includes(cap)) {
      return sendRouterError(
        reply,
        new RouterError('BAD_REQUEST', `Unknown capability '${cap}'. Known: ${known.join(', ')}.`),
      );
    }
    return { object: 'list', data: listModels(cap) };
  });

  /* ── chat completions ──────────────────────────────────────────────── */

  app.post('/v1/chat/completions', async (req, reply) => {
    const requestId = req.requestId;
    const parsed = ChatCompletionRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      return sendRouterError(
        reply,
        new RouterError('BAD_REQUEST', `Invalid request: ${detail}`),
        requestId,
      );
    }

    const request = parsed.data;
    const input = {
      request,
      requestId,
      apiKeyId: req.routerKey?.id ?? null,
      clientIp: clientIp(req),
      signal: abortSignalFor(req),
    };

    if (req.routerKey) repos.routerKeys.recordUsage(req.routerKey.id);

    if (request.stream) {
      return streamChat(reply, deps, input, requestId, request.router_debug === true);
    }

    try {
      const { response, meta } = await engine.route(input);
      reply.header('x-request-id', requestId);
      reply.header('x-router-provider', meta.selected_provider);
      reply.header('x-router-model', meta.selected_model);
      reply.header('x-router-fallbacks', String(meta.fallback_count));

      if (request.router_debug) {
        return reply.send({ ...response, _router: publicMeta(meta) });
      }
      return reply.send(response);
    } catch (err) {
      return handleRouteError(reply, deps, input, err, requestId, false);
    }
  });

  /* ── Anthropic-shaped surface ──────────────────────────────────────── */

  app.post('/v1/messages', async (req, reply) => {
    const requestId = req.requestId;
    const parsed = AnthropicRequestSchema.safeParse(req.body);

    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
        .join('; ');
      return sendRouterError(
        reply,
        new RouterError('BAD_REQUEST', `Invalid request: ${detail}`),
        requestId,
      );
    }

    const anthropicReq = parsed.data;
    const request = anthropicToOpenAI(anthropicReq);
    const input = {
      request,
      requestId,
      apiKeyId: req.routerKey?.id ?? null,
      clientIp: clientIp(req),
      signal: abortSignalFor(req),
    };

    if (req.routerKey) repos.routerKeys.recordUsage(req.routerKey.id);

    if (anthropicReq.stream) {
      return streamAnthropic(reply, deps, input, requestId);
    }

    try {
      const { response, meta } = await engine.route(input);
      reply.header('x-request-id', requestId);
      reply.header('x-router-provider', meta.selected_provider);
      return reply.send(openAIToAnthropic(response, anthropicReq.model));
    } catch (err) {
      return handleRouteError(reply, deps, input, err, requestId, false);
    }
  });
}

/* ── streaming ─────────────────────────────────────────────────────────── */

/**
 * SSE with the buffer-first-token rule.
 *
 * `engine.routeStream` does not resolve until the first content chunk has
 * arrived, so everything up to that point can still fail over. Only then do we
 * write headers — after which the response is committed and a mid-stream
 * failure has to be reported as a terminating error frame instead.
 */
async function streamChat(
  reply: FastifyReply,
  deps: RouteDeps,
  input: Parameters<RouterEngine['routeStream']>[0],
  requestId: string,
  debug: boolean,
): Promise<void> {
  let meta: RouterMetadata;
  let first: ChatCompletionChunk;
  let rest: AsyncIterable<ChatCompletionChunk>;

  try {
    const result = await deps.engine.routeStream(input);
    meta = result.meta;
    first = result.first;
    rest = result.rest;
  } catch (err) {
    // Nothing written yet — a normal JSON error is still possible.
    await handleRouteError(reply, deps, input, err, requestId, true);
    return;
  }

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-request-id': requestId,
    'x-router-provider': meta.selected_provider,
    'x-router-model': meta.selected_model,
    'x-router-fallbacks': String(meta.fallback_count),
  });

  const write = (chunk: unknown) => {
    if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  write(debug ? { ...first, _router: publicMeta(meta) } : first);

  try {
    for await (const chunk of rest) write(chunk);
    if (!reply.raw.writableEnded) {
      reply.raw.write(SSE_DONE);
      reply.raw.end();
    }
  } catch (err) {
    // Committed response: the only honest option is a terminating error frame
    // followed by [DONE], so the client sees a failure rather than a silent
    // truncation it might mistake for a complete answer.
    const routerErr = err instanceof RouterError ? err : new RouterError('MALFORMED_RESPONSE', String(err));
    if (!reply.raw.writableEnded) {
      reply.raw.write(
        `data: ${JSON.stringify({
          ...routerErr.toClientJSON(),
          _router: { request_id: requestId, interrupted: true },
        })}\n\n`,
      );
      reply.raw.write(SSE_DONE);
      reply.raw.end();
    }
  }
}

/** Same rule, re-framed into Anthropic's typed event stream. */
async function streamAnthropic(
  reply: FastifyReply,
  deps: RouteDeps,
  input: Parameters<RouterEngine['routeStream']>[0],
  requestId: string,
): Promise<void> {
  let meta: RouterMetadata;
  let first: ChatCompletionChunk;
  let rest: AsyncIterable<ChatCompletionChunk>;

  try {
    const result = await deps.engine.routeStream(input);
    meta = result.meta;
    first = result.first;
    rest = result.rest;
  } catch (err) {
    await handleRouteError(reply, deps, input, err, requestId, true);
    return;
  }

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-request-id': requestId,
    'x-router-provider': meta.selected_provider,
  });

  const event = (type: string, data: unknown) => {
    if (!reply.raw.writableEnded) {
      reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  const msgId = `msg_${requestId.replace(/[^a-zA-Z0-9]/g, '')}`;
  event('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: input.request.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  event('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });

  const emitDelta = (chunk: ChatCompletionChunk) => {
    const text = chunk.choices?.[0]?.delta?.content;
    if (text) {
      event('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      });
    }
  };

  emitDelta(first);

  try {
    let stopReason = 'end_turn';
    let outputTokens = 0;
    for await (const chunk of rest) {
      emitDelta(chunk);
      const fr = chunk.choices?.[0]?.finish_reason;
      if (fr) stopReason = fr === 'length' ? 'max_tokens' : fr === 'tool_calls' ? 'tool_use' : 'end_turn';
      if (chunk.usage?.completion_tokens) outputTokens = chunk.usage.completion_tokens;
    }
    event('content_block_stop', { type: 'content_block_stop', index: 0 });
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    });
    event('message_stop', { type: 'message_stop' });
    reply.raw.end();
  } catch (err) {
    const routerErr = err instanceof RouterError ? err : new RouterError('MALFORMED_RESPONSE', String(err));
    event('error', {
      type: 'error',
      error: { type: 'api_error', message: routerErr.message },
    });
    if (!reply.raw.writableEnded) reply.raw.end();
  }
}

/* ── errors ────────────────────────────────────────────────────────────── */

async function handleRouteError(
  reply: FastifyReply,
  deps: RouteDeps,
  input: Parameters<RouterEngine['route']>[0],
  err: unknown,
  requestId: string,
  streamed: boolean,
): Promise<FastifyReply> {
  const routerErr =
    err instanceof RouterError ? err : new RouterError('UNKNOWN', err instanceof Error ? err.message : String(err));

  deps.engine.logFailure(input, { request_id: requestId }, routerErr, streamed);

  if (routerErr instanceof AllProvidersFailedError) {
    // Total exhaustion is a 503 with a Retry-After the client can act on,
    // plus the attempt trail so the failure is diagnosable.
    const retryAfter = routerErr.soonestRetryAfterSec ?? 30;
    reply.header('retry-after', String(retryAfter));
    reply.header('x-request-id', requestId);
    return reply.code(503).send({
      error: {
        message: routerErr.message,
        type: 'api_error',
        code: RouterErrorCode.ALL_PROVIDERS_UNAVAILABLE,
        param: null,
      },
      _router: {
        request_id: requestId,
        provider_attempts: routerErr.attempts,
        retry_after_s: retryAfter,
      },
    });
  }

  // Every candidate was filtered out before the ladder even started —
  // typically because all credentials are cooling down. That is the same
  // "come back later" condition as total exhaustion, so it gets the same
  // actionable Retry-After, derived from the soonest cooldown to expire.
  if (routerErr.detail === RouterErrorCode.NO_CANDIDATES) {
    const retryAfter = soonestCooldownSec(deps) ?? 30;
    reply.header('retry-after', String(retryAfter));
    reply.header('x-request-id', requestId);
    return reply.code(503).send({
      error: {
        message: routerErr.message,
        type: 'api_error',
        code: RouterErrorCode.NO_CANDIDATES,
        param: null,
      },
      _router: { request_id: requestId, provider_attempts: [], retry_after_s: retryAfter },
    });
  }

  // A terminal failure — a 400 the client must fix — carries the attempts made
  // before the ladder gave up. Error responses always include the trail (the
  // 503 paths above do too): when something failed, the operator needs to see
  // which provider did it, and there is no prompt content in an attempt record.
  if (routerErr.attempts && routerErr.attempts.length > 0) {
    return sendRouterError(reply, routerErr, requestId, {
      _router: { request_id: requestId, provider_attempts: routerErr.attempts },
    });
  }

  return sendRouterError(reply, routerErr, requestId);
}

/* ── helpers ───────────────────────────────────────────────────────────── */

/** Seconds until the first credential leaves cooldown, if any is cooling. */
function soonestCooldownSec(deps: RouteDeps): number | null {
  // The engine's clock, not the wall clock: cooldowns are stamped with the
  // injected `now`, and comparing them against `Date.now()` would report every
  // cooldown as already expired wherever the two differ.
  const now = deps.engine.nowMs();
  let soonest = Infinity;
  for (const s of deps.engine.health.all()) {
    if (s.cooldownUntil && s.cooldownUntil > now) soonest = Math.min(soonest, s.cooldownUntil);
  }
  if (soonest === Infinity) return null;
  return Math.max(1, Math.ceil((soonest - now) / 1000));
}

/** Metadata is already credential-safe (id + label only); strip timing internals. */
function publicMeta(meta: RouterMetadata): RouterMetadata {
  const { started_at: _started, ...rest } = meta;
  return rest;
}

/** Cancel the upstream call when the client hangs up. */
function abortSignalFor(req: FastifyRequest): AbortSignal {
  const controller = new AbortController();
  req.raw.on('close', () => {
    if (!req.raw.readableEnded || !req.raw.complete) controller.abort(new Error('client disconnected'));
  });
  return controller.signal;
}

/* ── Anthropic ⇄ OpenAI translation at the edge ────────────────────────── */

function anthropicToOpenAI(a: AnthropicRequest): ChatCompletionRequest {
  const messages: ChatCompletionRequest['messages'] = [];

  if (a.system) {
    const text =
      typeof a.system === 'string'
        ? a.system
        : a.system
            .map((b: unknown) => (typeof b === 'object' && b && 'text' in b ? String((b).text) : ''))
            .join('\n');
    if (text) messages.push({ role: 'system', content: text });
  }

  for (const m of a.messages) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content });
      continue;
    }
    const parts = (m.content as unknown[])
      .map((block) => {
        const b = block as { type?: string; text?: string; source?: { data?: string; media_type?: string } };
        if (b.type === 'text') return { type: 'text' as const, text: b.text ?? '' };
        if (b.type === 'image' && b.source?.data) {
          return {
            type: 'image_url' as const,
            image_url: { url: `data:${b.source.media_type ?? 'image/png'};base64,${b.source.data}` },
          };
        }
        return null;
      })
      .filter((p): p is NonNullable<typeof p> => p !== null);
    messages.push({ role: m.role, content: parts });
  }

  return {
    model: a.model,
    messages,
    max_tokens: a.max_tokens,
    temperature: a.temperature,
    top_p: a.top_p,
    stop: a.stop_sequences,
    stream: a.stream,
    tools: a.tools,
    tool_choice: a.tool_choice,
  };
}

function openAIToAnthropic(
  r: { id: string; choices: Array<{ message: { content: string | null }; finish_reason: string | null }>; usage?: { prompt_tokens: number; completion_tokens: number } },
  model: string,
): AnthropicResponse {
  const choice = r.choices[0];
  const stopMap: Record<string, string> = {
    stop: 'end_turn',
    length: 'max_tokens',
    tool_calls: 'tool_use',
    content_filter: 'stop_sequence',
  };
  return {
    id: r.id.startsWith('msg_') ? r.id : `msg_${r.id}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: choice?.message?.content ?? '' }],
    stop_reason: stopMap[choice?.finish_reason ?? 'stop'] ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: r.usage?.prompt_tokens ?? 0,
      output_tokens: r.usage?.completion_tokens ?? 0,
    },
  };
}

