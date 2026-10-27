import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRendererPublisherCheckout, validateRendererPublisherChanges, rendererPublisherTag } from '../scripts/publisher-correction.mjs';

const producer='a'.repeat(40),publisher='b'.repeat(40);
const identity={commit:producer,version:'0.3.1',tag:'textgraph-renderer-v0.3.1'};
const corrected=()=>({commit:publisher,sha:publisher,ref:'refs/tags/'+rendererPublisherTag('0.3.1',publisher),git:args=>{
 if(args[0]==='rev-parse')return args[1].includes('-publisher-')?publisher:producer;
 if(args[0]==='merge-base')return '';
 if(args[0]==='diff')return 'M\tscripts/release.mjs\nA\tscripts/publisher-correction.mjs';
 assert.fail('Unexpected git operation');
}});
test('a publisher correction retains the immutable producer and permits only excluded transport files',async()=>{
 await validateRendererPublisherCheckout(identity,corrected());
 for(const file of ['Dockerfile','.dockerignore','package.json','package-lock.json','src/main.js','scripts/provenance.mjs','.release/target.json'])
  assert.throws(()=>validateRendererPublisherChanges(['M\t'+file]),/tested image/);
 for(const status of ['D','R100','C100'])assert.throws(()=>validateRendererPublisherChanges([status+'\tscripts/release.mjs']),/tested image/);
 assert.throws(()=>validateRendererPublisherChanges([]),/tested image/);
});
test('correction rejects wrong workflow SHA, ref, producer binding, ancestry or product changes',async()=>{
 for(const mutation of [
  value=>value.sha=producer,
  value=>value.ref='refs/tags/textgraph-renderer-v0.3.1',
  value=>value.ref+='wrong',
  value=>value.git=args=>args[0]==='rev-parse'?publisher:'',
  value=>value.git=args=>{if(args[0]==='merge-base')throw Error('Not a descendant');return args[0]==='rev-parse'?producer:'M\tDockerfile';},
  value=>{const git=value.git;value.git=args=>args[0]==='diff'?'M\tsrc/main.js':git(args);},
 ]) {
  const value=corrected();mutation(value);
  await assert.rejects(validateRendererPublisherCheckout(identity,value));
 }
});
test('the original publisher requires its original tag and cannot masquerade as a correction',async()=>{
 await validateRendererPublisherCheckout(identity,{commit:producer,sha:producer,ref:'refs/tags/'+identity.tag,git:()=>producer});
 await assert.rejects(validateRendererPublisherCheckout(identity,{commit:producer,sha:producer,ref:'refs/tags/'+rendererPublisherTag('0.3.1',producer),git:()=>producer}));
});
