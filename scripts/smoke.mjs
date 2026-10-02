import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { rm, writeFile } from 'node:fs/promises';

const execute = promisify(execFile);
const docker = async (...args) => (await execute('docker', args, { timeout: 60000, maxBuffer: 1024 * 1024 })).stdout.trim();
const argumentsMap = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  if (!['--image', '--base-url', '--expected-version'].includes(key) || !process.argv[index + 1] || argumentsMap.has(key)) throw new Error('Use --image IMAGE or --base-url URL, with optional --expected-version VERSION.');
  argumentsMap.set(key, process.argv[index + 1]);
}
const image = argumentsMap.get('--image') ?? process.env.IMAGE;
const remote = argumentsMap.get('--base-url') ?? process.env.BASE_URL;
const expectedVersion = argumentsMap.get('--expected-version') ?? process.env.EXPECTED_VERSION;
assert.ok(Boolean(image) !== Boolean(remote), 'Choose exactly one image or base URL.');
assert.ok(!expectedVersion || image, 'Version inspection requires --image.');

async function smoke(baseUrl) {
  const request = (path, options = {}) => fetch(new URL(path, baseUrl), { ...options, signal: AbortSignal.timeout(35000) });
  let initialized = false;
  for (let attempt = 0; attempt < 180; attempt++) {
    try {
      const health = await request('/health');
      if (health.status === 200) {
        const value = await health.json();
        assert.ok(value.ready > 0 && value.capacity >= value.ready);
        initialized = true; break;
      }
    } catch { /* The process may still be starting. */ }
    await delay(250);
  }
  assert.ok(initialized, 'Worker initialization did not complete.');
  const preflight = await request('/api/v1/render/svg', { method: 'OPTIONS', headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' } });
  assert.equal(preflight.status, 204);
  const render = (format, input) => request(`/api/v1/render/${format}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  for (const input of [
    { source: 'A: Start\nB: Finish\nA -> B' },
    { source: 'A: 中文开始繁體測試', language: 'zh-CN' },
    { source: 'A: 😀 👩‍💻 🇯🇵 👍🏽 1️⃣' },
  ]) {
    for (const format of ['png', 'svg']) {
      const response = await render(format, input);
      assert.equal(response.status, 200, `${format} rendering failed`);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(response.headers.get('access-control-expose-headers'), /X-TextGraph-Warning-Count/);
      assert.equal(response.headers.get('x-textgraph-warning-count'), '0');
      if (format === 'png') {
        assert.equal(response.headers.get('content-type'), 'image/png');
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
        assert.ok(bytes.length >= 33 && bytes.toString('ascii', 12, 16) === 'IHDR');
        assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0);
      } else {
        assert.match(response.headers.get('content-type'), /^image\/svg\+xml/);
        const svg = await response.text();
        assert.match(svg, /<svg\b/);
        assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
        assert.match(svg, /viewBox="[0-9. eE+-]+"/);
        assert.match(svg, /<(?:path|rect|text|circle|polygon)\b/);
      }
    }
  }
  const invalid = await render('svg', { source: 'A ->' });
  assert.equal(invalid.status, 422);
  const failure = await invalid.json();
  assert.equal(failure.code, 'RENDER_FAILED');
  assert.ok(failure.diagnostics.some(item => item.severity === 'error'));
  assert.equal((await request('/health')).status, 200);
}

let container;
try {
  let baseUrl = remote;
  let installed;
  let imageId;
  if (image) {
    await rm('smoke-receipt.json', { force: true });
    container = await docker('run', '--detach', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--publish', '127.0.0.1::8080', image);
    const inspection = JSON.parse(await docker('inspect', container))[0];
    imageId = inspection.Image;
    assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
    assert.ok(inspection.Config.User && !['0', 'root', '0:0'].includes(inspection.Config.User));
    installed = JSON.parse(await docker('exec', container, 'node', '--input-type=module', '-e', "import{readFile}from'node:fs/promises';import{abiManifest}from'@drawmotive/textgraph/node';const service=JSON.parse(await readFile('package.json','utf8'));process.stdout.write(JSON.stringify({serviceVersion:service.version,sdkVersion:abiManifest.packageVersion,engineCommit:abiManifest.privateSource?.commit}));"));
    const provenance = JSON.parse(await docker('exec', container, 'cat', '/app/provenance.json'));
    assert.deepEqual(provenance, installed);
    assert.equal(installed.serviceVersion, installed.sdkVersion, 'Renderer image version must equal installed SDK version');
    if (expectedVersion) assert.equal(installed.serviceVersion, expectedVersion);
    const labels = inspection.Config.Labels ?? {};
    if (labels['org.opencontainers.image.version']) assert.equal(labels['org.opencontainers.image.version'], installed.serviceVersion);
    if (labels['dev.drawmotive.textgraph.version']) assert.equal(labels['dev.drawmotive.textgraph.version'], installed.sdkVersion);
    if (labels['dev.drawmotive.textgraph.engine-commit']) assert.equal(labels['dev.drawmotive.textgraph.engine-commit'], installed.engineCommit);
    const port = inspection.NetworkSettings.Ports['8080/tcp'][0].HostPort;
    baseUrl = `http://127.0.0.1:${port}`;
  }
  await smoke(baseUrl);
  if (image) await writeFile('smoke-receipt.json', `${JSON.stringify({ imageId, version: installed.serviceVersion, sdkVersion: installed.sdkVersion, engineCommit: installed.engineCommit, verifiedAt: new Date().toISOString() }, null, 2)}\n`);
  process.stdout.write('TextGraph renderer smoke passed.\n');
} catch (error) {
  if (container) {
    try { process.stderr.write(`${await docker('logs', container)}\n`); } catch { /* Preserve the smoke failure. */ }
  }
  throw error;
} finally {
  if (container) await docker('rm', '--force', container);
}
