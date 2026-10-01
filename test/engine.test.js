import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.js';

const capabilities = ['textgraph-render-v1', 'textgraph-render-svg-v1', 'textgraph-fonts-v1'];
const catalogUrl = new URL('file:///packaged/fonts/font-catalog.json');
function initializer({ capabilities: supplied = capabilities, warmFailure = false, missingSvg = false } = {}) {
  const calls = [];
  let options;
  let disposed = false;
  const runtime = {
    info: { capabilities: supplied },
    renderPng: async (source, options) => { calls.push(['png', source, options]); return { success: !warmFailure, diagnostics: [], png: Uint8Array.from([1, 2, 3]) }; },
    renderSvg: missingSvg ? undefined : async (source, options) => { calls.push(['svg', source, options]); return { success: true, diagnostics: [], svg: '<svg/>' }; },
    dispose: async () => { disposed = true; },
  };
  return { calls, get options() { return options; }, get disposed() { return disposed; }, initializeTextGraph: async value => { options = value; return runtime; } };
}

test('initialization uses packaged catalog, disables remote fallback and warms required scripts in both formats', async () => {
  const dependency = initializer();
  await createEngine({ initializeTextGraph: dependency.initializeTextGraph, fontCatalogUrl: catalogUrl });
  assert.equal(dependency.options.fontAssets.catalog.href, catalogUrl.href);
  assert.equal(dependency.options.fontAssets.fallback, false);
  await assert.rejects(dependency.options.fetch('https://example.com/fonts.ttf'));
  assert.equal(dependency.calls.length, 2);
  assert.deepEqual(dependency.calls.map(call => call[0]), ['png', 'svg']);
  for (const [, source] of dependency.calls) {
    assert.match(source, /中文/);
    assert.match(source, /日本語/);
    assert.match(source, /😀/);
  }
});

for (const settings of [{ capabilities: ['textgraph-render-v1'] }, { missingSvg: true }]) test('rejects a runtime without native SVG instead of a production fallback', async () => {
  const dependency = initializer(settings);
  await assert.rejects(createEngine({ initializeTextGraph: dependency.initializeTextGraph, fontCatalogUrl: catalogUrl }), { code: 'UNSUPPORTED_CAPABILITY' });
  assert.equal(dependency.calls.length, 0);
  assert.equal(dependency.disposed, true);
});

test('warmup failure disposes the incomplete runtime', async () => {
  const dependency = initializer({ warmFailure: true });
  await assert.rejects(createEngine({ initializeTextGraph: dependency.initializeTextGraph, fontCatalogUrl: catalogUrl }), { code: 'WORKER_STARTUP_FAILED' });
  assert.equal(dependency.disposed, true);
});

test('forwards exact source and options to the requested export format', async () => {
  const dependency = initializer();
  const engine = await createEngine({ initializeTextGraph: dependency.initializeTextGraph, fontCatalogUrl: catalogUrl });
  const source = 'A: unchanged\r\nB: 中文';
  await engine.render('svg', { source, padding: 0, language: 'zh-CN' });
  await engine.render('png', { source, padding: 2, scale: 3, maxWidth: 700 });
  assert.deepEqual(dependency.calls.slice(2), [
    ['svg', source, { padding: 0, language: 'zh-CN' }],
    ['png', source, { padding: 2, scale: 3, maxWidth: 700, encoding: 'bytes' }],
  ]);
});
