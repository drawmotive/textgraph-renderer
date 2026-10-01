import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createService } from '../src/server.js';
import { RenderPool } from '../src/pool.js';

const workerUrl = new URL('./fixtures/worker.js', import.meta.url);
async function service(t, { poolOptions = {}, ...options } = {}) {
  const pool = new RenderPool({ workerUrl, renderTimeoutMs: 1000, startupTimeoutMs: 1000, ...poolOptions });
  await pool.start();
  const app = createService({ pool, ...options });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  return { ...app, pool, url };
}
function post(url, input, format = 'svg', headers = {}) {
  return fetch(`${url}/api/v1/render/${format}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
}
function streamed(url, chunks, { headers = {}, end = true } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(`${url}/api/v1/render/svg`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, response => {
      const data = [];
      response.on('data', chunk => data.push(chunk));
      response.on('end', () => { request.destroy(); resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(data).toString() }); });
    });
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    if (end) request.end();
  });
}
async function waitFor(app, predicate) {
  for (let i = 0; i < 100; i++) {
    const health = await (await fetch(`${app.url}/health`)).json();
    if (predicate(health)) return;
    await delay(10);
  }
  assert.fail('health did not reach the expected state');
}

test('returns actual image content, forwards normalized options, and exposes warnings', async t => {
  const app = await service(t);
  const svg = await post(app.url, { source: 'warning', language: 'zh-CN', padding: 0 });
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type'), /^image\/svg\+xml/);
  assert.equal(svg.headers.get('x-textgraph-warning-count'), '1');
  const body = await svg.text();
  assert.match(body, /"language":"zh-CN"/);
  assert.match(body, /"padding":0/);
  const png = await post(app.url, { source: 'ok', scale: 2, maxWidth: 500 }, 'png');
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.deepEqual([...new Uint8Array(await png.arrayBuffer())], [137,80,78,71,13,10,26,10]);
  const defaults = await (await post(app.url, { source: 'unchanged\r\ntext' })).text();
  assert.match(defaults, /"padding":10/);
  assert.match(defaults, /unchanged\\r\\ntext/);
});

test('compiler errors are 422 with original zero-based UTF-16 diagnostic locations', async t => {
  const app = await service(t);
  const response = await post(app.url, { source: 'invalid' });
  assert.equal(response.status, 422);
  assert.deepEqual((await response.json()).diagnostics, [{ severity: 'error', code: 'TG001', message: 'Invalid syntax', stage: 'parse', location: { start: 2, length: 1, line: 0, column: 2 } }]);
});

test('rejects malformed JSON and requires a JSON media type', async t => {
  const app = await service(t);
  const malformed = await fetch(`${app.url}/api/v1/render/svg`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"source":"SECRET' });
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(await malformed.text(), /SECRET|SyntaxError|stack/);
  const wrong = await post(app.url, { source: 'ok' }, 'png', { 'content-type': 'text/plain' });
  assert.equal(wrong.status, 415);
  const parameter = await post(app.url, { source: 'ok' }, 'svg', { 'content-type': 'application/json; charset=utf-8' });
  assert.equal(parameter.status, 200);
});

const badInputs = [null, [], 1, {}, { source: 1 }, { source: 'ok', unknown: true }, { source: 'ok', padding: -1 }, { source: 'ok', padding: null }, { source: 'ok', padding: 1e99 }, { source: 'ok', language: '' }, { source: 'ok', language: '../file' }, { source: 'ok', scale: 2 }, { source: 'ok', maxWidth: 1 }];
for (const input of badInputs) test(`rejects invalid SVG request ${JSON.stringify(input)}`, async t => {
  const app = await service(t);
  const response = await post(app.url, input);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'INVALID_REQUEST');
});

for (const options of [{ scale: 0 }, { scale: -1 }, { scale: 1e-99 }, { scale: 1e99 }, { maxWidth: 0 }, { maxWidth: 1.5 }, { maxWidth: 1e99 }]) test(`rejects invalid PNG options ${JSON.stringify(options)}`, async t => {
  const app = await service(t);
  assert.equal((await post(app.url, { source: 'ok', ...options }, 'png')).status, 400);
});

test('enforces streamed body limit with and without Content-Length', async t => {
  const app = await service(t, { bodyLimitBytes: 64 });
  const chunks = ['{"source":"', 'a'.repeat(30), 'a'.repeat(30), '"}'];
  assert.equal((await streamed(app.url, chunks)).status, 413);
  assert.equal((await streamed(app.url, chunks, { headers: { 'content-length': '100' } })).status, 413);
  assert.equal((await streamed(app.url, ['{"source":"', '😀'.repeat(20), '"}'])).status, 413);
  assert.equal((await post(app.url, { source: 'a'.repeat(51) })).status, 200); // exactly 64 UTF-8 bytes
});

test('incomplete streamed request has a bounded read deadline', async t => {
  const app = await service(t, { bodyTimeoutMs: 40 });
  const response = await streamed(app.url, ['{"source":'], { end: false });
  assert.equal(response.status, 408);
  assert.equal(JSON.parse(response.body).code, 'BODY_TIMEOUT');
  assert.equal((await post(app.url, { source: 'ok' })).status, 200);
});

test('CORS, preflight, and no-store apply to images and errors', async t => {
  const app = await service(t);
  const preflight = await fetch(`${app.url}/api/v1/render/svg`, { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Content-Type/i);
  for (const response of [preflight, await post(app.url, { source: 'ok' }), await post(app.url, { source: 'invalid' })]) {
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('access-control-expose-headers'), /X-TextGraph-Warning-Count/);
  }
});

test('HTTP health stays responsive during render and saturated requests receive Retry-After', async t => {
  const app = await service(t);
  const busy = post(app.url, { source: 'wait' });
  await waitFor(app, health => health.busy === 1);
  const health = await fetch(`${app.url}/health`, { signal: AbortSignal.timeout(100) });
  assert.equal(health.status, 200);
  const rejected = await post(app.url, { source: 'other' });
  assert.equal(rejected.status, 429);
  assert.equal(rejected.headers.get('retry-after'), '1');
  assert.equal((await busy).status, 200);
});

test('HTTP render deadline and crash errors are sanitized and replacement recovers', async t => {
  const app = await service(t, { poolOptions: { renderTimeoutMs: 50 } });
  for (const [source, status] of [['hang', 504], ['crash', 503], ['throw', 503]]) {
    const response = await post(app.url, { source });
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /Error|stack|source|fixture/);
    await waitFor(app, health => health.ready === 1);
    assert.equal((await post(app.url, { source: 'ok' })).status, 200);
  }
});

test('disconnected HTTP clients terminate active rendering', async t => {
  const app = await service(t);
  const request = http.request(`${app.url}/api/v1/render/svg`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  request.on('error', () => {});
  request.end(JSON.stringify({ source: 'hang' }));
  await waitFor(app, health => health.busy === 1);
  request.destroy();
  await waitFor(app, health => health.busy === 0 && health.ready === 1);
  assert.equal((await post(app.url, { source: 'ok' })).status, 200);
});

test('failed Worker initialization is visible through health and render routes', async t => {
  const app = await service(t, { poolOptions: { workerData: { startup: 'fail' } } });
  const health = await fetch(`${app.url}/health`);
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), { status: 'unavailable', capacity: 1, ready: 0, busy: 0, unavailable: 1 });
  assert.equal((await post(app.url, { source: 'ok' })).status, 503);
});

test('unknown paths and wrong methods have explicit status codes', async t => {
  const app = await service(t);
  assert.equal((await fetch(`${app.url}/missing`)).status, 404);
  const wrong = await fetch(`${app.url}/api/v1/render/svg`);
  assert.equal(wrong.status, 405);
  assert.match(wrong.headers.get('allow'), /POST/);
});

test('rejects malformed UTF-8 rather than rewriting source during decoding', async t => {
  const app = await service(t);
  const invalid = Buffer.concat([Buffer.from('{"source":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
  assert.equal((await streamed(app.url, [invalid])).status, 400);
});

test('unexpected operational errors receive a generic 500 response', async t => {
  const pool = { health: () => ({ capacity: 1, ready: 1, busy: 0, unavailable: 0 }), render: async () => { throw new Error('SECRET stack and source'); }, close: async () => {} };
  const app = createService({ pool });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const response = await post(`http://127.0.0.1:${app.server.address().port}`, { source: 'secret source' });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).code, 'INTERNAL_ERROR');
});
