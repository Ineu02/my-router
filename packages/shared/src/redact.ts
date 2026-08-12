/**
 * Secret handling. Every path that could put key material in front of a
 * human or into a log funnels through here.
 */

/**
 * Mask a secret for display: keep a short prefix and the last 4 chars.
 *   sk-proj-abc123...wxyz4f2a  →  sk-proj-…4f2a
 * Short/absent values collapse to a constant so length isn't leaked either.
 */
export function maskSecret(secret: string | null | undefined): string {
  if (!secret) return '—';
  const s = String(secret);
  if (s.length < 12) return '••••••••';

  // Preserve a recognisable vendor prefix so operators can tell keys apart.
  const prefixMatch = s.match(/^(sk-proj-|sk-ant-|sk-router-|sk-or-|sk-|gsk_|xai-|AIza)/);
  const prefix = prefixMatch ? prefixMatch[1] : s.slice(0, 3);
  return `${prefix}…${s.slice(-4)}`;
}

/** Stable non-reversible fingerprint, safe to log for correlating keys. */
export async function hashSecret(secret: string): Promise<string> {
  const data = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time string compare — avoids leaking match position via timing. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still burn a comparison so the early return isn't itself a timing
    // signal. The result is deliberately discarded — the work is the point,
    // and `_sink` keeps a minifier (and the linter) from eliding the loop.
    let _sink = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      _sink |= (a.charCodeAt(i % a.length || 0) || 0) ^ (b.charCodeAt(i % b.length || 0) || 0);
    }
    void _sink;
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Header names that must never reach a log sink. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'api-key',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-goog-api-key',
  'x-router-admin-token',
]);

export function redactHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return out;
}

/**
 * Patterns for key material that might appear inside an upstream error
 * string. Providers do sometimes echo the key back in a message.
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-proj-[A-Za-z0-9_-]{10,}/g,
  /sk-router-[A-Za-z0-9_-]{10,}/g,
  /sk-or-v1-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /AIza[A-Za-z0-9_-]{30,}/g,
  /xai-[A-Za-z0-9]{20,}/g,
  /gsk_[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

/** Scrub anything key-shaped out of free text before it is stored or logged. */
export function redactText(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[REDACTED]');
  return out;
}

/** Deep-redact an arbitrary object destined for a log line. */
export function redactObject<T>(value: T, depth = 0): T {
  if (depth > 6 || value == null) return value;
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1)) as unknown as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lk = k.toLowerCase();
      if (
        lk === 'apikey' ||
        lk === 'api_key' ||
        lk === 'authorization' ||
        lk === 'key' ||
        lk === 'secret' ||
        lk === 'token' ||
        lk === 'password'
      ) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactObject(v, depth + 1);
      }
    }
    return out as unknown as T;
  }
  return value;
}

/** Cryptographically random client key: `sk-router-<48 hex>`. */
export function generateRouterKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `sk-router-${hex}`;
}

export function generateId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}_${hex}`;
}

/** OpenAI-style request id: `chatcmpl-<24 hex>`. */
export function generateRequestId(prefix = 'req'): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${prefix}-${hex}`;
}
