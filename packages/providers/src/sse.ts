import { RouterError } from '@router/shared';

/**
 * Incremental SSE parser.
 *
 * Providers chunk their bodies at arbitrary byte boundaries, so a frame can
 * straddle two reads. This buffers until it sees a blank-line terminator
 * rather than assuming one frame per chunk — the classic source of dropped
 * tokens in gateway implementations.
 */

export interface SSEFrame {
  event?: string;
  data: string;
  id?: string;
}

export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Frames end with a blank line; tolerate \n\n and \r\n\r\n.
      let sep: number;
      while ((sep = findFrameEnd(buffer)) !== -1) {
        const rawFrame = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){1,2}/, '');
        const frame = parseFrame(rawFrame);
        if (frame) yield frame;
      }
    }

    // Some providers omit the trailing blank line on the final frame.
    const tail = buffer.trim();
    if (tail.length > 0) {
      const frame = parseFrame(tail);
      if (frame) yield frame;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

function findFrameEnd(buf: string): number {
  const a = buf.indexOf('\n\n');
  const b = buf.indexOf('\r\n\r\n');
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function parseFrame(raw: string): SSEFrame | null {
  const lines = raw.split(/\r?\n/);
  const dataLines: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  for (const line of lines) {
    if (line === '' || line.startsWith(':')) continue; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') dataLines.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
  }

  if (dataLines.length === 0) return null;
  return { event, id, data: dataLines.join('\n') };
}

/** Parse a frame's JSON payload, converting failures into MALFORMED_RESPONSE. */
export function parseFrameJSON<T>(frame: SSEFrame, provider: string): T | null {
  if (frame.data === '[DONE]') return null;
  try {
    return JSON.parse(frame.data) as T;
  } catch {
    throw new RouterError('MALFORMED_RESPONSE', 'Provider sent an unparseable SSE frame', {
      provider,
      detail: frame.data.slice(0, 200),
    });
  }
}

/** Serialise an SSE frame for the client. */
export function formatSSE(data: unknown): string {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

export const SSE_DONE = 'data: [DONE]\n\n';
