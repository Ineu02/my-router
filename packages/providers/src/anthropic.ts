import {
  RouterError,
  generateRequestId,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ChatMessage,
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
import { safeText } from './openai-compatible.js';

/**
 * Anthropic adapter.
 *
 * Anthropic differs from OpenAI in ways that all have to be handled for a
 * client to be unable to tell the difference:
 *   · system prompt is a top-level field, not a message role
 *   · max_tokens is required
 *   · auth is `x-api-key`, not a bearer token
 *   · streaming is a typed event protocol, not opaque delta chunks
 *   · images are inline base64 blocks, not URLs
 */
export class AnthropicProvider implements Provider {
  readonly kind: ProviderKind = 'anthropic';
  readonly name: string;
  readonly defaultModels: readonly string[];

  constructor(name = 'anthropic', defaultModels: readonly string[] = []) {
    this.name = name;
    this.defaultModels = defaultModels;
  }

  private headers(opts: ProviderCallOptions): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01',
      ...opts.headers,
    };
  }

  /** OpenAI request → Anthropic request. */
  private toAnthropicBody(req: ChatCompletionRequest, opts: ProviderCallOptions, stream: boolean) {
    const system: string[] = [];
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [];

    for (const msg of req.messages) {
      if (msg.role === 'system' || msg.role === 'developer') {
        system.push(flattenText(msg.content));
        continue;
      }
      if (msg.role === 'tool') {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id ?? '',
              content: flattenText(msg.content),
            },
          ],
        });
        continue;
      }
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      messages.push({ role, content: convertContent(msg.content) });
    }

    // Anthropic requires max_tokens; OpenAI treats it as optional.
    const maxTokens = req.max_tokens ?? req.max_completion_tokens ?? 4096;

    const body: Record<string, unknown> = {
      model: opts.model,
      messages,
      max_tokens: maxTokens,
      stream,
    };
    if (system.length > 0) body.system = system.join('\n\n');
    if (req.temperature !== undefined) body.temperature = Math.min(1, req.temperature);
    if (req.top_p !== undefined) body.top_p = req.top_p;
    if (req.stop !== undefined) {
      body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
    }
    if (req.tools) body.tools = convertTools(req.tools);
    return body;
  }

  async chat(req: ChatCompletionRequest, opts: ProviderCallOptions): Promise<ProviderChatResult> {
    let res: Response;
    try {
      res = await fetch(url(opts.baseUrl, '/messages'), {
        method: 'POST',
        headers: this.headers(opts),
        body: JSON.stringify(this.toAnthropicBody(req, opts, false)),
        signal: opts.signal,
      });
    } catch (err) {
      throw classifyException(err, this.name);
    }

    if (!res.ok) {
      const text = await safeText(res);
      throw this.normalizeError(null, res.status, text, res.headers.get('retry-after'));
    }

    const json = (await res.json()) as AnthropicMessageResponse;
    return { response: this.toOpenAIResponse(json, opts.model), status: res.status };
  }

  /** Anthropic response → OpenAI response. */
  private toOpenAIResponse(a: AnthropicMessageResponse, model: string): ChatCompletionResponse {
    const text = (a.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');

    const toolCalls = (a.content ?? [])
      .filter((b) => b.type === 'tool_use')
      .map((b, i) => ({
        index: i,
        id: b.id ?? `call_${i}`,
        type: 'function' as const,
        function: { name: b.name ?? '', arguments: JSON.stringify(b.input ?? {}) },
      }));

    return {
      id: a.id ?? generateRequestId('chatcmpl'),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: a.model ?? model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: mapStopReason(a.stop_reason),
        },
      ],
      usage: {
        prompt_tokens: a.usage?.input_tokens ?? 0,
        completion_tokens: a.usage?.output_tokens ?? 0,
        total_tokens: (a.usage?.input_tokens ?? 0) + (a.usage?.output_tokens ?? 0),
      },
    };
  }

  async stream(req: ChatCompletionRequest, opts: ProviderCallOptions): Promise<ProviderStreamResult> {
    let res: Response;
    try {
      res = await fetch(url(opts.baseUrl, '/messages'), {
        method: 'POST',
        headers: { ...this.headers(opts), accept: 'text/event-stream' },
        body: JSON.stringify(this.toAnthropicBody(req, opts, true)),
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
      throw new RouterError('MALFORMED_RESPONSE', 'Anthropic returned an empty stream', {
        provider: this.name,
      });
    }

    const frames = parseSSE(res.body, opts.signal);
    const provider = this.name;
    const id = generateRequestId('chatcmpl');
    const created = Math.floor(Date.now() / 1000);
    const model = opts.model;

    // Anthropic's protocol front-loads message_start / content_block_start
    // before any text. Pull through them until real content appears so the
    // failover boundary sits at the first *token*, not the first frame.
    let first: ChatCompletionChunk | null = null;
    while (first === null) {
      const next = await frames.next();
      if (next.done) {
        throw new RouterError('MALFORMED_RESPONSE', 'Anthropic stream ended before any content', {
          provider,
        });
      }
      const evt = parseFrameJSON<AnthropicStreamEvent>(next.value, provider);
      if (evt === null) {
        throw new RouterError('MALFORMED_RESPONSE', 'Anthropic stream produced no content', {
          provider,
        });
      }
      if (evt.type === 'error') {
        throw new RouterError('PROVIDER_UNAVAILABLE', evt.error?.message ?? 'Anthropic stream error', {
          provider,
        });
      }
      const chunk = anthropicEventToChunk(evt, { id, created, model });
      if (chunk) first = chunk;
    }

    async function* rest(): AsyncGenerator<ChatCompletionChunk> {
      for await (const frame of frames) {
        const evt = parseFrameJSON<AnthropicStreamEvent>(frame, provider);
        if (evt === null) return;
        if (evt.type === 'error') {
          throw new RouterError('PROVIDER_UNAVAILABLE', evt.error?.message ?? 'Anthropic stream error', {
            provider,
          });
        }
        const chunk = anthropicEventToChunk(evt, { id, created, model });
        if (chunk) yield chunk;
        if (evt.type === 'message_stop') return;
      }
    }

    return { first, rest: rest(), status: res.status };
  }

  async healthCheck(
    opts: Omit<ProviderCallOptions, 'model'> & { model?: string },
  ): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      // Anthropic has no cheap unauthenticated ping; a 1-token message is the
      // smallest real signal and costs a negligible amount.
      const res = await fetch(url(opts.baseUrl, '/messages'), {
        method: 'POST',
        headers: this.headers({ ...opts, model: opts.model ?? '' }),
        body: JSON.stringify({
          model: opts.model ?? this.defaultModels[0] ?? 'claude-3-5-haiku-latest',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: opts.signal,
      });
      return {
        ok: res.ok,
        latencyMs: Date.now() - start,
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
      const lower = (body ?? '').toLowerCase();
      // Anthropic signals capacity problems with a 529 and an
      // `overloaded_error` type — both mean "try elsewhere", not "bad request".
      if (status === 529 || lower.includes('overloaded_error')) {
        return new RouterError('PROVIDER_UNAVAILABLE', 'Anthropic is overloaded', {
          upstreamStatus: status,
          provider: this.name,
        });
      }
      return classifyHttpStatus(status, body, { provider: this.name, retryAfter });
    }
    return classifyException(err, this.name);
  }
}

/* ── wire types ──────────────────────────────────────────────────────── */

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicMessageResponse {
  id?: string;
  model?: string;
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface AnthropicStreamEvent {
  type: string;
  delta?: { type?: string; text?: string; stop_reason?: string; partial_json?: string };
  content_block?: AnthropicContentBlock;
  message?: AnthropicMessageResponse;
  usage?: { output_tokens?: number };
  error?: { message?: string; type?: string };
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function url(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

function anthropicEventToChunk(
  evt: AnthropicStreamEvent,
  ctx: { id: string; created: number; model: string },
): ChatCompletionChunk | null {
  const base = {
    id: ctx.id,
    object: 'chat.completion.chunk' as const,
    created: ctx.created,
    model: ctx.model,
  };

  if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
    return {
      ...base,
      choices: [{ index: 0, delta: { content: evt.delta.text ?? '' }, finish_reason: null }],
    };
  }

  if (evt.type === 'content_block_start' && evt.content_block?.type === 'text') {
    const text = evt.content_block.text ?? '';
    if (text) {
      return {
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
      };
    }
    return null;
  }

  if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
    return {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: mapStopReason(evt.delta.stop_reason) }],
      ...(evt.usage
        ? {
            usage: {
              prompt_tokens: 0,
              completion_tokens: evt.usage.output_tokens ?? 0,
              total_tokens: evt.usage.output_tokens ?? 0,
            },
          }
        : {}),
    };
  }

  return null;
}

function mapStopReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return reason ? 'stop' : null;
  }
}

