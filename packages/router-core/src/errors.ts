import { ErrorClass, RouterError } from '@router/shared';

/**
 * Map an arbitrary upstream failure onto the router's error taxonomy.
 *
 * Adapters may call this directly, or override `normalizeError()` when the
 * provider has quirks (Anthropic's `overloaded_error`, Gemini's
 * RESOURCE_EXHAUSTED, ...). Everything downstream reasons only about the
 * resulting ErrorClass — never about provider-specific shapes.
 */

/** Parse Retry-After, which may be seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();

  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return Math.ceil(asSeconds);

  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    const delta = Math.ceil((asDate - now) / 1000);
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/** Classify a completed HTTP response from a provider. */
export function classifyHttpStatus(
  status: number,
  bodyText: string | undefined,
  opts: { provider?: string; retryAfter?: string | null; now?: number } = {},
): RouterError {
  const now = opts.now ?? Date.now();
  const retryAfterSec = parseRetryAfter(opts.retryAfter, now);
  const detail = bodyText ? bodyText.slice(0, 500) : undefined;
  const lower = (bodyText ?? '').toLowerCase();

  const make = (cls: ErrorClass, msg: string) =>
    new RouterError(cls, msg, {
      upstreamStatus: status,
      retryAfterSec,
      provider: opts.provider,
      detail,
    });

  if (status === 401 || status === 403) {
    return make('AUTH', `Provider rejected credentials (HTTP ${status})`);
  }

  if (status === 429) {
    return make('RATE_LIMIT', `Provider rate limited (HTTP 429)`);
  }

  if (status === 404) {
    // A 404 usually means the model path is wrong, but some gateways 404 the
    // whole endpoint. Both are "don't hammer this candidate again".
    return make('MODEL_UNAVAILABLE', `Model or endpoint not found (HTTP 404)`);
  }

  if (status === 400 || status === 422) {
    // Distinguish the client's fault from a context-window overflow — the
    // latter is worth failing over to a bigger model, the former is not.
    if (
      lower.includes('context length') ||
      lower.includes('context_length') ||
      lower.includes('too many tokens') ||
      lower.includes('maximum context') ||
      lower.includes('prompt is too long')
    ) {
      return make('CONTEXT_LENGTH', 'Request exceeds the model context window');
    }
    if (lower.includes('content') && (lower.includes('filter') || lower.includes('policy'))) {
      return make('CONTENT_FILTER', 'Request blocked by provider content policy');
    }
    if (
      lower.includes('model') &&
      (lower.includes('not found') || lower.includes('does not exist') || lower.includes('invalid model'))
    ) {
      return make('MODEL_UNAVAILABLE', 'Provider does not recognise this model');
    }
    return make('BAD_REQUEST', `Provider rejected the request as invalid (HTTP ${status})`);
  }

  if (status === 413) {
    return make('BAD_REQUEST', 'Request payload too large for provider');
  }

  if (status === 408 || status === 504) {
    return make('TIMEOUT', `Provider timed out (HTTP ${status})`);
  }

  if (status === 402) {
    // Out of credit — the credential is unusable until a human intervenes.
    return make('AUTH', 'Provider reports insufficient quota or billing issue');
  }

  if (status >= 500) {
    return make('PROVIDER_UNAVAILABLE', `Provider unavailable (HTTP ${status})`);
  }

  if (status >= 400) {
    return make('UNKNOWN', `Unexpected provider status ${status}`);
  }

  return make('UNKNOWN', `Unexpected provider status ${status}`);
}

/** Node/undici socket error codes that mean "connection problem". */
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNABORTED',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Classify a thrown exception (not an HTTP response). */
export function classifyException(err: unknown, provider?: string): RouterError {
  if (err instanceof RouterError) return err;

  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string } };
  const code = e?.code ?? e?.cause?.code;
  const name = e?.name ?? '';
  const message = e?.message ?? String(err);

  // AbortController firing is how we implement request timeouts.
  if (name === 'AbortError' || name === 'TimeoutError' || code === 'ABORT_ERR') {
    return new RouterError('TIMEOUT', 'Request aborted after timeout', { provider });
  }

  if (code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return new RouterError('TIMEOUT', 'Provider stopped responding', { provider, detail: code });
  }

  if (code && NETWORK_CODES.has(code)) {
    return new RouterError('NETWORK', `Network error contacting provider (${code})`, {
      provider,
      detail: code,
    });
  }

  if (err instanceof SyntaxError || /JSON/i.test(message)) {
    return new RouterError('MALFORMED_RESPONSE', 'Provider returned an unparseable response', {
      provider,
      detail: message.slice(0, 200),
    });
  }

  if (/fetch failed/i.test(message)) {
    return new RouterError('NETWORK', 'Network error contacting provider', {
      provider,
      detail: message.slice(0, 200),
    });
  }

  return new RouterError('UNKNOWN', message.slice(0, 300) || 'Unknown provider error', { provider });
}

/** Convenience: classify anything at all. */
export function classifyError(err: unknown, provider?: string): RouterError {
  return classifyException(err, provider);
}

/** Short status token recorded in the attempt trail ("429", "timeout", ...). */
export function attemptStatusToken(err: RouterError): string {
  if (err.errorClass === 'TIMEOUT') return 'timeout';
  if (err.errorClass === 'NETWORK') return 'network_error';
  if (err.upstreamStatus) return String(err.upstreamStatus);
  return err.errorClass.toLowerCase();
}
