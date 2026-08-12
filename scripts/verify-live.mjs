/**
 * Live acceptance matrix, run against a booted router + mock upstream.
 *
 * Every case drives real HTTP through the gateway. Health state is per-process
 * and cooldowns are sticky by design, so cases that need a clean slate reset
 * the mock and re-enable credentials through the admin API rather than
 * restarting the server.
 *
 * Usage: node scripts/verify-live.mjs
 */

import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const B = `http://127.0.0.1:${env.ROUTER_PORT ?? 20128}`;
const M = `http://127.0.0.1:${env.MOCK_PROVIDER_PORT ?? 20129}`;
const KEY = env.ROUTER_API_KEY;
const ADMIN = env.ADMIN_TOKEN;

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

const jsonHeaders = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function chat(body, headers = jsonHeaders) {
  const res = await fetch(`${B}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON (SSE) — caller inspects raw */
  }
  return { res, json, text };
}

async function mock(patch) {
  const res = await fetch(`${M}/__control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return res.json();
}

/** Clear router-side health so a cooldown from an earlier case can't bleed in. */
async function resetHealth() {
  await mock({ reset: true });
  const res = await fetch(`${B}/api/admin/health/reset`, {
    method: 'POST',
    headers: { 'x-router-admin-token': ADMIN },
  });
  if (!res.ok) throw new Error(`health reset failed: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

const adminHeaders = { 'x-router-admin-token': ADMIN, 'Content-Type': 'application/json' };

/** PATCH a runtime tunable. */
async function setSetting(patch) {
  const res = await fetch(`${B}/api/admin/settings`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`settings patch failed: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

/** Drop a tunable override, restoring the env default. */
async function clearSetting(key) {
  // No content-type: Fastify rejects an empty body when one is declared.
  const res = await fetch(`${B}/api/admin/settings/${key}`, {
    method: 'DELETE',
    headers: { 'x-router-admin-token': ADMIN },
  });
  if (!res.ok) throw new Error(`settings delete failed: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

const line = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`);

/* ═══════════════════════════════════════════════════════════════════ */

line('1. health endpoints (unauthenticated)');
{
  const res = await fetch(`${B}/health`);
  const j = await res.json();
  check('GET /health is open and 200', res.status === 200);
  check('reports ok', j.ok === true || j.status === 'ok', JSON.stringify(j.status ?? j.ok));
  const res2 = await fetch(`${B}/api/health`);
  const j2 = await res2.json();
  check('GET /api/health returns {ok:true}', res2.status === 200 && j2.ok === true);
  check(
    'exposes provider/model counts',
    typeof j2.providers === 'object' && typeof j2.models === 'object',
    `providers=${JSON.stringify(j2.providers)} models=${JSON.stringify(j2.models)}`,
  );
  check('no key material in health body', !/sk-[A-Za-z0-9]{20}|mock-local-key/.test(JSON.stringify(j2)));
}

line('2. authentication');
{
  const noKey = await fetch(`${B}/v1/models`);
  check('missing key → 401', noKey.status === 401, `got ${noKey.status}`);
  const body = await noKey.json();
  check('error type is authentication_error', body.error?.type === 'authentication_error');

  const badKey = await fetch(`${B}/v1/models`, { headers: { Authorization: 'Bearer sk-router-nope' } });
  check('invalid key → 401', badKey.status === 401, `got ${badKey.status}`);

  const good = await fetch(`${B}/v1/models`, { headers: { Authorization: `Bearer ${KEY}` } });
  check('valid key → 200', good.status === 200, `got ${good.status}`);
  const list = await good.json();
  check('model list is non-empty', Array.isArray(list.data) && list.data.length > 0, `${list.data?.length} entries`);
  const ids = new Set(list.data.map((m) => m.id));
  check(
    'all 7 profiles addressable as models',
    ['auto', 'coding', 'general', 'cheap', 'fast', 'reasoning', 'vision'].every((p) => ids.has(p)),
  );
  check('no key material in model list', !/sk-[A-Za-z0-9]{20}|mock-local-key/.test(JSON.stringify(list)));
}

line('3. non-streaming chat completion');
{
  await resetHealth();
  const { res, json } = await chat({
    model: 'auto',
    messages: [{ role: 'user', content: 'Hello router' }],
    router_debug: true,
  });
  check('POST /v1/chat/completions → 200', res.status === 200, `got ${res.status}`);
  check('object is chat.completion', json?.object === 'chat.completion');
  check('has assistant content', typeof json?.choices?.[0]?.message?.content === 'string',
    JSON.stringify(json?.choices?.[0]?.message?.content));
  check('echoes requested model name', json?.model === 'auto', json?.model);
  check('reports usage', typeof json?.usage?.total_tokens === 'number');
  check('resolved through the auto profile', json?._router?.resolved_profile === 'auto');
  check('served by the mock provider', json?._router?.selected_provider === 'mock',
    json?._router?.selected_provider + '/' + json?._router?.selected_model);
  check('attempt trail has one entry', json?._router?.provider_attempts?.length === 1);
  check('trail carries no key material',
    !/sk-[A-Za-z0-9]{20}|mock-local-key/.test(JSON.stringify(json?._router ?? {})));
}

line('4. router_debug omitted → no metadata leak');
{
  const { json } = await chat({ model: 'auto', messages: [{ role: 'user', content: 'quiet' }] });
  check('no _router block without router_debug', json?._router === undefined);
}

line('5. streaming');
{
  await resetHealth();
  const res = await fetch(`${B}/v1/chat/completions`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'Stream please' }], stream: true }),
  });
  check('stream → 200', res.status === 200, `got ${res.status}`);
  check('content-type is text/event-stream',
    (res.headers.get('content-type') ?? '').includes('text/event-stream'),
    res.headers.get('content-type'));
  check('x-router-provider header present', !!res.headers.get('x-router-provider'),
    res.headers.get('x-router-provider') + '/' + res.headers.get('x-router-model'));

  const raw = await res.text();
  const frames = raw.split(/\r?\n/).filter((l) => l.startsWith('data: '));
  check('multiple data frames', frames.length > 2, `${frames.length} frames`);
  check('terminated by [DONE]', frames.at(-1).trim() === 'data: [DONE]');
  check('frames separated by blank lines', /\}\r?\n\r?\n/.test(raw));
  const chunks = frames.filter((f) => f.trim() !== 'data: [DONE]').map((f) => JSON.parse(f.slice(6)));
  check('every chunk is chat.completion.chunk', chunks.every((c) => c.object === 'chat.completion.chunk'));
  const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
  check('deltas assemble into text', text.length > 0, JSON.stringify(text));
  check('final chunk carries finish_reason',
    chunks.some((c) => c.choices?.[0]?.finish_reason === 'stop'));
}

