import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInput } from '../src/request.js';

for (const format of ['png', 'svg']) {
  test(`${format} normalizes omitted dark to false and accepts both boolean values`, () => {
    const defaults = { source: 'unchanged\r\ntext', padding: 10, dark: false, ...(format === 'png' ? { scale: 1 } : {}) };
    assert.deepEqual(validateInput({ source: defaults.source }, format), defaults);
    assert.deepEqual(validateInput({ source: defaults.source, dark: false }, format), defaults);
    assert.deepEqual(validateInput({ source: defaults.source, dark: true }, format), { ...defaults, dark: true });
  });

  for (const dark of [null, 0, 1, 'true', 'false', [], {}]) {
    test(`${format} rejects non-boolean dark ${JSON.stringify(dark)}`, () => {
      assert.throws(() => validateInput({ source: 'ok', dark }, format), { code: 'INVALID_REQUEST', status: 400 });
    });
  }
}
