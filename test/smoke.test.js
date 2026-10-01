import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const smoke = new URL('../scripts/smoke.mjs', import.meta.url);
async function endpoint(t, { broken = false } = {}) {
  const server = http.createServer((request, response) => {
    if (request.url === '/health') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ status: 'ready', capacity: 1, ready: 1, busy: 0, unavailable: 0 })); return; }
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('access-control-expose-headers', 'X-TextGraph-Warning-Count');
    if (request.method === 'OPTIONS') { response.statusCode = 204; response.end(); return; }
    const chunks = [];
    request.on('data', value => chunks.push(value));
    request.on('end', () => {
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (input.source === 'A ->') { response.statusCode = 422; response.setHeader('content-type','application/json'); response.end(JSON.stringify({ code: 'RENDER_FAILED', diagnostics: [{ code: 'TG001', severity: 'error', stage: 'parse', message: 'Expected a node', location: { line: 0, column: 4 } }] })); return; }
      response.setHeader('x-textgraph-warning-count', '0');
      if (request.url.endsWith('/svg')) { response.setHeader('content-type', 'image/svg+xml; charset=utf-8'); response.end(broken ? 'fake svg' : '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><path d="M1 1L2 2"/></svg>'); }
      else {
        response.setHeader('content-type', 'image/png');
        const png = Buffer.alloc(33);
        png.set([137,80,78,71,13,10,26,10]);
        png.writeUInt32BE(13, 8); png.write('IHDR', 12); png.writeUInt32BE(100, 16); png.writeUInt32BE(50, 20);
        response.end(png);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('smoke checks remote PNG, SVG, language cases, diagnostics, health and CORS', async t => {
  const url = await endpoint(t);
  const result = await execute(process.execPath, [smoke.pathname, '--base-url', url]);
  assert.match(result.stdout, /passed/i);
});

test('smoke rejects image responses with no vector SVG document', async t => {
  const url = await endpoint(t, { broken: true });
  await assert.rejects(execute(process.execPath, [smoke.pathname, '--base-url', url]));
});

test('smoke rejects ambiguous target arguments instead of testing the wrong image', async () => {
  await assert.rejects(execute(process.execPath, [smoke.pathname, '--image', 'example', '--base-url', 'http://localhost:8080']));
});

test('image smoke receipt binds passed checks to immutable bytes and invalidates a previous receipt on failure', async t => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'textgraph-smoke-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executable = join(directory, 'docker');
  await writeFile(executable, `#!${process.execPath}
const args=process.argv.slice(2);
const metadata={serviceVersion:'0.1.0-alpha.1',sdkVersion:'candidate',engineCommit:'a'.repeat(40)};
if(args[0]==='run')process.stdout.write('container');
else if(args[0]==='inspect')process.stdout.write(JSON.stringify([{Image:'sha256:immutable-tested-bytes',HostConfig:{ReadonlyRootfs:true},Config:{User:'node'},NetworkSettings:{Ports:{'8080/tcp':[{HostPort:process.env.SMOKE_PORT}]}}}]));
else if(args[0]==='exec')process.stdout.write(JSON.stringify(metadata));
`, { mode: 0o755 });
  const url = await endpoint(t);
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, SMOKE_PORT: new URL(url).port };
  await execute(process.execPath, [smoke.pathname, '--image', 'mutable-alias', '--expected-version', '0.1.0-alpha.1'], { cwd: directory, env });
  const receipt = JSON.parse(await readFile(join(directory, 'smoke-receipt.json'), 'utf8'));
  assert.equal(receipt.imageId, 'sha256:immutable-tested-bytes');
  assert.equal(receipt.version, '0.1.0-alpha.1');
  const broken = await endpoint(t, { broken: true });
  await assert.rejects(execute(process.execPath, [smoke.pathname, '--image', 'mutable-alias'], { cwd: directory, env: { ...env, SMOKE_PORT: new URL(broken).port } }));
  await assert.rejects(readFile(join(directory, 'smoke-receipt.json')), { code: 'ENOENT' });
});
