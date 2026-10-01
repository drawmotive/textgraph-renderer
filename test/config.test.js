import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';

test('uses bounded production defaults', () => {
  assert.deepEqual(readConfig({}), { port: 8080, host: '0.0.0.0', size: 1, renderTimeoutMs: 30000, startupTimeoutMs: 30000, bodyLimitBytes: 65536, bodyTimeoutMs: 10000 });
});

test('accepts explicit integer limits and bind address', () => {
  assert.deepEqual(readConfig({ PORT: '9090', HOST: '127.0.0.1', WORKER_COUNT: '8', RENDER_TIMEOUT_MS: '500', WORKER_STARTUP_TIMEOUT_MS: '2000', BODY_LIMIT_BYTES: '1024', BODY_TIMEOUT_MS: '100' }), { port: 9090, host: '127.0.0.1', size: 8, renderTimeoutMs: 500, startupTimeoutMs: 2000, bodyLimitBytes: 1024, bodyTimeoutMs: 100 });
});

for (const [key, value] of [['PORT','0'], ['PORT','65536'], ['WORKER_COUNT','0'], ['WORKER_COUNT','9'], ['WORKER_COUNT','1.5'], ['RENDER_TIMEOUT_MS','0'], ['RENDER_TIMEOUT_MS','Infinity'], ['BODY_TIMEOUT_MS','-1'], ['BODY_LIMIT_BYTES','9007199254740993'], ['WORKER_STARTUP_TIMEOUT_MS',''], ['HOST','']]) test(`rejects invalid ${key}=${value} before startup`, () => {
  assert.throws(() => readConfig({ [key]: value }), /Invalid service configuration/);
});
