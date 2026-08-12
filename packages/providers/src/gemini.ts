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
 * Google Gemini adapter (generativelanguage v1beta).
 *
 * Gemini's format diverges further than Anthropic's:
 *   · messages are `contents` with `parts`, and the assistant role is "model"
 *   · the system prompt is `systemInstruction`
 *   · the key goes in a query param / x-goog-api-key header
 *   · streaming uses ?alt=sse with a different envelope
 *   · sampling knobs live under `generationConfig`
 */
export class GeminiProvider implements Provider {
  readonly kind: ProviderKind = 'gemini';
  readonly name: string;
  readonly defaultModels: readonly string[];

  constructor(name = 'gemini', defaultModels: readonly string[] = []) {
    this.name = name;
    this.defaultModels = defaultModels;
  }

  private headers(opts: ProviderCallOptions): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-goog-api-key': opts.apiKey,
      ...opts.headers,
    };
  }

  private toGeminiBody(req: ChatCompletionRequest) {
    const contents: Array<{ role: 'user' | 'model'; parts: unknown[] }> = [];
    const systemParts: unknown[] = [];

    for (const msg of req.messages) {
      if (msg.role === 'system' || msg.role === 'developer') {
        systemParts.push({ text: flattenText(msg.content) });
        continue;
      }
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: convertParts(msg.content),
      });
    }

    const generationConfig: Record<string, unknown> = {};
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (req.top_p !== undefined) generationConfig.topP = req.top_p;
    const maxOut = req.max_tokens ?? req.max_completion_tokens;
    if (maxOut !== undefined) generationConfig.maxOutputTokens = maxOut;
    if (req.stop !== undefined) {
      generationConfig.stopSequences = Array.isArray(req.stop) ? req.stop : [req.stop];
    }

    const body: Record<string, unknown> = { contents };
    if (systemParts.length > 0) body.systemInstruction = { parts: systemParts };
    if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
    return body;
  }

  async chat(req: ChatCompletionRequest, opts: ProviderCallOptions): Promise<ProviderChatResult> {
    const endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(
      opts.model,
    )}:generateContent`;

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: this.headers(opts),
        body: JSON.stringify(this.toGeminiBody(req)),
        signal: opts.signal,
      });
    } catch (err) {
      throw classifyException(err, this.name);
    }

    if (!res.ok) {
      const text = await safeText(res);
      throw this.normalizeError(null, res.status, text, res.headers.get('retry-after'));
    }

    const json = (await res.json()) as GeminiResponse;
    return { response: this.toOpenAIResponse(json, opts.model), status: res.status };
  }

  private toOpenAIResponse(g: GeminiResponse, model: string): ChatCompletionResponse {
    const cand = g.candidates?.[0];
    const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('');

    return {
      id: generateRequestId('chatcmpl'),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text || null },
          finish_reason: mapFinishReason(cand?.finishReason),
        },
      ],
      usage: {
        prompt_tokens: g.usageMetadata?.promptTokenCount ?? 0,
        completion_tokens: g.usageMetadata?.candidatesTokenCount ?? 0,
        total_tokens: g.usageMetadata?.totalTokenCount ?? 0,
      },
    };
  }

  async stream(req: ChatCompletionRequest, opts: ProviderCallOptions): Promise<ProviderStreamResult> {
    const endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(
      opts.model,
    )}:streamGenerateContent?alt=sse`;

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { ...this.headers(opts), accept: 'text/event-stream' },
        body: JSON.stringify(this.toGeminiBody(req)),
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
      throw new RouterError('MALFORMED_RESPONSE', 'Gemini returned an empty stream', {
        provider: this.name,
      });
    }

    const frames = parseSSE(res.body, opts.signal);
    const provider = this.name;
    const id = generateRequestId('chatcmpl');
    const created = Math.floor(Date.now() / 1000);
    const model = opts.model;

    let first: ChatCompletionChunk | null = null;
    while (first === null) {
      const next = await frames.next();
      if (next.done) {
        throw new RouterError('MALFORMED_RESPONSE', 'Gemini stream ended before any content', {
          provider,
        });
      }
      const evt = parseFrameJSON<GeminiResponse>(next.value, provider);
      if (evt === null) {
        throw new RouterError('MALFORMED_RESPONSE', 'Gemini stream produced no content', { provider });
      }
      const chunk = geminiToChunk(evt, { id, created, model });
      if (chunk) first = chunk;
    }

    async function* rest(): AsyncGenerator<ChatCompletionChunk> {
      for await (const frame of frames) {
        const evt = parseFrameJSON<GeminiResponse>(frame, provider);
        if (evt === null) return;
        const chunk = geminiToChunk(evt, { id, created, model });
        if (chunk) yield chunk;
      }
    }

    return { first, rest: rest(), status: res.status };
  }

  async healthCheck(
    opts: Omit<ProviderCallOptions, 'model'> & { model?: string },
  ): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const res = await fetch(`${opts.baseUrl.replace(/\/+$/, '')}/models`, {
        method: 'GET',
        headers: this.headers({ ...opts, model: opts.model ?? '' }),
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
      // Gemini returns 429 for both per-minute throttling and hard quota
      // exhaustion. Only the latter needs a human, but neither should be
      // hammered, so both map to RATE_LIMIT.
      if (lower.includes('resource_exhausted') || lower.includes('quota')) {
        return new RouterError('RATE_LIMIT', 'Gemini quota exhausted', {
          upstreamStatus: status,
          provider: this.name,
        });
      }
      if (lower.includes('api key not valid') || lower.includes('api_key_invalid')) {
        return new RouterError('AUTH', 'Gemini rejected the API key', {
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

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function geminiToChunk(
  g: GeminiResponse,
  ctx: { id: string; created: number; model: string },
): ChatCompletionChunk | null {
  const cand = g.candidates?.[0];
  if (!cand) return null;

  const text = (cand.content?.parts ?? []).map((p) => p.text ?? '').join('');
  const finish = cand.finishReason ? mapFinishReason(cand.finishReason) : null;
  if (!text && !finish) return null;

  return {
    id: ctx.id,
    object: 'chat.completion.chunk',
    created: ctx.created,
    model: ctx.model,
    choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: finish }],
    ...(g.usageMetadata
      ? {
          usage: {
            prompt_tokens: g.usageMetadata.promptTokenCount ?? 0,
            completion_tokens: g.usageMetadata.candidatesTokenCount ?? 0,
            total_tokens: g.usageMetadata.totalTokenCount ?? 0,
          },
        }
      : {}),
  };
}

function mapFinishReason(reason: string | undefined): string | null {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter';
    default:
      return reason ? 'stop' : null;
  }
}

function flattenText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p as { text?: string }).text ?? '').join('');
  }
  return '';
}

function convertParts(content: ChatMessage['content']): unknown[] {
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: '' }];

  return content.map((part) => {
    const p = part as { type?: string; text?: string; image_url?: { url?: string } };
    if (p.type === 'image_url' && p.image_url?.url) {
      const m = p.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
      if (m) return { inlineData: { mimeType: m[1], data: m[2] } };
      return { fileData: { fileUri: p.image_url.url } };
    }
    return { text: p.text ?? '' };
  });
}
