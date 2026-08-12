import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

/**
 * Local mock upstream — a real OpenAI-compatible HTTP server.
 *
 * Everything in this project is verified against this, not against paid APIs.
 * Traffic is genuine HTTP over a socket, so the whole path (fetch, SSE
 * framing, timeouts, aborts) is exercised for real.
 *
 * Failure injection, either per-model or via the control endpoint:
 *
 *   mock-fast            normal
 *   mock-smart           normal, slightly slower
 *   mock-backup          normal
 *   mock-429             HTTP 429 + Retry-After
 *   mock-500             HTTP 503
 *   mock-401             HTTP 401 (auth)
 *   mock-404             HTTP 404 (model unavailable)
 *   mock-400             HTTP 400 (the caller's own payload is wrong)
 *   mock-timeout         never responds
 *   mock-malformed       200 with unparseable body
 *   mock-slow            responds after ~2s
 *   mock-stream-break    starts streaming, then dies mid-stream
 *
 *   POST /__control  { "fail": "429" | "500" | ..., "count": 2 }
 *   POST /__control  { "reset": true }
 *   GET  /__control  → current state + request tally
 */

export const MOCK_API_KEY = 'mock-local-key';

export interface MockState {
  /** Force the next `remaining` requests to fail this way. */
  fail: string | null;
  remaining: number;
  /** Artificial latency applied to every response, ms. */
  latencyMs: number;
  requestCount: number;
  byModel: Record<string, number>;
  lastAuthorization: string | null;
}

function freshState(): MockState {
  return {
    fail: null,
    remaining: 0,
    latencyMs: 0,
    requestCount: 0,
    byModel: {},
    lastAuthorization: null,
  };
}

const MODELS = [
  'mock-fast',
  'mock-smart',
  'mock-backup',
  'mock-429',
  'mock-500',
  'mock-401',
  'mock-404',
  'mock-400',
  'mock-timeout',
  'mock-malformed',
  'mock-slow',
  'mock-stream-break',
];

export interface MockServerHandle {
  server: Server;
  port: number;
  url: string;
  state: MockState;
  reset(): void;
  close(): Promise<void>;
}