function flattenText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p as { type?: string; text?: string }).text ?? '')
      .join('');
  }
  return '';
}

/** OpenAI content parts → Anthropic blocks (URL images become base64 blocks). */
function convertContent(content: ChatMessage['content']): unknown {
  if (typeof content === 'string' || content == null) return content ?? '';
  if (!Array.isArray(content)) return '';

  return content.map((part) => {
    const p = part as { type?: string; text?: string; image_url?: { url?: string } };
    if (p.type === 'text') return { type: 'text', text: p.text ?? '' };

    if (p.type === 'image_url' && p.image_url?.url) {
      const u = p.image_url.url;
      const m = u.match(/^data:([^;]+);base64,(.+)$/);
      if (m) {
        return {
          type: 'image',
          source: { type: 'base64', media_type: m[1], data: m[2] },
        };
      }
      // Anthropic supports URL sources on current API versions.
      return { type: 'image', source: { type: 'url', url: u } };
    }
    return { type: 'text', text: p.text ?? '' };
  });
}

function convertTools(tools: unknown[]): unknown[] {
  return tools.map((t) => {
    const fn = (t as { function?: { name?: string; description?: string; parameters?: unknown } })
      .function;
    if (!fn) return t;
    return {
      name: fn.name,
      description: fn.description ?? '',
      input_schema: fn.parameters ?? { type: 'object', properties: {} },
    };
  });
}