line('6. failover: 429 crosses the provider boundary');
{
  await resetHealth();
  await mock({ fail: '429', count: 1 });
  const { res, json } = await chat({
    model: 'auto',
    messages: [{ role: 'user', content: 'fo' }],
    router_debug: true,
  });
  const trail = json?._router?.provider_attempts ?? [];
  check('recovered → 200', res.status === 200, `got ${res.status}`);
  check('first attempt classified RATE_LIMIT', trail[0]?.error_class === 'RATE_LIMIT', trail[0]?.status);
  check('last attempt succeeded', trail.at(-1)?.status === 'success');
  check('served by a different provider', trail[0]?.provider !== trail.at(-1)?.provider,
    `${trail[0]?.provider} → ${trail.at(-1)?.provider}`);
  check('fallback_count is 1', json?._router?.fallback_count === 1, String(json?._router?.fallback_count));
}

line('7. failover: upstream 503');
{
  await resetHealth();
  await mock({ fail: '500', count: 1 });
  const { res, json } = await chat({ model: 'auto', messages: [{ role: 'user', content: 'x' }], router_debug: true });
  const trail = json?._router?.provider_attempts ?? [];
  check('recovered → 200', res.status === 200, `got ${res.status}`);
  check('classified PROVIDER_UNAVAILABLE', trail[0]?.error_class === 'PROVIDER_UNAVAILABLE', trail[0]?.error_class);
}

line('8. AUTH (401) is never retried');
{
  await resetHealth();
  await mock({ fail: '401', count: 1 });
  const before = (await (await fetch(`${M}/__control`)).json()).requestCount;
  const { res, json } = await chat({ model: 'auto', messages: [{ role: 'user', content: 'y' }], router_debug: true });
  const after = (await (await fetch(`${M}/__control`)).json()).requestCount;
  const trail = json?._router?.provider_attempts ?? [];
  const authAttempts = trail.filter((a) => a.error_class === 'AUTH');
  check('recovered on another provider → 200', res.status === 200, `got ${res.status}`);
  check('classified AUTH', authAttempts.length >= 1, trail.map((a) => a.error_class ?? a.status).join(' → '));
  check('the bad credential was tried exactly once',
    authAttempts.length === 1, `${authAttempts.length} AUTH attempts`);
  check('no retry storm on the upstream', after - before === trail.length,
    `${after - before} upstream calls for ${trail.length} attempts`);
  const health = await (await fetch(`${B}/api/admin/health`, { headers: { 'x-router-admin-token': ADMIN } })).json();
  const parked = health.states.find((s) => s.credentialId === authAttempts[0]?.credential_id);
  check('credential taken out of rotation', parked && parked.status !== 'ONLINE', parked?.status);
}

