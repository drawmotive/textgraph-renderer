import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateRendererPublisherCheckout } from './publisher-correction.mjs';
import { releaseTag, compareReleaseVersions } from '../.release/release-version.cjs';
const root=path.resolve(import.meta.dirname,'..');
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const run=(command,args)=>execFileSync(command,args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','inherit']}).trim();
// The target schema keeps immutable historical receipts readable while new
// candidates use the shared numeric channel policy.
const releaseOptions=()=>{
 const target=JSON.parse(readFileSync(path.join(root,'.release/target.json'),'utf8'));
 assert.ok([1,2].includes(target.schemaVersion),'Unknown release target schema');
 return {legacy:target.schemaVersion===1,channel:target.channel};
};

/** Publication identity comes only from an immutable version tag and full source commit. */
export function releaseIdentity(tag,version,commit,options=releaseOptions()) {
 const channel=releaseTag(version,options);
 assert.equal(tag,'textgraph-renderer-v'+version,'Release tag must match package version');
 assert.match(commit,/^[a-f0-9]{40}$/,'Release commit must be immutable');
 const image='ghcr.io/drawmotive/textgraph-renderer';
 return {version,commit,tag,channel,image,tags:[`${image}:${version}`,`${image}:sha-${commit}`,`${image}:${channel}`]};
}

/** Public consumers must reproduce dependency installation without private access. */
export function validateRegistryLock(pkg,lock,options=releaseOptions()) {
 releaseTag(pkg.version,options);
 assert.equal(pkg.version,pkg.dependencies?.['@drawmotive/textgraph'],'Renderer image version must equal the exact SDK version');
 for(const name of ['@drawmotive/textgraph','@drawmotive/textgraph-fonts']) {
  const version=pkg.dependencies?.[name],entry=lock.packages?.[`node_modules/${name}`];
  releaseTag(version,options);
  if(!options.legacy) assert.equal(version,pkg.version,'Numeric renderer dependencies must share the same release identity');
  assert.equal(lock.packages?.['']?.dependencies?.[name],version,'Dependency lock drift');
  assert.equal(entry?.version,version,'Installed dependency version drift');
  assert.ok(!entry?.link,'Local/workspace dependencies cannot be published');
  assert.equal(entry?.resolved,`https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,'Require public registry tarball');
  const integrity=/^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(entry?.integrity??'');
  assert.ok(integrity && Buffer.from(integrity[1],'base64').length===64 && Buffer.from(integrity[1],'base64').toString('base64')===integrity[1],'Require true SHA512 integrity');
 }
}

/** A receipt is useful only when every claimed identity agrees with the tested bytes. */
export function validatePublication(identity,pkg,lock,image,provenance,smoke,options) {
 const canonical=releaseIdentity(identity.tag,identity.version,identity.commit,options);
 assert.deepEqual(identity,canonical,'Stored release destination or tags were modified');
 assert.equal(pkg.version,canonical.version,'Checkout version differs from release');
 validateRegistryLock(pkg,lock,options);
 assert.match(image.Id,/^sha256:[a-f0-9]{64}$/,'Missing immutable image ID');
 assert.equal(image.Config.Labels?.['org.opencontainers.image.revision'],canonical.commit,'Image revision differs from release');
 assert.equal(image.Config.Labels?.['org.opencontainers.image.version'],canonical.version,'Image version differs from release');
 assert.equal(provenance.serviceVersion,canonical.version,'Installed service differs from release');
 assert.equal(provenance.sdkVersion,pkg.dependencies['@drawmotive/textgraph'],'Installed SDK differs from registry lock');
 assert.match(provenance.engineCommit,/^[a-f0-9]{40}$/,'Missing immutable engine provenance');
 assert.equal(smoke.imageId,image.Id,'Only a smoke-tested image can be published');
 assert.equal(smoke.version,provenance.serviceVersion,'Smoke tested a different service');
 assert.equal(smoke.sdkVersion,provenance.sdkVersion,'Smoke tested a different SDK');
 assert.equal(smoke.engineCommit,provenance.engineCommit,'Smoke tested a different engine');
 assert.ok(typeof smoke.verifiedAt==='string' && Number.isFinite(Date.parse(smoke.verifiedAt)),'Missing smoke verification timestamp');
 return canonical;
}

/** Public repository visibility does not imply public GHCR visibility. Check without login. */
const manifestAccept='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';
const digestOf=bytes=>'sha256:'+createHash('sha256').update(bytes).digest('hex');
async function anonymousToken(request) {
 const response=await request('https://ghcr.io/token?service=ghcr.io&scope=repository%3Adrawmotive%2Ftextgraph-renderer%3Apull',{signal:AbortSignal.timeout(30000),redirect:'error'});
 assert.ok(response.ok,'Anonymous image access failed. Set the GHCR textgraph-renderer package visibility to Public in GitHub package settings, then rerun this tag workflow.');
 const {token}=await response.json();
 assert.ok(typeof token==='string' && token.length>0,'Missing anonymous registry pull token');
 return token;
}
function registryOptions(token,accept) {
 return {signal:AbortSignal.timeout(30000),redirect:'error',headers:{authorization:`Bearer ${token}`,...(accept?{accept}:{})}};
}
/** Registry identity is the raw top-level digest; Docker may expose that index
 * digest or a legacy config digest as Id. Resolve only the runtime platform,
 * leaving attestations attached to the immutable top-level object. */
async function registryImage(ref,token,request,{missing=false}={}) {
 const response=await request('https://ghcr.io/v2/drawmotive/textgraph-renderer/manifests/'+ref,registryOptions(token,manifestAccept));
 const bytes=Buffer.from(await response.arrayBuffer());
 if(missing&&response.status===404) {
  let errors;
  try {errors=JSON.parse(bytes).errors;} catch {}
  assert.ok(!bytes.length||(Array.isArray(errors)&&errors.length&&errors.every(error=>error.code==='MANIFEST_UNKNOWN')),'Image tag lookup failed: HTTP 404 '+bytes.toString());
  return undefined;
 }
 assert.ok(response.ok,'Anonymous image lookup failed: HTTP '+response.status);
 const digest=digestOf(bytes),header=response.headers.get('docker-content-digest');
 if(ref.startsWith('sha256:'))assert.equal(digest,ref,'Registry manifest digest differs');
 if(header)assert.equal(digest,header,'Registry manifest digest header differs');
 let manifest=JSON.parse(bytes);
 if(manifest.manifests) {
  const runtime=manifest.manifests.filter(item=>item.platform?.os==='linux'&&item.platform?.architecture==='amd64'&&item.annotations?.['vnd.docker.reference.type']!=='attestation-manifest');
  assert.equal(runtime.length,1,'Index must contain exactly one linux/amd64 runtime image');
  assert.match(runtime[0].digest,/^sha256:[a-f0-9]{64}$/);
  const child=await request('https://ghcr.io/v2/drawmotive/textgraph-renderer/manifests/'+runtime[0].digest,registryOptions(token,manifestAccept));
  assert.ok(child.ok,'Anonymous child image lookup failed: HTTP '+child.status);
  const childBytes=Buffer.from(await child.arrayBuffer());
  assert.equal(digestOf(childBytes),runtime[0].digest,'Runtime manifest digest differs from index');
  manifest=JSON.parse(childBytes);
  assert.ok(!manifest.manifests,'Nested runtime indexes are unsupported');
 }
 assert.match(manifest.config?.digest,/^sha256:[a-f0-9]{64}$/,'Image manifest has no immutable config');
 // GHCR serves blobs through signed storage redirects; fetch strips foreign authorization.
 const configResponse=await request('https://ghcr.io/v2/drawmotive/textgraph-renderer/blobs/'+manifest.config.digest,{...registryOptions(token),redirect:'follow'});
 assert.ok(configResponse.ok,'Unable to read image config');
 const configBytes=Buffer.from(await configResponse.arrayBuffer());
 assert.equal(digestOf(configBytes),manifest.config.digest,'Image config digest differs from manifest');
 const config=JSON.parse(configBytes);
 assert.equal(config.os,'linux','Runtime config platform differs');
 assert.equal(config.architecture,'amd64','Runtime config platform differs');
 return {digest,configDigest:manifest.config.digest,config};
}
export async function verifyAnonymousImage(digest,request=fetch) {
 const prefix='ghcr.io/drawmotive/textgraph-renderer@';
 assert.ok(digest.startsWith(prefix),'Unexpected public image destination');
 const hash=digest.slice(prefix.length);
 assert.match(hash,/^sha256:[a-f0-9]{64}$/,'Invalid registry digest');
 await registryImage(hash,await anonymousToken(request),request);
 return {digest,verifiedAt:new Date().toISOString()};
}

/** Retrying an immutable tag must never silently downgrade the shared channel. */
export function validateChannelAdvance(next,current,options=releaseOptions()) {
 releaseTag(next,options);
 if(current===undefined)return;
 assert.ok(compareReleaseVersions(next,current)>=0,'Refusing to roll the publication channel back to an older release');
}

export async function readChannelVersion(channel,request=fetch) {
 assert.ok(['alpha','latest'].includes(channel),'Invalid image channel');
 const image=await registryImage(channel,await anonymousToken(request),request,{missing:true});
 if(!image)return undefined;
 const version=image.config.config?.Labels?.['org.opencontainers.image.version'];
 assert.ok(version,'Channel image has no version label');
 return version;
}

/** Check every immutable tag before any write. Existing references are retained
 * byte-for-byte, including the index's attestation descriptors. */
export async function inspectImmutableImages(identity,imageId,request=fetch,options) {
 assert.deepEqual(identity,releaseIdentity(identity.tag,identity.version,identity.commit,options));
 assert.match(imageId,/^sha256:[a-f0-9]{64}$/);
 const token=await anonymousToken(request),images=[];
 for(const ref of [identity.version,'sha-'+identity.commit]) {
  const image=await registryImage(ref,token,request,{missing:true});
  if(image) {
   assert.ok(image.digest===imageId||image.configDigest===imageId,'Existing immutable tag contains a different image');
   assert.equal(image.config.config?.Labels?.['org.opencontainers.image.revision'],identity.commit,'Image revision provenance differs');
   assert.equal(image.config.config?.Labels?.['org.opencontainers.image.version'],identity.version,'Image version provenance differs');
  }
  images.push({ref,...image});
 }
 const digests=images.filter(image=>image.digest).map(image=>image.digest);
 assert.ok(new Set(digests).size<=1,'Immutable tags contain different registry bytes');
 return images;
}
export async function verifyImmutableImage(identity,imageId,request=fetch,options) {
 return (await inspectImmutableImages(identity,imageId,request,options)).every(image=>image.digest);
}

/** Registry writes are idempotent and retain the top-level tested identity. */
export async function publishImageReferences(identity,imageId,{request=fetch,execute=run,options}={}) {
 validateChannelAdvance(identity.version,await readChannelVersion(identity.channel,request),options);
 const existing=await inspectImmutableImages(identity,imageId,request,options);
 let established=existing.find(state=>state.digest)?.digest;
 // Skip already verified immutable references. Publication never rebuilds or
 // replaces them, even when only one reference survived an earlier attempt.
 for(const state of existing)if(!state.digest) {
  const tag=identity.image+':'+state.ref;
  if(established)await execute('docker',['buildx','imagetools','create','--prefer-index=false','--tag',tag,identity.image+'@'+established]);
  else {
   await execute('docker',['tag',imageId,tag]);await execute('docker',['push',tag]);
   established=(await inspectImmutableImages(identity,imageId,request,options)).find(item=>item.ref===state.ref)?.digest;
   assert.ok(established,'Uploaded immutable reference is missing');
  }
 }
 const confirmed=await inspectImmutableImages(identity,imageId,request,options);
 assert.ok(confirmed.every(state=>state.digest),'Immutable references missing after upload');
 const digest=identity.image+'@'+confirmed[0].digest;
 const anonymous=await verifyAnonymousImage(digest,request);
 validateChannelAdvance(identity.version,await readChannelVersion(identity.channel,request),options);
 // A one-source carbon copy preserves the tested index and its attestations.
 await execute('docker',['buildx','imagetools','create','--prefer-index=false','--tag',identity.tags[2],digest]);
 const token=await anonymousToken(request);
 assert.equal((await registryImage(identity.channel,token,request)).digest,confirmed[0].digest,'Published channel bytes differ');
 return {digest,anonymous};
}

async function resolve(tag) {
 const pkg=await json(path.join(root,'package.json'));
 const sha=run('git',['rev-parse',`refs/tags/${tag}^{commit}`]);
 const identity=releaseIdentity(tag,pkg.version,sha);
 assert.equal(run('git',['rev-parse','HEAD']),sha,'Run publication on the tagged checkout itself');
 if(process.env.GITHUB_REF)assert.equal(process.env.GITHUB_REF,`refs/tags/${tag}`,'Dispatch workflow on the release tag itself');
 if(process.env.GITHUB_SHA)assert.equal(process.env.GITHUB_SHA,sha,'Workflow SHA must equal tag commit');
 validateRegistryLock(pkg,await json(path.join(root,'package-lock.json')));
 await writeFile(path.join(root,'release-identity.json'),JSON.stringify(identity,null,2)+String.fromCharCode(10));
 if(process.env.GITHUB_OUTPUT)await appendFile(process.env.GITHUB_OUTPUT,`commit=${sha}
version=${pkg.version}
`);
 return identity;
}

/** Push only the image ID whose actual bytes were tested, never rebuild at publication. */
async function publish(localImage) {
 const stored=await json(path.join(root,'release-identity.json'));
 await validateRendererPublisherCheckout(stored,{commit:run('git',['rev-parse','HEAD']),ref:process.env.GITHUB_REF,sha:process.env.GITHUB_SHA,git:args=>run('git',args)});
 const image=JSON.parse(run('docker',['image','inspect',localImage]))[0];
 const provenance=JSON.parse(run('docker',['run','--rm','--entrypoint','cat',image.Id,'/app/provenance.json']));
 const smoke=await json(path.join(root,'smoke-receipt.json'));
 const identity=validatePublication(stored,await json(path.join(root,'package.json')),await json(path.join(root,'package-lock.json')),image,provenance,smoke);
 const {digest,anonymous}=await publishImageReferences(identity,image.Id);
 const receipt={...identity,imageId:image.Id,digest,provenance,smoke,anonymous};
 await writeFile(path.join(root,'release-receipt.json'),JSON.stringify(receipt,null,2)+String.fromCharCode(10));
 return receipt;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const [action,value,...extra]=process.argv.slice(2);assert.equal(extra.length,0);
 let result;
 if(action==='resolve')result=await resolve(value);
 else if(action==='publish')result=await publish(value);
 else throw new Error('Usage: node scripts/release.mjs resolve TAG | publish LOCAL_IMAGE');
 console.log(JSON.stringify(result,null,2));
}
