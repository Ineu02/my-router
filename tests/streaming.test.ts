import { describe, it, expect, afterEach } from 'vitest';
import { harness, chat, sseFrames, assembleDeltas, trail, authHeaders, type Harness } from './helpers/harness.js';

/**
 * Streaming, and the one boundary that makes streaming failover honest.
 *
 * An HTTP body cannot be rewound. So the router buffers the upstream stream
 * until the first delta arrives and only *then* commits the client's response:
 * before that point a failure can fail over invisibly, and after it the response
 * belongs to whichever provider is already writing. A mid-stream death must
 * therefore surface as a terminating error frame — never a silent truncation
 * that a client would read as a complete answer.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
});

/** POST a streaming completion and return the raw SSE text. */
async function stream(hh: Harness, body: Record<string, unknown> = {}) {
  const res = await hh.server.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: authHeaders,
    payload: { model: 'auto', messages: [{ role: 'user', content: 'count to three' }], stream: true, ...body },
  });
  return { res, ...sseFrames(res.payload) };
}

describe('streaming happy path', () => {
  it('emits an SSE stream terminated by [DONE]', async () => {
    h = await harness();
    const { res, chunks, done, raw } = await stream(h);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toMatch(/no-cache/);
    expect(chunks.length).toBeGreaterThan(1);
    expect(done).toBe(true);
    // `[DONE]` is the last thing on the wire — a client that stops reading at
    // the sentinel must not miss a frame.
    expect(raw[raw.length - 1]).toBe('[DONE]');
  });

  it('sends chunks in the OpenAI chunk shape', async () => {
    h = await harness();
    const { chunks } = await stream(h);

    const first = chunks[0] as {
      object: string;
      id: string;
      model: string;
      choices: Array<{ index: number; delta: { role?: string }; finish_reason: string | null }>;
    };
    expect(first.object).toBe('chat.completion.chunk');
    expect(first.id).toMatch(/^chatcmpl-/);
    expect(first.choices[0].delta.role).toBe('assistant');
    expect(first.choices[0].finish_reason).toBeNull();

    const last = chunks[chunks.length - 1] as {
      choices: Array<{ finish_reason: string | null }>;
    };
    expect(last.choices[0].finish_reason).toBe('stop');
  });

  it('reassembles into the same content a non-streamed call returns', async () => {
    h = await harness();
    const { chunks } = await stream(h);
    const streamed = assembleDeltas(chunks);

    const { json } = await chat(h, { messages: [{ role: 'user', content: 'count to three' }] });
    const blocking = (json as { choices: Array<{ message: { content: string } }> }).choices[0].message.content;

    expect(streamed.trim()).toBe(blocking.trim());
  });

  it('reports the requested model, not the upstream one, in every chunk', async () => {
    h = await harness();
    const { chunks } = await stream(h, { model: 'auto' });
    for (const c of chunks) {
      expect((c as { model: string }).model).toBe('auto');
    }
  });

  it('attaches router metadata to the first chunk under router_debug', async () => {
    h = await harness();
    const { chunks } = await stream(h, { router_debug: true });
    const first = chunks[0] as { _router?: { selected_provider: string } };
    expect(first._router?.selected_provider).toBe('primary');
    // …and only the first chunk carries it; repeating it per delta would be
    // noise on the wire.
    expect((chunks[1] as { _router?: unknown })._router).toBeUndefined();
  });

  it('omits router metadata without the debug flag', async () => {
    h = await harness();
    const { chunks, res } = await stream(h);
    expect((chunks[0] as { _router?: unknown })._router).toBeUndefined();
    expect(res.headers['x-router-provider']).toBe('primary');
  });
});