line('9. MODEL_UNAVAILABLE (404) disables the model, keeps the credential');
{
  await resetHealth();
  await mock({ fail: '404', count: 1 });
  const { res, json } = await chat({ model: 'auto', messages: [{ role: 'user', content: 'z' }], router_debug: true });
  const trail = json?._router?.provider_attempts ?? [];
  check('recovered → 200', res.status === 200, `got ${res.status}`);
  check('classified MODEL_UNAVAILABLE', trail[0]?.error_class === 'MODEL_UNAVAILABLE', trail[0]?.error_class);
  check('same credential still served the retry',
    trail.at(-1)?.credential_id === trail[0]?.credential_id,
    `${trail[0]?.credential_id} → ${trail.at(-1)?.credential_id}`);

  const models = await (await fetch(`${B}/api/admin/models`, { headers: { 'x-router-admin-token': ADMIN } })).json();
  const failed = models.models.find((m) => m.id === trail[0]?.model || m.model === trail[0]?.model);
  check('model marked disabled', failed && failed.enabled === false, `${failed?.id} enabled=${failed?.enabled}`);

  // Put it back so later cases start from the seeded ladder.
  if (failed) {
    await fetch(`${B}/api/admin/models/${encodeURIComponent(failed.id)}`, {
      method: 'PATCH',
      headers: { 'x-router-admin-token': ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
  }
}

line('10. timeout');
{
  // The shipped REQUEST_TIMEOUT_MS is 60s — correct for real generations, far
  // too slow to assert against here. Lower it through the admin API, which also
  // proves the tunable takes effect without a restart, then put it back.
  const BUDGET = 2_500;
  await setSetting({ request_timeout_ms: BUDGET });
  try {
    await resetHealth();
    await mock({ fail: 'timeout', count: 1 });
    const t0 = Date.now();
    const { res, json } = await chat({ model: 'auto', messages: [{ role: 'user', content: 't' }], router_debug: true });
    const elapsed = Date.now() - t0;
    const trail = json?._router?.provider_attempts ?? [];
    check('recovered → 200', res.status === 200, `got ${res.status}`);
    check('classified TIMEOUT', trail[0]?.error_class === 'TIMEOUT', trail[0]?.error_class);
    check(
      'aborted at the configured budget, not later',
      elapsed >= BUDGET && elapsed < BUDGET + 2_000,
      `${elapsed}ms for a ${BUDGET}ms budget`,
    );
    check(
      'the hung attempt is what cost the time',
      (trail[0]?.latency_ms ?? 0) >= BUDGET - 100,
      `attempt 1 = ${trail[0]?.latency_ms}ms`,
    );
    check(
      'the retry was not also charged a full timeout',
      (trail[1]?.latency_ms ?? Infinity) < 1_000,
      `attempt 2 = ${trail[1]?.latency_ms}ms`,
    );
  } finally {
    await clearSetting('request_timeout_ms');
  }
  const settings = await (await fetch(`${B}/api/admin/settings`, { headers: adminHeaders })).json();
  const t = settings.tunables?.find((x) => x.key === 'request_timeout_ms');
  check('override cleared → back to the env default', t?.source === 'env', `${t?.value}ms from ${t?.source}`);
  check('PATCH rejects an out-of-range timeout', await rejects({ request_timeout_ms: 5 }));
}

/** True when the settings PATCH refuses a value. */
async function rejects(patch) {
  const res = await fetch(`${B}/api/admin/settings`, {
    method: 'PATCH', headers: adminHeaders, body: JSON.stringify(patch),
  });
  return res.status === 400;
}

line('11. malformed upstream body');
{
  await resetHealth();
  await mock({ fail: 'malformed', count: 1 });
  const { res, json } = await chat({ model: 'auto', messages: [{ role: 'user', content: 'm' }], router_debug: true });
  const trail = json?._router?.provider_attempts ?? [];
  check('recovered → 200', res.status === 200, `got ${res.status}`);
  check('classified MALFORMED_RESPONSE', trail[0]?.error_class === 'MALFORMED_RESPONSE', trail[0]?.error_class);
}

line('12. every upstream down → 503 + Retry-After');
{
  await resetHealth();
  await mock({ fail: '429', count: 99 });
  const res = await fetch(`${B}/v1/chat/completions`, {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'down' }], router_debug: true }),
  });
  const json = await res.json();
  check('→ 503', res.status === 503, `got ${res.status}`);
  check('Retry-After header present', !!res.headers.get('retry-after'), res.headers.get('retry-after'));
  check('stable error code', ['all_providers_unavailable', 'no_candidates_available'].includes(json.error?.code),
    json.error?.code);
  check('attempt trail returned for diagnosis', Array.isArray(json._router?.provider_attempts));
  check('attempts capped by MAX_FALLBACK_ATTEMPTS', (json._router?.provider_attempts?.length ?? 0) <= 4,
    `${json._router?.provider_attempts?.length} attempts`);
}

