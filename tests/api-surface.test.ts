import { describe, it, expect, afterEach } from 'vitest';
import { harness, chat, authHeaders, type Harness } from './helpers/harness.js';

/**
 * The public API surface: health, model listing, and the shape of a normal
 * completion. If these break, nothing downstream matters.
 */

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe('health endpoints', () => {
  it('serves /health without authentication', async () => {
    h = await harness();
    const res = await h.server.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('healthy');
  });

  it('serves /api/health with provider and model counts', async () => {
    h = await harness();
    const res = await h.server.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.providers.enabled).toBe(3);
    expect(body.models.enabled).toBe(3);
    expect(body.credentials.available).toBe(3);
  });

  it('never includes key material in a health body', async () => {
    h = await harness();
    const res = await h.server.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.payload).not.toContain('mock-local-key');
    expect(res.payload).not.toContain('sk-router-test');
  });
});

describe('GET /v1/models', () => {
  it('lists enabled models plus the routing profiles', async () => {
    h = await harness();
    const res = await h.server.app.inject({ method: 'GET', url: '/v1/models', headers: authHeaders });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.object).toBe('list');
    const ids = body.data.map((m: { id: string }) => m.id);
    expect(ids).toContain('primary-model');
    expect(ids).toContain('secondary-model');
    // Profiles are addressable as model names — that is the whole point of
    // `model: "auto"` working in an unmodified OpenAI client.
    expect(ids).toContain('auto');
  });

  it('omits disabled models', async () => {
    h = await harness();
    h.server.repos.models.setEnabled('secondary-model', false);
    const res = await h.server.app.inject({ method: 'GET', url: '/v1/models', headers: authHeaders });
    const ids = res.json().data.map((m: { id: string }) => m.id);
    expect(ids).toContain('primary-model');
    expect(ids).not.toContain('secondary-model');
  });

  it('omits models whose provider is disabled', async () => {
    h = await harness();
    h.server.repos.providers.setEnabled('secondary', false);
    const res = await h.server.app.inject({ method: 'GET', url: '/v1/models', headers: authHeaders });
    const ids = res.json().data.map((m: { id: string }) => m.id);
    expect(ids).not.toContain('secondary-model');
  });

  it('requires a key', async () => {
    h = await harness();
    const res = await h.server.app.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/chat/completions', () => {
  it('returns an OpenAI-shaped completion', async () => {
    h = await harness();
    const { res, json } = await chat(h, { messages: [{ role: 'user', content: 'ping' }] });

    expect(res.statusCode).toBe(200);
    const body = json as {
      id: string;
      object: string;
      model: string;
      choices: Array<{ index: number; message: { role: string; content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };
    expect(body.object).toBe('chat.completion');
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.choices[0].message.content).toContain('ping');
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
  });

  it('echoes the requested model name, not the upstream one', async () => {
    h = await harness();
    const { json } = await chat(h, { model: 'auto' });
    expect((json as { model: string }).model).toBe('auto');
    // …while the routing metadata still records what actually served it.
    expect((json as { _router: { selected_model: string } })._router.selected_model).toBe('mock-fast');
  });

  it('omits router metadata unless router_debug is set', async () => {
    h = await harness();
    const res = await h.server.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders,
      payload: { model: 'auto', messages: [{ role: 'user', content: 'x' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()._router).toBeUndefined();
    // The x-router-* headers carry the same facts for clients that want them
    // without a body change.
    expect(res.headers['x-router-provider']).toBe('primary');
  });

  it('strips router_* fields before calling the upstream', async () => {
    h = await harness();
    await chat(h, { router_debug: true, router_profile: 'general' });
    // The mock 400s on an unrecognised body, and counts what it received.
    expect(h.upstream.state.requestCount).toBe(1);
  });

  it('rejects an empty message list without touching an upstream', async () => {
    h = await harness();
    const { res, json } = await chat(h, { messages: [] });
    expect(res.statusCode).toBe(400);
    expect((json as { error: { message: string } }).error.message).toMatch(/messages/i);
    expect(h.upstream.state.requestCount).toBe(0);
  });

  it('rejects a body that is not an object', async () => {
    h = await harness();
    const res = await h.server.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders,
      payload: '"just a string"',
    });
    expect(res.statusCode).toBe(400);
    expect(h.upstream.state.requestCount).toBe(0);
  });
});
