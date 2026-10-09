import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..');
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const run=(command,args)=>execFileSync(command,args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','inherit']}).trim();

/** Publication identity comes only from an immutable version tag and full source commit. */
export function releaseIdentity(tag,version,commit) {
 const match=/^textgraph-renderer-v((?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)[.](?:0|[1-9][0-9]*)(?:-alpha[.](?:0|[1-9][0-9]*))?)$/.exec(tag??'');
 assert.ok(match,'Use textgraph-renderer-vX.Y.Z or textgraph-renderer-vX.Y.Z-alpha.N');
 assert.equal(match[1],version,'Release tag must match package version');
 assert.match(commit,/^[a-f0-9]{40}$/,'Release commit must be immutable');
 const channel=version.includes('-')?'alpha':'latest';
 const image='ghcr.io/drawmotive/textgraph-renderer';
 return {version,commit,tag,channel,image,tags:[`${image}:${version}`,`${image}:sha-${commit}`,`${image}:${channel}`]};
}

/** Public consumers must reproduce dependency installation without private access. */
export function validateRegistryLock(pkg,lock) {
 assert.equal(pkg.version,pkg.dependencies?.['@drawmotive/textgraph'],'Renderer image version must equal the exact SDK version');
 for(const name of ['@drawmotive/textgraph','@drawmotive/textgraph-fonts']) {
  const version=pkg.dependencies?.[name],entry=lock.packages?.[`node_modules/${name}`];
  assert.match(version??'',/^[0-9]+[.][0-9]+[.][0-9]+(?:-alpha[.][0-9]+)?$/,'Pin exact public package versions');
  assert.equal(lock.packages?.['']?.dependencies?.[name],version,'Dependency lock drift');
  assert.equal(entry?.version,version,'Installed dependency version drift');
  assert.ok(!entry?.link,'Local/workspace dependencies cannot be published');
  assert.equal(entry?.resolved,`https://registry.npmjs.org/${name}/-/${name.split('/').at(-1)}-${version}.tgz`,'Require public registry tarball');
  const integrity=/^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(entry?.integrity??'');
  assert.ok(integrity && Buffer.from(integrity[1],'base64').length===64 && Buffer.from(integrity[1],'base64').toString('base64')===integrity[1],'Require true SHA512 integrity');
 }
}

/** A receipt is useful only when every claimed identity agrees with the tested bytes. */
export function validatePublication(identity,pkg,lock,image,provenance,smoke) {
 const canonical=releaseIdentity(identity.tag,identity.version,identity.commit);
 assert.deepEqual(identity,canonical,'Stored release destination or tags were modified');
 assert.equal(pkg.version,canonical.version,'Checkout version differs from release');
 validateRegistryLock(pkg,lock);
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
const manifestAccept='application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json';
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
export async function verifyAnonymousImage(digest,request=fetch) {
 const prefix='ghcr.io/drawmotive/textgraph-renderer@';
 assert.ok(digest.startsWith(prefix),'Unexpected public image destination');
 const hash=digest.slice(prefix.length);
 assert.match(hash,/^sha256:[a-f0-9]{64}$/,'Invalid registry digest');
 const token=await anonymousToken(request);
 const response=await request(`https://ghcr.io/v2/drawmotive/textgraph-renderer/manifests/${hash}`,registryOptions(token,manifestAccept));
 assert.ok(response.ok,'Image manifest is not anonymously accessible; verify the GHCR package is Public.');
 assert.equal(`sha256:${createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex')}`,hash,'Anonymous manifest digest differs from published image');
 return {digest,verifiedAt:new Date().toISOString()};
}

/** Retrying an immutable tag must never silently downgrade the shared channel. */
export function validateChannelAdvance(next,current) {
 const parse=version=>{
  releaseIdentity(`textgraph-renderer-v${version}`,version,'0'.repeat(40));
  const [major,minor,patch,alpha]=version.split(/[.-]/);
  return [BigInt(major),BigInt(minor),BigInt(patch),alpha===undefined?1n:0n,alpha===undefined?0n:BigInt(version.split('.').at(-1))];
 };
 const target=parse(next);
 if(current===undefined)return;
 const existing=parse(current);
 for(let i=0;i<target.length;i++) {
  assert.ok(target[i]>=existing[i],'Refusing to roll the publication channel back to an older release');
  if(target[i]>existing[i])return;
 }
}

export async function readChannelVersion(channel,request=fetch) {
 assert.ok(['alpha','latest'].includes(channel),'Invalid image channel');
 const token=await anonymousToken(request);
 const response=await request(`https://ghcr.io/v2/drawmotive/textgraph-renderer/manifests/${channel}`,registryOptions(token,manifestAccept));
 if(response.status===404)return undefined;
 assert.ok(response.ok,'Unable to read current public image channel');
 const manifest=await response.json();
 assert.match(manifest.config?.digest,/^sha256:[a-f0-9]{64}$/,'Channel manifest has no immutable config');
 // GHCR serves blobs through signed storage redirects; fetch drops authorization across hosts.
 const configResponse=await request(`https://ghcr.io/v2/drawmotive/textgraph-renderer/blobs/${manifest.config.digest}`,{...registryOptions(token),redirect:'follow'});
 assert.ok(configResponse.ok,'Unable to read channel image config');
 const bytes=Buffer.from(await configResponse.arrayBuffer());
 assert.equal(`sha256:${createHash('sha256').update(bytes).digest('hex')}`,manifest.config.digest,'Channel config digest differs from manifest');
 const version=JSON.parse(bytes).config?.Labels?.['org.opencontainers.image.version'];
 assert.ok(version,'Channel image has no version label');
 return version;
}

/** The image config digest is Docker's tested image ID. Check both immutable
 * tags before any push so a retry cannot overwrite an existing release. */
export async function verifyImmutableImage(identity,imageId,request=fetch) {
 assert.deepEqual(identity,releaseIdentity(identity.tag,identity.version,identity.commit));
 assert.match(imageId,/^sha256:[a-f0-9]{64}$/);
 const token=await anonymousToken(request);
 let confirmed=true;
 for(const ref of [identity.version,'sha-'+identity.commit]) {
  const response=await request('https://ghcr.io/v2/drawmotive/textgraph-renderer/manifests/'+ref,registryOptions(token,manifestAccept));
  if(response.status===404) {confirmed=false;continue;}
  assert.ok(response.ok,'Image tag lookup failed: HTTP '+response.status);
  const manifest=await response.json();
  assert.equal(manifest.config?.digest,imageId,'Existing immutable tag contains a different image');
 }
 return confirmed;
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
 assert.equal(run('git',['rev-parse','HEAD']),stored.commit,'Publication checkout differs from release');
 const image=JSON.parse(run('docker',['image','inspect',localImage]))[0];
 const provenance=JSON.parse(run('docker',['run','--rm','--entrypoint','cat',image.Id,'/app/provenance.json']));
 const smoke=await json(path.join(root,'smoke-receipt.json'));
 const identity=validatePublication(stored,await json(path.join(root,'package.json')),await json(path.join(root,'package-lock.json')),image,provenance,smoke);
 validateChannelAdvance(identity.version,await readChannelVersion(identity.channel));
 await verifyImmutableImage(identity,image.Id);
 // Establish immutable references first; advance the channel only after public access is proven.
 for(const tag of identity.tags.slice(0,2)) {run('docker',['tag',image.Id,tag]);run('docker',['push',tag]);}
 const repos=JSON.parse(run('docker',['image','inspect',image.Id]))[0].RepoDigests;
 const digest=repos.find(item=>item.startsWith(identity.image+'@sha256:'));
 assert.ok(digest,'Registry digest missing');
 const anonymous=await verifyAnonymousImage(digest);
 validateChannelAdvance(identity.version,await readChannelVersion(identity.channel));
 run('docker',['tag',image.Id,identity.tags[2]]);run('docker',['push',identity.tags[2]]);
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
