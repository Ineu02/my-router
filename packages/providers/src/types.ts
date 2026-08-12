import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ProviderKind,
  RouterError,
} from '@router/shared';

/**
 * The provider contract.
 *
 * Everything provider-specific lives behind this interface. The router core
 * never imports an adapter and never sees a vendor payload — adding a new
 * upstream means writing one file that satisfies this shape and registering
 * it, with no changes to routing, health, or the API layer.
 */

export interface ProviderCallOptions {
  /** The upstream model name (not the registry id). */
  model: string;
  /** Resolved secret. Lives in memory for the duration of the call only. */
  apiKey: string;
  baseUrl: string;
  /** Cancels the upstream request when the router times out or the client leaves. */
  signal: AbortSignal;
  /** Per-attempt budget, ms. */
  timeoutMs: number;
  /** Extra headers configured by the operator for this provider. */
  headers?: Record<string, string>;
}

export interface ProviderChatResult {
  response: ChatCompletionResponse;
  /** Raw upstream status, for the attempt trail. */
  status: number;
}

/**
 * A stream that has already produced its first chunk.
 *
 * The router buffers upstream until the first delta arrives so it can still
 * fail over; once the client's response body has started it can never be
 * rewound. `first` is that peeked chunk, `rest` is everything after it.
 */
export interface ProviderStreamResult {
  first: ChatCompletionChunk;
  rest: AsyncIterable<ChatCompletionChunk>;
  status: number;
}

export interface HealthCheckResult {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

export interface Provider {
  /** Stable id, e.g. "openai". Matches ProviderEntry.id. */
  readonly name: string;
  readonly kind: ProviderKind;
  /** Model ids this adapter knows about out of the box. */
  readonly defaultModels: readonly string[];

  chat(req: ChatCompletionRequest, opts: ProviderCallOptions): Promise<ProviderChatResult>;

  stream(req: ChatCompletionRequest, opts: ProviderCallOptions): Promise<ProviderStreamResult>;

  healthCheck(opts: Omit<ProviderCallOptions, 'model'> & { model?: string }): Promise<HealthCheckResult>;

  /** Map a vendor error into the router's taxonomy. */
  normalizeError(err: unknown, status?: number, body?: string): RouterError;
}

/** Fields the router strips before forwarding a request upstream. */
export const ROUTER_ONLY_FIELDS = [
  'router_profile',
  'router_debug',
  'router_providers',
] as const;

export function stripRouterFields<T extends Record<string, unknown>>(req: T): T {
  const out = { ...req };
  for (const f of ROUTER_ONLY_FIELDS) delete (out as Record<string, unknown>)[f];
  return out;
}
