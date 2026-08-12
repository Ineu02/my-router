import { z } from 'zod';

/* ═══════════════════════════════════════════════════════════════════
   OpenAI chat/completions wire format — the router's public contract.
   Kept permissive (passthrough) on request so unknown-but-valid client
   fields survive the hop to providers that understand them.
   ═══════════════════════════════════════════════════════════════════ */

export const ContentPartSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({
      url: z.string(),
      detail: z.enum(['auto', 'low', 'high']).optional(),
    }),
  }),
  // Tolerate provider-specific part shapes rather than 400-ing the client.
  z.object({ type: z.string() }).passthrough(),
]);

export type ContentPart = z.infer<typeof ContentPartSchema>;

export const ChatMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant', 'tool', 'developer', 'function']),
    content: z.union([z.string(), z.array(ContentPartSchema), z.null()]).optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.any()).optional(),
    function_call: z.any().optional(),
    reasoning_content: z.string().optional(),
  })
  .passthrough();

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatCompletionRequestSchema = z
  .object({
    model: z.string().min(1, 'model is required'),
    messages: z.array(ChatMessageSchema).min(1, 'messages must not be empty'),
    stream: z.boolean().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    n: z.number().int().positive().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    logit_bias: z.record(z.number()).optional(),
    user: z.string().optional(),
    seed: z.number().int().optional(),
    tools: z.array(z.any()).optional(),
    tool_choice: z.any().optional(),
    parallel_tool_calls: z.boolean().optional(),
    response_format: z.any().optional(),
    reasoning_effort: z.string().optional(),

    /* ── Router-specific extensions (stripped before the upstream call) ── */

    /** Force a named routing profile regardless of the model string. */
    router_profile: z.string().optional(),
    /** Include the provider attempt trail in the response body. */
    router_debug: z.boolean().optional(),
    /** Restrict the candidate ladder to these providers. */
    router_providers: z.array(z.string()).optional(),
  })
  .passthrough();

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionChoice {
  index: number;
  message: { role: 'assistant'; content: string | null; tool_calls?: unknown[] };
  finish_reason: string | null;
  /** Passed through untouched when the upstream sends it. */
  logprobs?: unknown;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: Usage;
  system_fingerprint?: string;
  /** Router metadata — present only when `router_debug` is set. */
  _router?: RouterMetadata;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: {
    role?: 'assistant';
    content?: string | null;
    tool_calls?: unknown[];
    reasoning_content?: string;
  };
  finish_reason: string | null;
  /** Passed through untouched when the upstream sends it. */
  logprobs?: unknown;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: Usage | null;
  _router?: RouterMetadata;
}

/* ═══════════════════════════════════════════════════════════════════
   Router metadata — what happened behind the single endpoint.
   Credentials appear ONLY as opaque id + human label. Never key material.
   ═══════════════════════════════════════════════════════════════════ */

export interface ProviderAttempt {
  provider: string;
  model: string;
  /** "success" | "timeout" | "429" | "503" | ... */
  status: string;
  latency_ms: number;
  error_class?: string;
  /** Opaque credential identifier — safe to display. */
  credential_id?: string;
  credential_label?: string;
}

export interface RouterMetadata {
  request_id: string;
  requested_model: string;
  resolved_profile?: string;
  selected_provider: string;
  selected_model: string;
  fallback_count: number;
  total_latency_ms: number;
  provider_attempts: ProviderAttempt[];
  /** Epoch ms the ladder started; used to time a stream to completion. */
  started_at?: number;
}

/* ═══════════════════════════════════════════════════════════════════
   /v1/models
   ═══════════════════════════════════════════════════════════════════ */

export interface ModelListEntry {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  /** Non-standard but useful; ignored by strict OpenAI clients. */
  context_length?: number;
  capabilities?: string[];
  status?: string;
}

export interface ModelListResponse {
  object: 'list';
  data: ModelListEntry[];
}

/* ═══════════════════════════════════════════════════════════════════
   Anthropic /v1/messages — accepted so Anthropic-shaped clients work
   against the same gateway without translation on their side.
   ═══════════════════════════════════════════════════════════════════ */

export const AnthropicMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']),
    content: z.union([z.string(), z.array(z.any())]),
  })
  .passthrough();

export const AnthropicRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(AnthropicMessageSchema).min(1),
    max_tokens: z.number().int().positive(),
    system: z.union([z.string(), z.array(z.any())]).optional(),
    stream: z.boolean().optional(),
    temperature: z.number().min(0).max(1).optional(),
    top_p: z.number().optional(),
    top_k: z.number().optional(),
    stop_sequences: z.array(z.string()).optional(),
    tools: z.array(z.any()).optional(),
    tool_choice: z.any().optional(),
    metadata: z.any().optional(),
  })
  .passthrough();

export type AnthropicRequest = z.infer<typeof AnthropicRequestSchema>;

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: Array<{ type: 'text'; text: string }>;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
  _router?: RouterMetadata;
}
