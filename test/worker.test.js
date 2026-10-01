import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';

const workerUrl = new URL('./fixtures/host-worker.js', import.meta.url);
function worker(t, workerData) {
  const value = new Worker(workerUrl, { workerData });
  t.after(() => value.terminate());
  return value;
}

test('production Worker protocol initializes once and returns SVG strings and transferred PNG bytes', async t => {
  const value = worker(t);
  assert.deepEqual((await once(value, 'message'))[0], { type: 'ready' });
  const next = once(value, 'message');
  value.postMessage({ id: 1, format: 'svg', input: { source: 'one' } });
  assert.deepEqual((await next)[0], { type: 'result', id: 1, result: { success: true, svg: '<svg>1</svg>', diagnostics: [] } });
  const pngReply = once(value, 'message');
  value.postMessage({ id: 2, format: 'png', input: { source: 'two' } });
  const result = (await pngReply)[0];
  assert.equal(result.id, 2);
  assert.deepEqual([...result.result.png], [137,80,78,71,13,10,26,10]);
  assert.equal(result.result.count, 2);
});

test('Worker operational failures never forward exception text', async t => {
  const value = worker(t);
  await once(value, 'message');
  const reply = once(value, 'message');
  value.postMessage({ id: 1, format: 'png', input: { source: 'throw' } });
  assert.deepEqual((await reply)[0], { type: 'failure', id: 1 });
});

for (const code of ['UNSUPPORTED_CAPABILITY', 'UNKNOWN_SECRET_CODE']) test(`Worker startup failure sanitizes ${code}`, async t => {
  const value = worker(t, { startupFailure: code });
  assert.deepEqual((await once(value, 'message'))[0], { type: 'startup-error', code: code === 'UNSUPPORTED_CAPABILITY' ? code : 'WORKER_STARTUP_FAILED' });
});