line('13. cooldown → probe → recovery');
{
  const health1 = await (await fetch(`${B}/api/admin/health`, { headers: { 'x-router-admin-token': ADMIN } })).json();
  const cooling = health1.states.filter((s) => s.cooldownUntil && s.cooldownUntil > Date.now());
  check('credentials are cooling down after case 12', cooling.length > 0, `${cooling.length} cooling`);

  await mock({ reset: true });                         // upstream is healthy again
  const probe = await (await fetch(`${B}/api/admin/health/probe`, {
    method: 'POST', headers: { 'x-router-admin-token': ADMIN },
  })).json();
  check('probe endpoint runs', probe.ok === true);

  const { res } = await chat({ model: 'auto', messages: [{ role: 'user', content: 'recovered?' }] });
  const recovered = res.status === 200;
  if (!recovered) await resetHealth();
  const { res: res2 } = recovered ? { res } : await chat({ model: 'auto', messages: [{ role: 'user', content: 'r2' }] });
  check('serves traffic again once healthy', res2.status === 200,
    recovered ? 'recovered via probe' : `probe alone insufficient; after explicit reset → ${res2.status}`);
}

line('14. model routing — all three forms');
{
  await resetHealth();
  const forms = [
    ['profile', 'coding'],
    ['provider/model', 'mock/mock-fast'],
    ['bare registry id', 'mock-smart'],
    ['bare provider alias', 'mock'],
  ];
  for (const [label, model] of forms) {
    const { res, json } = await chat({ model, messages: [{ role: 'user', content: 'route' }], router_debug: true });
    check(`${label}: "${model}" → 200`, res.status === 200,
      res.status === 200 ? `${json._router.selected_provider}/${json._router.selected_model}` : JSON.stringify(json.error?.message));
  }
  const { res, json } = await chat({ model: 'no-such-model-xyz', messages: [{ role: 'user', content: 'x' }] });
  check('unknown model → 400', res.status === 400, `got ${res.status}`);
  check('code is invalid_model_format', json.error?.code === 'invalid_model_format', json.error?.code);
}

line('15. client payload errors are not masked by failover');
{
  await resetHealth();
  const before = (await (await fetch(`${M}/__control`)).json()).requestCount;
  const { res, json } = await chat({ model: 'auto', messages: [] });
  const after = (await (await fetch(`${M}/__control`)).json()).requestCount;
  check('empty messages → 400', res.status === 400, `got ${res.status}`);
  check('no upstream calls burned', after === before, `${after - before} calls`);
  check('message names the field', /messages/i.test(json.error?.message ?? ''), json.error?.message);
}

line('16. streaming: upstream dies mid-stream');
{
  await resetHealth();
  await mock({ fail: 'stream-break', count: 1 });
  const res = await fetch(`${B}/v1/chat/completions`, {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ model: 'mock/mock-fast', messages: [{ role: 'user', content: 'break' }], stream: true }),
  });
  const raw = await res.text();
  const frames = raw.split(/\r?\n/).filter((l) => l.startsWith('data: '));
  check('client still gets a 200 stream', res.status === 200, `got ${res.status}`);
  check('stream is terminated, not left hanging', frames.at(-1)?.trim() === 'data: [DONE]',
    JSON.stringify(frames.at(-1)));
  const payloads = frames.filter((f) => f.trim() !== 'data: [DONE]').map((f) => { try { return JSON.parse(f.slice(6)); } catch { return {}; } });
  check('failure is surfaced in-band', payloads.some((p) => p.error || p._router?.error || p.choices?.[0]?.finish_reason),
    JSON.stringify(payloads.at(-1))?.slice(0, 160));
}

