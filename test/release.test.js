import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseIdentity, validateRegistryLock, validatePublication, verifyAnonymousImage, validateChannelAdvance, readChannelVersion } from '../scripts/release.mjs';
import { createHash } from 'node:crypto';
const sha = 'a'.repeat(40);
test('stable release uses immutable version, full commit, and latest tags', () => {
  const r = releaseIdentity('textgraph-renderer-v1.2.3', '1.2.3', sha);
  assert.deepEqual(r.tags, ['ghcr.io/drawmotive/textgraph-renderer:1.2.3', `ghcr.io/drawmotive/textgraph-renderer:sha-${sha}`, 'ghcr.io/drawmotive/textgraph-renderer:latest']);
});
test('alpha release never updates latest', () => {
  const r = releaseIdentity('textgraph-renderer-v0.1.0-alpha.1', '0.1.0-alpha.1', sha);
  assert.equal(r.channel, 'alpha');
  assert.ok(r.tags.at(-1).endsWith(':alpha'));
  assert.ok(!r.tags.some(tag => tag.endsWith(':latest')));
});
for (const tag of ['main', 'v1.2.3', 'textgraph-renderer-v01.2.3', 'textgraph-renderer-v1x2x3', 'textgraph-renderer-v1.2.3-beta.1', 'textgraph-renderer-v1.2.3+local', 'textgraph-renderer-v1.2.3;echo x'])
  test(`rejects invalid release tag ${tag}`, () => assert.throws(() => releaseIdentity(tag, '1.2.3', sha)));
