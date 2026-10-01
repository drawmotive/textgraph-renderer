import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { RenderPool } from '../src/pool.js';

const workerUrl = new URL('./fixtures/worker.js', import.meta.url);
async function pool(t, options = {}) {
  const value = new RenderPool({ workerUrl, renderTimeoutMs: 1000, startupTimeoutMs: 1000, ...options });
  t.after(() => value.close());
  await value.start();
  return value;
}
async function ready(value) {
  for (let i = 0; i < 100 && value.health().ready === 0; i++) await delay(10);
  assert.equal(value.health().ready, 1);
}

test('reuses one initialized Worker across consecutive renders', async t => {
  const value = await pool(t);
  const first = await value.render('svg', { source: 'one' });
  const second = await value.render('svg', { source: 'two' });
  assert.equal(first.svg.match(/<text>(\d+):/)[1], second.svg.match(/<text>(\d+):/)[1]);
  assert.deepEqual(value.health(), { capacity: 1, ready: 1, busy: 0, unavailable: 0 });
});

test('rejects saturation immediately while health remains responsive', async t => {
  const value = await pool(t);
  const busy = value.render('svg', { source: 'wait' });
  await assert.rejects(value.render('svg', { source: 'other' }), { code: 'BUSY', status: 429 });
  assert.equal(value.health().busy, 1);
  await busy;
});

test('deadline stops synchronous work and replaces the Worker before reuse', async t => {
  const value = await pool(t, { renderTimeoutMs: 50, workerData: { startupDelay: 30 } });
  const before = await value.render('svg', { source: 'before' });
  await assert.rejects(value.render('svg', { source: 'hang' }), { code: 'RENDER_TIMEOUT', status: 504 });
  assert.equal(value.health().ready, 0);
  await ready(value);
  const after = await value.render('svg', { source: 'after' });
  assert.notEqual(before.svg.match(/<text>(\d+):/)[1], after.svg.match(/<text>(\d+):/)[1]);
});

test('client cancellation terminates active work and restores capacity after initialization', async t => {
  const value = await pool(t);
  const controller = new AbortController();
  const pending = value.render('svg', { source: 'hang' }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'CANCELLED' });
  await ready(value);
  assert.equal((await value.render('svg', { source: 'valid' })).success, true);
});

for (const source of ['crash', 'throw']) test(`${source} replaces damaged Worker and returns sanitized unavailable error`, async t => {
  const value = await pool(t);
  await assert.rejects(value.render('svg', { source }), error => {
    assert.equal(error.code, 'UNAVAILABLE');
    assert.equal(error.status, 503);
    assert.doesNotMatch(error.message, /stack|fixture/);
    return true;
  });
  await ready(value);
  assert.equal((await value.render('svg', { source: 'valid' })).success, true);
});

for (const startup of ['fail', 'hang']) test(`startup ${startup} is unavailable without an immediate respawn loop`, async t => {
  const value = await pool(t, { startupTimeoutMs: 50, workerData: { startup } });
  await assert.rejects(value.render('svg', { source: 'valid' }), { code: 'UNAVAILABLE', status: 503 });
  await delay(80);
  assert.deepEqual(value.health(), { capacity: 1, ready: 0, busy: 0, unavailable: 1 });
});

test('shutdown rejects pending work and terminates Workers', async t => {
  const value = await pool(t);
  const pending = value.render('svg', { source: 'hang' });
  const rejected = assert.rejects(pending, { code: 'UNAVAILABLE', status: 503 });
  await value.close();
  await rejected;
  await assert.rejects(value.render('svg', { source: 'valid' }), { code: 'UNAVAILABLE' });
  assert.equal(value.health().ready, 0);
});

test('two slots permit exactly two independent concurrent renders', async t => {
  const value = await pool(t, { size: 2 });
  const one = value.render('svg', { source: 'wait' });
  const two = value.render('svg', { source: 'wait' });
  await assert.rejects(value.render('svg', { source: 'third' }), { code: 'BUSY' });
  const results = await Promise.all([one, two]);
  assert.notEqual(results[0].svg.match(/<text>(\d+):/)[1], results[1].svg.match(/<text>(\d+):/)[1]);
});

test('closing during initialization cannot resurrect a ready Worker', async t => {
  const value = new RenderPool({ workerUrl, workerData: { startupDelay: 200 }, startupTimeoutMs: 1000 });
  t.after(() => value.close());
  const startup = value.start();
  await value.close();
  await startup;
  await delay(250);
  assert.deepEqual(value.health(), { capacity: 1, ready: 0, busy: 0, unavailable: 1 });
});