describe('failover before the first byte', () => {
  it('fails over a 429 invisibly — the client sees one clean stream', async () => {
    h = await harness({
      providers: [
        { id: 'limited', upstreamModel: 'mock-429', priority: 100 },
        { id: 'healthy', upstreamModel: 'mock-fast', priority: 90 },
      ],
    });
    const { res, chunks, done, raw } = await stream(h, { router_debug: true });

    expect(res.statusCode).toBe(200);
    expect(done).toBe(true);
    expect(assembleDeltas(chunks).length).toBeGreaterThan(0);
    // No error frame anywhere: nothing had been committed when the 429 landed.
    expect(raw.some((r) => r.includes('"error"'))).toBe(false);

    const t = trail(chunks[0]);
    expect(t[0]).toMatchObject({ provider: 'limited', error_class: 'RATE_LIMIT' });
    expect(t[1]).toMatchObject({ provider: 'healthy', status: 'success' });
  });

  it('fails over a hung upstream that never sends a byte', async () => {
    h = await harness({
      config: { requestTimeoutMs: 700 },
      providers: [
        { id: 'hung', upstreamModel: 'mock-timeout', priority: 100 },
        { id: 'healthy', upstreamModel: 'mock-fast', priority: 90 },
      ],
    });
    const { res, chunks, done } = await stream(h, { router_debug: true });

    expect(res.statusCode).toBe(200);
    expect(done).toBe(true);
    expect(trail(chunks[0])[0]).toMatchObject({ provider: 'hung', error_class: 'TIMEOUT' });
  });

  it('returns a normal JSON error when every provider fails pre-commit', async () => {
    // Nothing was written yet, so the client gets an ordinary 503 body rather
    // than a status-200 stream containing only an error frame.
    h = await harness({
      providers: [
        { id: 'a', upstreamModel: 'mock-429', priority: 100 },
        { id: 'b', upstreamModel: 'mock-500', priority: 90 },
      ],
    });
    const res = await h.server.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders,
      payload: { model: 'auto', messages: [{ role: 'user', content: 'x' }], stream: true },
    });

    expect(res.statusCode).toBe(503);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.json().error.code).toBe('all_providers_unavailable');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('rejects a bad model before opening a stream at all', async () => {
    h = await harness();
    const res = await h.server.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders,
      payload: { model: 'nope-not-a-model', messages: [{ role: 'user', content: 'x' }], stream: true },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(h.upstream.state.requestCount).toBe(0);
  });
});

describe('failure after the first byte', () => {
  it('terminates a broken stream with an error frame and [DONE]', async () => {
    h = await harness({
      providers: [{ id: 'flaky', upstreamModel: 'mock-stream-break', priority: 100 }],
    });
    const { res, chunks, done, raw } = await stream(h);

    // The response was already committed as 200 when the socket died — HTTP
    // gives us no way to take that back.
    expect(res.statusCode).toBe(200);
    // Partial content was delivered…
    expect(chunks.length).toBeGreaterThan(0);
    // …and then explicitly marked as broken, rather than just stopping. A silent
    // truncation is indistinguishable from a short answer, which is the bug this
    // whole design exists to avoid.
    const errorFrame = raw.find((r) => r.includes('"error"'));
    expect(errorFrame).toBeDefined();
    const parsed = JSON.parse(errorFrame!) as {
      error: { type: string; message: string };
      _router?: { interrupted?: boolean };
    };
    expect(parsed.error.type).toBe('api_error');
    expect(parsed._router?.interrupted).toBe(true);
    // The sentinel still arrives, so a well-behaved client's loop exits.
    expect(done).toBe(true);
    expect(raw[raw.length - 1]).toBe('[DONE]');
  });

  it('does not fail over after committing — no second provider is called', async () => {
    h = await harness({
      providers: [
        { id: 'flaky', upstreamModel: 'mock-stream-break', priority: 100 },
        { id: 'healthy', upstreamModel: 'mock-fast', priority: 90 },
      ],
    });
    await stream(h);

    // Retrying here would replay the tokens the client already has, producing a
    // duplicated answer. Correct behaviour is to stop.
    expect(h.upstream.state.byModel['mock-fast']).toBeUndefined();
    expect(h.upstream.state.byModel['mock-stream-break']).toBe(1);
  });

  it('records the interrupted request as a failure in the log', async () => {
    h = await harness({
      providers: [{ id: 'flaky', upstreamModel: 'mock-stream-break', priority: 100 }],
    });
    await stream(h);

    const logs = h.server.repos.logs.query({ limit: 10 });
    expect(logs.length).toBeGreaterThan(0);
    const entry = logs[0];
    expect(entry.streamed).toBe(true);
    expect(entry.status).toBe('error');
    expect(entry.errorClass).toBe('MALFORMED_RESPONSE');
    expect(entry.selectedProvider).toBe('flaky');
  });

  it('does not log prompt content', async () => {
    // LOG_PROMPTS defaults off, and a request log is the one place a whole
    // conversation could plausibly end up by accident.
    h = await harness();
    const secret = 'my-private-medical-history-42';
    await stream(h, { messages: [{ role: 'user', content: secret }] });

    const serialised = JSON.stringify(h.server.repos.logs.query({ limit: 10 }));
    expect(serialised).not.toContain(secret);
  });
});

describe('stream hygiene', () => {
  it('never puts key material on the wire', async () => {
    h = await harness();
    const { res } = await stream(h, { router_debug: true });
    expect(res.payload).not.toContain('mock-local-key');
    expect(res.payload).not.toContain('sk-router-test');
  });

  it('frames are separated by a blank line and prefixed with data:', async () => {
    // Malformed SSE framing is the classic reason a gateway "works in curl" but
    // hangs in a real client, so the wire format is asserted literally.
    h = await harness();
    const { res } = await stream(h);
    const lines = res.payload.split('\n');
    for (const line of lines) {
      if (line === '') continue;
      expect(line.startsWith('data: ')).toBe(true);
    }
    expect(res.payload.endsWith('\n\n')).toBe(true);
  });
});
