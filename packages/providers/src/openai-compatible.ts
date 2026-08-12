import {
  RouterError,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ProviderKind,
} from '@router/shared';
import { classifyHttpStatus, classifyException } from '@router/router-core';
import type {
  HealthCheckResult,
  Provider,
  ProviderCallOptions,
  ProviderChatResult,
  ProviderStreamResult,
} from './types.js';
import { parseSSE, parseFrameJSON } from './sse.js';
import { stripRouterFields } from './types.js';

/**
 * Generic adapter for any endpoint that speaks the OpenAI chat/completions
 * wire format.
 *
 * Covers OpenAI, xAI/Grok, OpenRouter, Qwen (DashScope compat mode), GLM,
 * Groq, Together, vLLM, LM Studio, Ollama, and the CUSTOM_PROVIDER_* hook —
 * every one of those is a base URL and a key, nothing more.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly kind: ProviderKind = 'openai-compatible';

  constructor(
    readonly name: string,
    readonly defaultModels: readonly string[] = [],
    private readonly options: {
      /** Some gateways want extra headers (OpenRouter attribution, etc.). */
      extraHeaders?: Record<string, string>;
      /** Providers that reject `stream_options`. */
      supportsStreamOptions?: boolean;
    } = {},
  ) {}

  protected buildHeaders(opts: ProviderCallOptions): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.apiKey}`,
      ...this.options.extraHeaders,
      ...opts.headers,
    };
  }

  protected buildUrl(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, '')}${path}`;
  }

  protected buildBody(req: ChatCompletionRequest, opts: ProviderCallOptions, stream: boolean): unknown {
    const body = stripRouterFields(req as Record<string, unknown>);
    body.model = opts.model; // registry id → upstream model name
    body.stream = stream;

    if (stream && this.options.supportsStreamOptions !== false) {
      // Ask for usage on the final chunk when the provider supports it.
      body.stream_options = { include_usage: true, ...(body.stream_options as object) };
    } else if (!stream) {
      delete body.stream_options;
    }
    return body;
  }

  async chat(req: ChatCompletionRequest, opts: ProviderCallOptions): Promise<ProviderChatResult> {
    let res: Response;
    try {
      res = await fetch(this.buildUrl(opts.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: this.buildHeaders(opts),
        body: JSON.stringify(this.buildBody(req, opts, false)),
        signal: opts.signal,
      });
    } catch (err) {
      throw classifyException(err, this.name);
    }

    if (!res.ok) {
      const text = await safeText(res);
      throw this.normalizeError(null, res.status, text, res.headers.get('retry-after'));
    }

    let json: ChatCompletionResponse;
    try {
      json = (await res.json()) as ChatCompletionResponse;
    } catch (err) {
      throw new RouterError('MALFORMED_RESPONSE', 'Provider returned invalid JSON', {
        provider: this.name,
        cause: err,
      });
    }

    if (!json || !Array.isArray(json.choices)) {
      throw new RouterError('MALFORMED_RESPONSE', 'Provider response is missing `choices`', {
        provider: this.name,
      });
    }

    return { response: json, status: res.status };
  }

  async stream(req: ChatCompletionRequest, opts: ProviderCallOptions): Promise<ProviderStreamResult> {
    let res: Response;
    try {
      res = await fetch(this.buildUrl(opts.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: { ...this.buildHeaders(opts), accept: 'text/event-stream' },
        body: JSON.stringify(this.buildBody(req, opts, true)),
        signal: opts.signal,
      });
    } catch (err) {
      throw classifyException(err, this.name);
    }

    if (!res.ok) {
      const text = await safeText(res);
      throw this.normalizeError(null, res.status, text, res.headers.get('retry-after'));
    }

    if (!res.body) {
      throw new RouterError('MALFORMED_RESPONSE', 'Provider returned an empty stream body', {
        provider: this.name,
      });
    }

    const frames = parseSSE(res.body, opts.signal);
    const provider = this.name;

    // Pull chunks until the first real one arrives. Until we hand a chunk
    // back, the router can still fail over to another provider; after that
    // the client's response body is committed.
    let first: ChatCompletionChunk | null = null;
    while (first === null) {
      const next = await frames.next();
      if (next.done) {
        throw new RouterError('MALFORMED_RESPONSE', 'Provider stream ended before any content', {
          provider,
        });
      }
      const parsed = parseFrameJSON<ChatCompletionChunk>(next.value, provider);
      if (parsed === null) {
        // A [DONE] with nothing before it means the upstream produced nothing.
        throw new RouterError('MALFORMED_RESPONSE', 'Provider stream contained no chunks', {
          provider,
        });
      }
      // Some providers emit an error object inside a 200 stream.
      const maybeErr = (parsed as unknown as { error?: { message?: string } }).error;
      if (maybeErr) {
        throw new RouterError('PROVIDER_UNAVAILABLE', maybeErr.message ?? 'Provider stream error', {
          provider,
        });
      }
      if (Array.isArray(parsed.choices)) first = parsed;
    }

    async function* rest(): AsyncGenerator<ChatCompletionChunk> {
      for await (const frame of frames) {
        const parsed = parseFrameJSON<ChatCompletionChunk>(frame, provider);
        if (parsed === null) return; // [DONE]
        yield parsed;
      }
    }

    return { first, rest: rest(), status: res.status };
  }

  /**
   * Liveness probe for a credential.
   *
   * When a model is known this exercises the *chat* path with a tiny 1-token
   * completion, not a `GET /models` listing. That distinction matters: a
   * listing endpoint can answer 200 while the completions endpoint is throwing
   * 5xx, so a `/models` ping would declare a chat-broken upstream healthy and
   * pull a still-dead credential straight back into rotation. The probe has to
   * fail on exactly what a real request would fail on. It only ever runs
   * against credentials already out of rotation, so the cost is a single short
   * request on a recovering account, never on a healthy one.
   *
   * With no model to name, fall back to the listing probe — it still proves the
   * key and endpoint are reachable, which is all that can be checked blind.
   */
  async healthCheck(
    opts: Omit<ProviderCallOptions, 'model'> & { model?: string },
  ): Promise<HealthCheckResult> {
    const start = Date.now();
    if (!opts.model) return this.pingModels(opts, start);

    try {
      const res = await fetch(this.buildUrl(opts.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: this.buildHeaders({ ...opts, model: opts.model }),
        body: JSON.stringify({
          model: opts.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
        signal: opts.signal,
      });
      const latencyMs = Date.now() - start;
      // Drain the body so the socket is released rather than left half-read.
      const text = await safeText(res);
      return {
        ok: res.ok,
        latencyMs,
        detail: res.ok ? undefined : `HTTP ${res.status}${text ? `: ${text.slice(0, 80)}` : ''}`,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        detail: (err as Error)?.message?.slice(0, 120),
      };
    }
  }

  /** Cheap reachability check when there is no model to exercise. */
  private async pingModels(
    opts: Omit<ProviderCallOptions, 'model'> & { model?: string },
    start: number,
  ): Promise<HealthCheckResult> {
    try {
      const res = await fetch(this.buildUrl(opts.baseUrl, '/models'), {
        method: 'GET',
        headers: this.buildHeaders({ ...opts, model: opts.model ?? '' }),
        signal: opts.signal,
      });
      const latencyMs = Date.now() - start;
      // 401/403 means reachable-but-unauthorised: still a failed probe, but a
      // different diagnosis than "unreachable".
      return {
        ok: res.ok,
        latencyMs,
        detail: res.ok ? undefined : `HTTP ${res.status}`,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        detail: (err as Error)?.message?.slice(0, 120),
      };
    }
  }

  normalizeError(err: unknown, status?: number, body?: string, retryAfter?: string | null): RouterError {
    if (status !== undefined) {
      return classifyHttpStatus(status, body, { provider: this.name, retryAfter });
    }
    return classifyException(err, this.name);
  }
}

export async function safeText(res: Response): Promise<string | undefined> {
  try {
    const t = await res.text();
    return t.slice(0, 2000);
  } catch {
    return undefined;
  }
}
