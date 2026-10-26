import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { validateRetainedRenderer } from '../scripts/retained-release.mjs';
import { releaseIdentity } from '../scripts/release.mjs';
const version='0.2.2-alpha.4',commit='a'.repeat(40),archive=Buffer.from('frozen docker archive');
const receipt=(version='0.2.2-alpha.4',legacy=true)=>({identity:releaseIdentity('textgraph-renderer-v'+version,version,commit,{legacy}),imageId:'sha256:'+'b'.repeat(64),smoke:{imageId:'sha256:'+'b'.repeat(64),version,sdkVersion:version,engineCommit:'c'.repeat(40),verifiedAt:'2026-10-10T00:00:00Z'},platform:'linux/amd64',filename:'renderer-image.tar',sha256:createHash('sha256').update(archive).digest('hex'),prepareRun:'123'});
test('remote retained image binds archive, smoke, platform and immutable source',async()=>{
 await validateRetainedRenderer(receipt(),archive,{commit,version,legacy:true});
 for(const mutate of [r=>r.imageId='sha256:'+'d'.repeat(64),r=>r.platform='linux/arm64',r=>r.identity.commit='e'.repeat(40),r=>r.sha256='f'.repeat(64),r=>r.smoke.sdkVersion='0.2.1',r=>r.prepareRun='']){
  const changed=receipt();mutate(changed);await assert.rejects(validateRetainedRenderer(changed,archive,{commit,version,legacy:true}));
 }
 await assert.rejects(validateRetainedRenderer(receipt(),Buffer.from('replaced'),{commit,version,legacy:true}),/changed/);
});

test('numeric retained image checks latest destination without rewriting the archive identity',async()=>{
 const version='0.3.2',value=receipt(version,false);
 await validateRetainedRenderer(value,archive,{commit,version,legacy:false});
 value.identity.channel='alpha';
 await assert.rejects(validateRetainedRenderer(value,archive,{commit,version,legacy:false}));
});
