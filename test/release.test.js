import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseIdentity as schemaReleaseIdentity, validateRegistryLock as schemaRegistryLock, validatePublication as schemaPublication, verifyAnonymousImage, validateChannelAdvance as schemaChannelAdvance, readChannelVersion, verifyImmutableImage as schemaImmutableImage } from '../scripts/release.mjs';
import { createHash } from 'node:crypto';
import { publishImageReferences } from '../scripts/release.mjs';
// Historical receipts select their own protocol instead of inheriting the active target.
const releaseIdentity = (tag, version, commit, options = { legacy: true }) => schemaReleaseIdentity(tag, version, commit, options);
const validateRegistryLock = (pkg, lock, options = { legacy: true }) => schemaRegistryLock(pkg, lock, options);
const validatePublication = (...inputs) => schemaPublication(...inputs, { legacy: true });
const validateChannelAdvance = (next, current, options = { legacy: true }) => schemaChannelAdvance(next, current, options);
const verifyImmutableImage = (identity, imageId, request) => schemaImmutableImage(identity, imageId, request, { legacy: true });
const sha = 'a'.repeat(40);
const digestOf = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
function registryFixture(identity, indexed = false) {
 const config = Buffer.from(JSON.stringify({os:'linux',architecture:'amd64',config:{Labels:{'org.opencontainers.image.version':identity.version,'org.opencontainers.image.revision':identity.commit}}}));
 const configDigest=digestOf(config);
 const manifest=Buffer.from(JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config:{digest:configDigest}}));
 const manifestDigest=digestOf(manifest);
 const index=Buffer.from(JSON.stringify({schemaVersion:2,mediaType:'application/vnd.oci.image.index.v1+json',manifests:[{digest:manifestDigest,platform:{os:'linux',architecture:'amd64'}},{digest:'sha256:'+'f'.repeat(64),platform:{os:'unknown',architecture:'unknown'},annotations:{'vnd.docker.reference.type':'attestation-manifest'}}]}));
 const top=indexed?index:manifest, topDigest=digestOf(top);
 const objects=new Map([[configDigest,config],[manifestDigest,manifest],[topDigest,top]]);
 const tags=new Map([[identity.version,topDigest],['sha-'+identity.commit,topDigest],[identity.channel,topDigest]]);
 const calls=[];
 const request=async (url,options)=>{
  calls.push([url,options]);
  if(url.includes('/token?'))return Response.json({token:'anonymous'});
  const ref=url.split('/').at(-1);
  if(url.includes('/manifests/')) {
   assert.ok(options.headers.accept.includes('application/vnd.oci.image.index.v1+json'));
   assert.ok(options.headers.accept.includes('application/vnd.docker.distribution.manifest.list.v2+json'));
  } else assert.equal(options.redirect,'follow');
  const bytes=objects.get(tags.get(ref)??ref);
  return bytes?new Response(bytes):new Response('',{status:404});
 };
 return {config,configDigest,manifest,manifestDigest,index,topDigest,objects,tags,calls,request};
}
test('immutable tags accept retained index identity and legacy config identity with exact provenance',async()=>{
 const identity=publication()[0];
 for(const indexed of [false,true]) {
  const f=registryFixture(identity,indexed);
  for(const id of [f.configDigest,f.topDigest])assert.equal(await verifyImmutableImage(identity,id,f.request),true);
  await assert.rejects(verifyImmutableImage(identity,'sha256:'+'e'.repeat(64),f.request),/different image/);
  f.tags.delete(identity.version);assert.equal(await verifyImmutableImage(identity,f.topDigest,f.request),false);
 }
 const wrong=registryFixture({...identity,commit:'e'.repeat(40)},true);
 wrong.tags.set('sha-'+identity.commit,wrong.topDigest);
 await assert.rejects(verifyImmutableImage(identity,wrong.topDigest,wrong.request),/revision|provenance/i);
});
test('indexes resolve runtime labels and verify child and config bytes without following attestations',async()=>{
 const identity=publication()[0];
 for(const indexed of [false,true]) {
  const f=registryFixture(identity,indexed),digest='ghcr.io/drawmotive/textgraph-renderer@'+f.topDigest;
  assert.equal(await readChannelVersion(identity.channel,f.request),identity.version);
  assert.equal((await verifyAnonymousImage(digest,f.request)).digest,digest);
  f.objects.set(f.configDigest,Buffer.from('changed config'));
  await assert.rejects(readChannelVersion(identity.channel,f.request),/digest/i);
 }
 const f=registryFixture(identity,true);f.objects.set(f.manifestDigest,Buffer.from('changed child'));
 await assert.rejects(verifyImmutableImage(identity,f.topDigest,f.request),/digest/i);
});
test('registry negotiation errors and ambiguous runtime indexes cannot masquerade as absent tags',async()=>{
 const identity=publication()[0];
 for(const status of [404,503]) {
  const request=async url=>url.includes('/token?')?Response.json({token:'anonymous'}):new Response('OCI index found, but Accept header does not support OCI indexes',{status});
  await assert.rejects(verifyImmutableImage(identity,'sha256:'+'e'.repeat(64),request),/lookup|HTTP/i);
 }
 const f=registryFixture(identity,true),index=JSON.parse(f.index);index.manifests.push(index.manifests[0]);
 const bytes=Buffer.from(JSON.stringify(index)),digest=digestOf(bytes);f.objects.set(digest,bytes);f.tags.set(identity.version,digest);
 await assert.rejects(verifyImmutableImage(identity,digest,f.request),/ambiguous|exactly one/i);
});
test('resumed publication skips existing immutable tags and promotes the exact retained index',async()=>{
 const identity=publication()[0],f=registryFixture(identity,true),writes=[];
 const result=await publishImageReferences(identity,f.topDigest,{request:f.request,options:{legacy:true},execute:async(command,args)=>{
  writes.push([command,args]);
  assert.equal(command,'docker');
  assert.deepEqual(args,['buildx','imagetools','create','--prefer-index=false','--tag',identity.tags[2],identity.image+'@'+f.topDigest]);
 }});
 assert.equal(writes.length,1);
 assert.equal(result.digest,identity.image+'@'+f.topDigest);
});
test('partial publication copies the surviving immutable index without reconstructing its envelope',async()=>{
 const identity=publication()[0],f=registryFixture(identity,true),writes=[];
 f.tags.delete('sha-'+identity.commit);
 await publishImageReferences(identity,f.topDigest,{request:f.request,options:{legacy:true},execute:async(command,args)=>{
  writes.push(args);
  assert.equal(command,'docker');assert.deepEqual(args.slice(0,5),['buildx','imagetools','create','--prefer-index=false','--tag']);
  assert.equal(args[6],identity.image+'@'+f.topDigest);
  f.tags.set(args[5].slice(identity.image.length+1),f.topDigest);
 }});
 assert.deepEqual(writes.map(args=>args[5]),[identity.tags[1],identity.tags[2]]);
});
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
 return [{version:'0.2.2-alpha.3',dependencies:deps}, {packages:{'':{dependencies:deps}, ...Object.fromEntries(Object.entries(deps).map(([name,version])=>[`node_modules/${name}`,{version,resolved:`https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,integrity:`sha512-${Buffer.alloc(64).toString('base64')}`}]))}}];
}
test('release requires exact public registry dependencies with truthful integrity',()=>{
 assert.doesNotThrow(()=>validateRegistryLock(...lock()));
 for(const field of ['resolved','integrity','version']) {
  const [pkg,l]=lock();l.packages['node_modules/@drawmotive/textgraph'][field]='file:../local';
  assert.throws(()=>validateRegistryLock(pkg,l));
 }
 const [pkg,l]=lock();pkg.dependencies['@drawmotive/textgraph']='^0.2.2';assert.throws(()=>validateRegistryLock(pkg,l));
});
test('image release version must exactly match its SDK dependency including alpha suffix',()=>{
 for(const version of ['0.1.0-alpha.1','0.2.2-alpha.2','0.2.2','0.3.0']) {
  const [pkg,l]=lock();pkg.version=version;
  assert.throws(()=>validateRegistryLock(pkg,l),/SDK.*version|version.*SDK/i);
 }
 assert.doesNotThrow(()=>validateRegistryLock(...lock()));
});
function publication() {
 const [pkg, dependencies] = lock();
 const identity = releaseIdentity('textgraph-renderer-v0.2.2-alpha.3', pkg.version, sha);
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
test('anonymous manifest access requires the expected registry destination and exact digest',async()=>{
 const f=registryFixture(publication()[0]),digest='ghcr.io/drawmotive/textgraph-renderer@'+f.topDigest;
 assert.equal((await verifyAnonymousImage(digest,f.request)).digest,digest);
 assert.equal(f.calls[0][1].headers?.authorization,undefined);
 assert.equal(f.calls[1][1].headers.authorization,'Bearer anonymous');
 for(const status of [401,403,404])await assert.rejects(verifyAnonymousImage(digest,async()=>new Response('',{status})),/public|anonymous/i);
 f.objects.set(f.topDigest,Buffer.from('different manifest'));
 await assert.rejects(verifyAnonymousImage(digest,f.request),/digest/i);
 await assert.rejects(verifyAnonymousImage('other.example/pkg@'+f.topDigest,f.request));
});
test('manual retries cannot roll alpha or latest back to an older release', () => {
 for (const [next,current] of [['0.1.0-alpha.2',undefined],['0.1.0-alpha.2','0.1.0-alpha.1'],['0.1.0-alpha.2','0.1.0-alpha.2'],['1.10.0','1.9.0']])
  assert.doesNotThrow(() => validateChannelAdvance(next,current));
 for (const [next,current] of [['0.1.0-alpha.1','0.1.0-alpha.2'],['1.9.0','1.10.0'],['1.0.0','1.0.1'],['0.1.0-alpha.2','unknown'],['0.1.0-alpha.2','0.1.0']])
  assert.throws(() => validateChannelAdvance(next,current));
});
test('missing channel and immutable tags are distinct from registry failures',async()=>{
 const identity=publication()[0],f=registryFixture(identity);f.tags.clear();
 assert.equal(await readChannelVersion(identity.channel,f.request),undefined);
 assert.equal(await verifyImmutableImage(identity,f.configDigest,f.request),false);
 await assert.rejects(readChannelVersion('arbitrary',f.request));
 await assert.rejects(verifyImmutableImage(identity,f.configDigest,async url=>url.includes('/token?')?Response.json({token:'anonymous'}):new Response('',{status:503})),/HTTP 503/);
});

test('numeric renderer releases use latest for every patch and preserve historical comparison', () => {
 for (let patch=0;patch<=12;patch++) {
  const version='0.3.'+patch;
  assert.equal(releaseIdentity('textgraph-renderer-v'+version,version,sha,{legacy:false}).channel,'latest');
 }
 for (const version of ['0.3.1-alpha.1','00.3.1']) assert.throws(()=>releaseIdentity('textgraph-renderer-v'+version,version,sha,{legacy:false}));
 assert.doesNotThrow(()=>validateChannelAdvance('0.3.2','0.2.2-alpha.12',{legacy:false}));
 assert.throws(()=>validateChannelAdvance('0.3.2','0.3.12',{legacy:false}),/older release/);
});
test('numeric renderer publication requires canonical dependencies with one release identity', () => {
 const [pkg,l]=lock();
 const version='0.3.2';pkg.version=version;
 for(const name of Object.keys(pkg.dependencies)) {
  pkg.dependencies[name]=version;l.packages[''].dependencies[name]=version;
  l.packages['node_modules/'+name]={...l.packages['node_modules/'+name],version,resolved:'https://registry.npmjs.org/'+name+'/-/'+name.split('/').at(-1)+'-'+version+'.tgz'};
 }
 assert.doesNotThrow(()=>validateRegistryLock(pkg,l,{legacy:false}));
 for(const invalid of ['0.3.2-alpha.1','00.3.2']) {
  const name='@drawmotive/textgraph-fonts',original=pkg.dependencies[name];
  pkg.dependencies[name]=invalid;l.packages[''].dependencies[name]=invalid;l.packages['node_modules/'+name].version=invalid;
  assert.throws(()=>validateRegistryLock(pkg,l,{legacy:false}),/suffixes are forbidden/);
  pkg.dependencies[name]=original;l.packages[''].dependencies[name]=original;l.packages['node_modules/'+name].version=original;
 }
 const name='@drawmotive/textgraph-fonts',other='0.3.3';
 pkg.dependencies[name]=other;l.packages[''].dependencies[name]=other;
 l.packages['node_modules/'+name].version=other;
 l.packages['node_modules/'+name].resolved='https://registry.npmjs.org/'+name+'/-/textgraph-fonts-'+other+'.tgz';
 assert.throws(()=>validateRegistryLock(pkg,l,{legacy:false}),/same release identity/);
});