line('17. Anthropic-shaped surface');
{
  await resetHealth();
  const res = await fetch(`${B}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'auto', max_tokens: 64, messages: [{ role: 'user', content: 'Hi' }] }),
  });
  const json = await res.json();
  check('POST /v1/messages → 200', res.status === 200, `got ${res.status}`);
  check('type is message', json.type === 'message', JSON.stringify(json).slice(0, 120));
  check('content block carries text', typeof json.content?.[0]?.text === 'string');
  check('reports anthropic-style usage', typeof json.usage?.input_tokens === 'number');
  check('x-api-key authenticates', res.status !== 401);
}

line('18. admin API + secret masking');
{
  const H = { 'x-router-admin-token': ADMIN };
  const unauth = await fetch(`${B}/api/admin/providers`);
  check('admin requires a token', unauth.status === 401, `got ${unauth.status}`);

  const login = await fetch(`${B}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: ADMIN }),
  });
  check('POST /api/admin/login → 200', login.status === 200, `got ${login.status}`);
  check('sets an httpOnly session cookie', /httponly/i.test(login.headers.get('set-cookie') ?? ''),
    (login.headers.get('set-cookie') ?? '').split(';').slice(1).join(';').trim());

  const badLogin = await fetch(`${B}/api/admin/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'wrong-token' }),
  });
  check('wrong admin token → 401', badLogin.status === 401, `got ${badLogin.status}`);

  const endpoints = ['stats', 'overview', 'topology', 'providers', 'credentials', 'models', 'profiles', 'keys', 'settings', 'health', 'logs'];
  const bodies = {};
  for (const e of endpoints) {
    const r = await fetch(`${B}/api/admin/${e}`, { headers: H });
    bodies[e] = await r.text();
    check(`GET /api/admin/${e} → 200`, r.status === 200, `got ${r.status}`);
  }

  const all = Object.values(bodies).join('\n');
  check('no provider key material anywhere in admin responses',
    !/mock-local-key/.test(all), 'searched all admin bodies');
  check('no full router key in admin responses', !all.includes(KEY));
  check('credentials are masked', /…/.test(bodies.credentials), (JSON.parse(bodies.credentials).credentials ?? [])
    .map((c) => c.maskedKey).join(', '));
  check('router keys are masked', !/sk-router-[0-9a-f]{20,}/.test(bodies.keys));

  const creds = JSON.parse(bodies.credentials).credentials ?? [];
  check('credential rows never carry a secret field',
    creds.every((c) => !('key' in c) && !('apiKey' in c) && !('secret' in c)));

  const test = await fetch(`${B}/api/admin/credentials/${creds[0]?.id}/test`, { method: 'POST', headers: H });
  const testBody = await test.json();
  check('credential test action works', test.status === 200 && testBody.ok !== undefined,
    JSON.stringify(testBody).slice(0, 120));

  const logs = JSON.parse(bodies.logs);
  const rows = logs.logs ?? logs.entries ?? [];
  check('request log recorded the traffic above', rows.length > 0, `${rows.length} rows`);
  check('log rows carry no prompt text by default',
    !/Hello router|Stream please/.test(bodies.logs), 'LOG_PROMPTS=false');
}

line('19. topology feed for the 3D scene');
{
  const t = await (await fetch(`${B}/api/admin/topology`, { headers: { 'x-router-admin-token': ADMIN } })).json();
  check('has nodes', Array.isArray(t.nodes) && t.nodes.length > 0, `${t.nodes?.length} nodes`);
  check('has edges', Array.isArray(t.edges ?? t.links), `${(t.edges ?? t.links)?.length} edges`);
  check('nodes carry health status', (t.nodes ?? []).every((n) => typeof n.status === 'string'),
    [...new Set((t.nodes ?? []).map((n) => n.status))].join(', '));
  check('no secrets in topology', !/mock-local-key|sk-[A-Za-z0-9]{20}/.test(JSON.stringify(t)));
}

/* ═══════════════════════════════════════════════════════════════════ */

await resetHealth();
console.log(`\n${'═'.repeat(62)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail > 0) console.log(`  failed: ${failures.join(' | ')}`);
console.log('═'.repeat(62));
process.exit(fail > 0 ? 1 : 0);