test('rejects tag/version drift and missing commit provenance', () => {
  assert.throws(() => releaseIdentity('textgraph-renderer-v1.2.3', '1.2.4', sha));
  assert.throws(() => releaseIdentity('textgraph-renderer-v1.2.3', '1.2.3', 'abc'));
});
test('multi-digit release versions retain exact identity', () => {
  assert.equal(releaseIdentity('textgraph-renderer-v12.34.56-alpha.10', '12.34.56-alpha.10', sha).version, '12.34.56-alpha.10');
});
function lock() {
 const deps={'@drawmotive/textgraph':'0.2.2-alpha.3','@drawmotive/textgraph-fonts':'0.2.2-alpha.1'};
 return [{dependencies:deps}, {packages:{'':{dependencies:deps}, ...Object.fromEntries(Object.entries(deps).map(([name,version])=>[`node_modules/${name}`,{version,resolved:`https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,integrity:`sha512-${Buffer.alloc(64).toString('base64')}`}]))}}];
}
test('release requires exact public registry dependencies with truthful integrity',()=>{
 assert.doesNotThrow(()=>validateRegistryLock(...lock()));
 for(const field of ['resolved','integrity','version']) {
  const [pkg,l]=lock();l.packages['node_modules/@drawmotive/textgraph'][field]='file:../local';
  assert.throws(()=>validateRegistryLock(pkg,l));
 }
 const [pkg,l]=lock();pkg.dependencies['@drawmotive/textgraph']='^0.2.2';assert.throws(()=>validateRegistryLock(pkg,l));
});
function publication() {
 const [pkg, dependencies] = lock();
 pkg.version = '0.1.0-alpha.1';
 const identity = releaseIdentity('textgraph-renderer-v0.1.0-alpha.1', pkg.version, sha);
 const image = { Id: `sha256:${'b'.repeat(64)}`, Config: { Labels: { 'org.opencontainers.image.revision': sha, 'org.opencontainers.image.version': pkg.version } } };
 const provenance = { serviceVersion: pkg.version, sdkVersion: pkg.dependencies['@drawmotive/textgraph'], engineCommit: 'c'.repeat(40) };
 const smoke = { imageId: image.Id, version: pkg.version, sdkVersion: provenance.sdkVersion, engineCommit: provenance.engineCommit, verifiedAt: new Date().toISOString() };
 return [identity, pkg, dependencies, image, provenance, smoke];
}
test('publication binds canonical destination, checkout, dependencies, image and smoke provenance', () => {
 assert.deepEqual(validatePublication(...publication()), publication()[0]);
 for (const field of ['image', 'channel', 'tags']) {
  const inputs = publication();
  inputs[0][field] = field === 'tags' ? ['other.example/evil:latest'] : 'other';
  assert.throws(() => validatePublication(...inputs));
 }
 const drift = [
  inputs => { inputs[1].version = '0.1.0-alpha.2'; },
  inputs => { inputs[3].Id = `sha256:${'d'.repeat(64)}`; },
  inputs => { inputs[3].Config.Labels['org.opencontainers.image.revision'] = 'd'.repeat(40); },
  inputs => { inputs[4].serviceVersion = '0.1.0-alpha.2'; },
  inputs => { inputs[4].sdkVersion = '0.2.2-alpha.2'; },
  inputs => { inputs[4].engineCommit = 'unknown'; },
  inputs => { inputs[5].engineCommit = 'd'.repeat(40); },
  inputs => { inputs[5].sdkVersion = '0.2.2-alpha.2'; },
  inputs => { delete inputs[5].verifiedAt; },
 ];
 for (const change of drift) {
  const inputs = publication(); change(inputs);
  assert.throws(() => validatePublication(...inputs));
 }
});
test('a public release requires anonymous access to the exact registry manifest digest', async () => {
 const bytes = Buffer.from('{"schemaVersion":2}');
 const digest = `ghcr.io/drawmotive/textgraph-renderer@sha256:${createHash('sha256').update(bytes).digest('hex')}`;
 const calls = [];
 const request = async (url, options) => {
  calls.push([url, options]);
  return calls.length === 1 ? Response.json({ token: 'anonymous-pull-token' }) : new Response(bytes);
 };
 assert.equal((await verifyAnonymousImage(digest, request)).digest, digest);
 assert.ok(calls[0][0].startsWith('https://ghcr.io/token?'));
 assert.equal(calls[0][1].headers?.authorization, undefined);
 assert.equal(calls[1][1].headers.authorization, 'Bearer anonymous-pull-token');
 for (const status of [401,403,404])
  await assert.rejects(verifyAnonymousImage(digest, async () => new Response('', { status })), /public|anonymous/i);
 let count = 0;
 await assert.rejects(verifyAnonymousImage(digest, async () => ++count === 1 ? Response.json({ token: 'anonymous' }) : new Response('different bytes')), /digest/i);
 await assert.rejects(verifyAnonymousImage('other.example/pkg@sha256:'+'a'.repeat(64), request));
});
test('manual retries cannot roll alpha or latest back to an older release', () => {
 for (const [next,current] of [['0.1.0-alpha.2',undefined],['0.1.0-alpha.2','0.1.0-alpha.1'],['0.1.0-alpha.2','0.1.0-alpha.2'],['1.10.0','1.9.0']])
  assert.doesNotThrow(() => validateChannelAdvance(next,current));
 for (const [next,current] of [['0.1.0-alpha.1','0.1.0-alpha.2'],['1.9.0','1.10.0'],['1.0.0','1.0.1'],['0.1.0-alpha.2','unknown'],['0.1.0-alpha.2','0.1.0']])
  assert.throws(() => validateChannelAdvance(next,current));
});
test('channel version comes from anonymously fetched and digest-checked image config', async () => {
 const config = Buffer.from(JSON.stringify({config:{Labels:{'org.opencontainers.image.version':'0.1.0-alpha.2'}}}));
 const hash = `sha256:${createHash('sha256').update(config).digest('hex')}`;
 let calls = 0;
 const request = async (_url, options) => {
  calls++;
  if (calls === 1) return Response.json({token:'anonymous'});
  if (calls === 2) return Response.json({schemaVersion:2,config:{digest:hash}});
  assert.equal(options.redirect,'follow','GHCR redirects config blobs to signed storage');
  return new Response(config);
 };
 assert.equal(await readChannelVersion('alpha',request),'0.1.0-alpha.2');
 let missing = 0;
 assert.equal(await readChannelVersion('latest',async () => ++missing === 1 ? Response.json({token:'anonymous'}) : new Response('',{status:404})),undefined);
 calls = 0;
 await assert.rejects(readChannelVersion('alpha',async (...args) => calls < 2 ? request(...args) : new Response('different')),/digest/i);
 await assert.rejects(readChannelVersion('arbitrary',request));
});