export function createMockUpstream(): {
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  state: MockState;
  reset: () => void;
} {
  let state = freshState();

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void handleRequest(req, res, state, () => {
      state = freshState();
    }).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(err) } }));
      } else {
        res.end();
      }
    });
  };

  return {
    handler,
    get state() {
      return state;
    },
    reset: () => {
      state = freshState();
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: MockState,
  resetFn: () => void,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  /* ── control plane ─────────────────────────────────────────────────── */
  if (path === '/__control') {
    if (req.method === 'GET') return json(res, 200, state);
    const body = await readBody(req);
    const parsed = safeJSON(body) as
      | { fail?: string | null; count?: number; latencyMs?: number; reset?: boolean }
      | null;
    if (parsed?.reset) {
      resetFn();
      return json(res, 200, { ok: true, reset: true });
    }
    if (parsed) {
      if ('fail' in parsed) {
        state.fail = parsed.fail ?? null;
        state.remaining = parsed.count ?? Number.MAX_SAFE_INTEGER;
      }
      if (typeof parsed.latencyMs === 'number') state.latencyMs = parsed.latencyMs;
    }
    return json(res, 200, { ok: true, fail: state.fail, remaining: state.remaining });
  }

  if (path === '/health' || path === '/__health') {
    return json(res, 200, { ok: true, mock: true });
  }

  /* ── auth ──────────────────────────────────────────────────────────── */
  const auth = req.headers.authorization ?? null;
  state.lastAuthorization = auth;
  const key = auth?.replace(/^Bearer\s+/i, '') ?? '';

  if (path === '/v1/models' && req.method === 'GET') {
    if (key !== MOCK_API_KEY) return json(res, 401, oaiError('Invalid API key', 'invalid_api_key'));
    return json(res, 200, {
      object: 'list',
      data: MODELS.map((id) => ({ id, object: 'model', created: 0, owned_by: 'mock' })),
    });
  }

  if (path !== '/v1/chat/completions' || req.method !== 'POST') {
    return json(res, 404, oaiError(`Unknown route ${req.method} ${path}`, 'not_found'));
  }

  if (key !== MOCK_API_KEY) {
    return json(res, 401, oaiError('Incorrect API key provided', 'invalid_api_key'));
  }

  const raw = await readBody(req);
  const body = safeJSON(raw) as
    | { model?: string; messages?: Array<{ role: string; content: unknown }>; stream?: boolean; max_tokens?: number }
    | null;

  if (!body || !Array.isArray(body.messages)) {
    return json(res, 400, oaiError('messages is required', 'invalid_request_error'));
  }

  const model = body.model ?? 'mock-fast';
  state.requestCount++;
  state.byModel[model] = (state.byModel[model] ?? 0) + 1;

  // Control-plane injection outranks the model's own behaviour.
  let mode = model;
  if (state.fail && state.remaining > 0) {
    state.remaining--;
    mode = `mock-${state.fail}`;
  }

  if (state.latencyMs > 0) await sleep(state.latencyMs);

  switch (mode) {
    case 'mock-429':
      res.setHeader('retry-after', '2');
      return json(res, 429, oaiError('Rate limit reached', 'rate_limit_exceeded'));

    case 'mock-500':
      return json(res, 503, oaiError('The engine is overloaded', 'server_error'));

    case 'mock-401':
      return json(res, 401, oaiError('Invalid Authentication', 'invalid_api_key'));

    case 'mock-404':
      return json(res, 404, oaiError(`The model '${model}' does not exist`, 'model_not_found'));

    case 'mock-400':
      // The caller's payload is wrong. A gateway must surface this rather than
      // retry it elsewhere, so the router's no-failover path needs a way to be
      // provoked from an upstream.
      return json(res, 400, oaiError('Unsupported value for parameter', 'invalid_request_error'));

    case 'mock-timeout':
      // Hold the socket open. The router's own timeout must fire.
      return new Promise<void>(() => {
        req.on('close', () => res.destroy());
      });

    case 'mock-malformed':
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"choices": [ this is not json');
      return;

    case 'mock-slow':
      await sleep(2000);
      break;

    default:
      break;
  }

  const prompt = extractText(body.messages);
  const reply = buildReply(model, prompt);

  if (body.stream) {
    return streamReply(res, model, reply, mode === 'mock-stream-break');
  }
  return json(res, 200, completion(model, reply, prompt));
}

/* ── response builders ─────────────────────────────────────────────────── */

function buildReply(model: string, prompt: string): string {
  return `[${model}] mock response to: ${prompt.slice(0, 120)}`;
}

function completion(model: string, content: string, prompt: string) {
  const promptTokens = Math.max(1, Math.ceil(prompt.length / 4));
  const completionTokens = Math.max(1, Math.ceil(content.length / 4));
  return {
    id: `chatcmpl-mock-${Math.abs(hash(content)).toString(16)}`,
    object: 'chat.completion',
    created: 1700000000,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

async function streamReply(
  res: ServerResponse,
  model: string,
  content: string,
  breakMidway: boolean,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const id = `chatcmpl-mock-${Math.abs(hash(content)).toString(16)}`;
  const words = content.split(' ');

  const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: 1700000000,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;

  res.write(frame({ role: 'assistant', content: '' }));

  for (let i = 0; i < words.length; i++) {
    if (breakMidway && i === Math.floor(words.length / 2)) {
      // Kill the socket with no [DONE] — the router must surface this as a
      // terminating error frame rather than truncating silently.
      res.destroy();
      return;
    }
    res.write(frame({ content: (i === 0 ? '' : ' ') + words[i] }));
    await sleep(5);
  }

  res.write(frame({}, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
}

/* ── helpers ───────────────────────────────────────────────────────────── */

function oaiError(message: string, code: string) {
  return { error: { message, type: code, code } };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeJSON(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractText(messages: Array<{ role: string; content: unknown }>): string {
  const last = messages[messages.length - 1];
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content
      .map((p) => (typeof p === 'object' && p && 'text' in p ? String((p as { text: unknown }).text) : ''))
      .join(' ')
      .trim();
  }
  return '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i) | 0;
  return h;
}

/** Boot the mock on a port. Port 0 picks a free one (used by tests). */
export function startMockUpstream(port = 20129): Promise<MockServerHandle> {
  const mock = createMockUpstream();
  const server = createServer(mock.handler);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        port: actual,
        url: `http://127.0.0.1:${actual}`,
        get state() {
          return mock.state;
        },
        reset: mock.reset,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

// Standalone: `npm run dev:mock`
const isDirect =
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`.replace('file:///', 'file:///');

if (isDirect || process.env.MOCK_STANDALONE === '1') {
  const port = Number(process.env.MOCK_PROVIDER_PORT ?? 20129);
  void startMockUpstream(port).then((h) => {
     
    console.log(`[mock] OpenAI-compatible upstream on ${h.url}  (key: ${MOCK_API_KEY})`);
  });
}
