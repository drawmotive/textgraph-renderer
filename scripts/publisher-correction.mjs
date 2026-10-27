import assert from 'node:assert/strict';

/** These transport files are excluded by Dockerfile and .dockerignore. A
 * correction may publish a retained image, but may never produce a new image. */
const publisherPaths=new Set([
 '.github/workflows/release.yml','scripts/release.mjs','scripts/retained-release.mjs',
 'scripts/publisher-correction.mjs','test/release.test.js','test/retained-release.test.js',
 'test/publisher-correction.test.js',
]);
export function rendererPublisherTag(version,commit) {
 assert.match(commit,/^[a-f0-9]{40}$/);
 return 'textgraph-renderer-v'+version+'-publisher-'+commit.slice(0,12);
}
export function validateRendererPublisherRecord(publisher,version) {
 assert.equal(publisher.tag,rendererPublisherTag(version,publisher.commit),'Publisher tag identity changed');
}
export function validateRendererPublisherChanges(rows) {
 assert.ok(rows.length&&rows.every(row=>{
  const [status,file,extra]=row.split(String.fromCharCode(9));
  return ['A','M'].includes(status)&&!extra&&publisherPaths.has(file);
 }),'Publisher changed tested image inputs');
}

/** The immutable product tag still owns provenance. A successor is authorized
 * only by its own exact tag/SHA, ancestry and the transport-only change set. */
export async function validateRendererPublisherCheckout(identity,{commit,ref,sha,git}) {
 assert.match(identity.commit,/^[a-f0-9]{40}$/);
 assert.equal(identity.tag,'textgraph-renderer-v'+identity.version);
 assert.equal(await git(['rev-parse','refs/tags/'+identity.tag+'^{commit}']),identity.commit,'Original producer tag changed');
 assert.equal(sha,commit,'Workflow SHA differs from publisher checkout');
 if(commit===identity.commit) {
  assert.equal(ref,'refs/tags/'+identity.tag,'Original publication requires its version tag');
  return;
 }
 const tag=rendererPublisherTag(identity.version,commit);
 assert.equal(ref,'refs/tags/'+tag,'Correction requires its immutable publisher tag');
 assert.equal(await git(['rev-parse','refs/tags/'+tag+'^{commit}']),commit,'Publisher tag changed');
 await git(['merge-base','--is-ancestor',identity.commit,commit]);
 validateRendererPublisherChanges((await git(['diff','--name-status','--no-renames',identity.commit,commit])).trim().split(String.fromCharCode(10)).filter(Boolean));
}
