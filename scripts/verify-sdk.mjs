/**
 * Client-compatibility check: the *official* `openai` SDK, unmodified, pointed
 * at the router with nothing but a `baseURL` change.
 *
 * This is the acceptance criterion that matters for real use — Hermes,
 * OpenClaw, Claude Code and anything else built on an OpenAI client library go
 * through exactly this code path. Hand-rolled curl can accidentally tolerate a
 * sloppy wire format; the SDK will not.
 *
 * Usage: node scripts/verify-sdk.mjs   (router must be running)
 */

import { readFileSync } from 'node:fs';
import OpenAI from 'openai';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const baseURL = `http://127.0.0.1:${env.ROUTER_PORT ?? 20128}/v1`;
const MOCK = `http://127.0.0.1:${env.MOCK_PROVIDER_PORT ?? 20129}`;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

const line = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`);

async function mock(patch) {
  await fetch(`${MOCK}/__control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

async function resetHealth() {
  await mock({ reset: true });
  await fetch(`http://127.0.0.1:${env.ROUTER_PORT ?? 20128}/api/admin/health/reset`, {
    method: 'POST',
    headers: { 'x-router-admin-token': env.ADMIN_TOKEN },
  });
}

// The ONE change a client has to make. `apiKey` is the router key, not a
// provider key — the client never learns which upstream serves it.
const client = new OpenAI({
  apiKey: env.ROUTER_API_KEY,
  baseURL,
  maxRetries: 0, // we want to observe the router's behaviour, not the SDK's
});

const sdkVersion = JSON.parse(
  readFileSync(new URL('../node_modules/openai/package.json', import.meta.url), 'utf8'),
).version;

console.log(`openai SDK v${sdkVersion} → ${baseURL}`);
await resetHealth();

line('models.list()');
{
  const page = await client.models.list();
  const ids = page.data.map((m) => m.id);
  check('returns a model page', Array.isArray(page.data) && page.data.length > 0, `${ids.length} models`);
  check('every entry has the required object shape',
    page.data.every((m) => m.id && m.object === 'model' && typeof m.created === 'number'));
  check('profiles are addressable as models', ids.includes('auto'), ids.slice(0, 6).join(', '));
  check('SDK iteration protocol works', (await collect(page)).length === page.data.length);
}

line('chat.completions.create()');
{
  const res = await client.chat.completions.create({
    model: 'auto',
    messages: [{ role: 'user', content: 'Say hi via the SDK' }],
  });
  check('resolves without throwing', !!res);
  check('id present', typeof res.id === 'string' && res.id.length > 0, res.id);
  check('object is chat.completion', res.object === 'chat.completion', res.object);
  check('has one choice', res.choices.length === 1);
  check('message.role is assistant', res.choices[0].message.role === 'assistant');
  check('message.content is a string', typeof res.choices[0].message.content === 'string',
    JSON.stringify(res.choices[0].message.content));
  check('finish_reason present', !!res.choices[0].finish_reason, res.choices[0].finish_reason);
  check('usage present with numeric fields',
    typeof res.usage?.prompt_tokens === 'number' && typeof res.usage?.total_tokens === 'number',
    JSON.stringify(res.usage));
  check('echoes the requested model, not the upstream one', res.model === 'auto', res.model);
}

line('chat.completions.create({ stream: true })');
{
  const stream = await client.chat.completions.create({
    model: 'auto',
    messages: [{ role: 'user', content: 'Stream via the SDK' }],
    stream: true,
  });

  let chunks = 0;
  let text = '';
  let finish = null;
  for await (const chunk of stream) {
    chunks++;
    text += chunk.choices[0]?.delta?.content ?? '';
    if (chunk.choices[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
  }
  check('SDK parsed multiple chunks', chunks > 1, `${chunks} chunks`);
  check('deltas assembled into text', text.length > 0, JSON.stringify(text));
  check('terminal chunk carried finish_reason', finish !== null, finish);
}

line('explicit provider/model pinning');
{
  const res = await client.chat.completions.create({
    model: 'mock/mock-smart',
    messages: [{ role: 'user', content: 'pinned' }],
  });
  check('provider-prefixed id accepted', !!res.choices[0].message.content, res.model);
}

line('failover is invisible to the SDK');
{
  await resetHealth();
  await mock({ fail: '429', count: 1 });
  const res = await client.chat.completions.create({
    model: 'auto',
    messages: [{ role: 'user', content: 'fail over for me' }],
  });
  // The SDK has maxRetries: 0, so a 429 reaching the client would throw here.
  check('client saw a clean 200 despite an upstream 429', !!res.choices[0].message.content);
  check('no router metadata leaked into the typed response',
    !('_router' in res), Object.keys(res).join(','));
}

line('error surfaces as a typed SDK error');
{
  await resetHealth();
  try {
    await client.chat.completions.create({ model: 'no-such-model-xyz', messages: [{ role: 'user', content: 'x' }] });
    check('unknown model rejects', false, 'no error thrown');
  } catch (err) {
    check('unknown model rejects', true);
    check('is an OpenAI.APIError', err instanceof OpenAI.APIError, err.constructor.name);
    check('status is 400', err.status === 400, String(err.status));
    check('error.code is machine-readable', err.error?.code === 'invalid_model_format', err.error?.code);
  }

  const badKey = new OpenAI({ apiKey: 'sk-router-not-a-real-key', baseURL, maxRetries: 0 });
  try {
    await badKey.chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: 'x' }] });
    check('bad router key rejects', false, 'no error thrown');
  } catch (err) {
    check('bad router key rejects', true);
    check('is AuthenticationError (401)', err.status === 401, `${err.constructor.name} ${err.status}`);
    check('does not leak provider detail', !/mock-local-key/.test(JSON.stringify(err.error ?? {})));
  }
}

async function collect(page) {
  const out = [];
  for await (const m of page) out.push(m);
  return out;
}

console.log(`\n${'═'.repeat(62)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) console.log(`  failed: ${failures.join(' · ')}`);
console.log('═'.repeat(62));
process.exit(fail ? 1 : 0);
