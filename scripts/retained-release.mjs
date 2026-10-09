import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { releaseIdentity, validatePublication } from './release.mjs';
const root = path.resolve(import.meta.dirname, '..');
const json = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
const run = (command, args) => execFileSync(command, args, {cwd: root, encoding:'utf8', stdio:['ignore','pipe','inherit']}).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** The remote builder seals Docker's tested image ID and its transport bytes.
 * A separate trusted job loads that image; publication never rebuilds it. */
export async function validateRetainedRenderer(receipt, archive, { commit, version } = {}) {
  assert.deepEqual(receipt.identity, releaseIdentity('textgraph-renderer-v' + version, version, commit));
  assert.equal(receipt.imageId, receipt.smoke.imageId);
  assert.equal(receipt.smoke.version, version); assert.equal(receipt.smoke.sdkVersion, version);
  assert.match(receipt.imageId, /^sha256:[a-f0-9]{64}$/);
  assert.match(receipt.smoke.engineCommit, /^[a-f0-9]{40}$/);
  assert.ok(Number.isFinite(Date.parse(receipt.smoke.verifiedAt)));
  assert.equal(receipt.filename, 'renderer-image.tar');
  assert.equal(receipt.sha256, hash(archive), 'Retained image archive changed');
  assert.equal(receipt.platform, 'linux/amd64');
  assert.match(receipt.prepareRun, /^[1-9][0-9]*$/);
}

const [action, image = 'textgraph-renderer:release'] = process.argv.slice(2);
if (['seal', 'load'].includes(action)) {
  const commit = run('git', ['rev-parse','HEAD']), pkg = await json('package.json');
  if (action === 'seal') {
    const identity = await json('release-identity.json'), smoke = await json('smoke-receipt.json');
    const inspected = JSON.parse(run('docker',['image','inspect',image]))[0];
    const provenance = JSON.parse(run('docker',['run','--rm','--entrypoint','cat',inspected.Id,'/app/provenance.json']));
    validatePublication(identity,pkg,await json('package-lock.json'),inspected,provenance,smoke);
    assert.equal(identity.commit,commit);
    assert.equal(inspected.Os + '/' + inspected.Architecture, 'linux/amd64');
    run('docker',['save','--output','renderer-image.tar',inspected.Id]);
    const receipt = {identity,imageId:inspected.Id,smoke,platform:'linux/amd64',filename:'renderer-image.tar',sha256:hash(await readFile(path.join(root,'renderer-image.tar'))),prepareRun:process.env.GITHUB_RUN_ID};
    await validateRetainedRenderer(receipt,await readFile(path.join(root,receipt.filename)),{commit,version:pkg.version});
    await writeFile(path.join(root,'retained-renderer.json'),JSON.stringify(receipt,null,2)+'\n');
  } else {
    const bytes = await readFile(path.join(root,'retained-renderer.json'));
    assert.equal(hash(bytes),process.env.RECEIPT_SHA256,'Dispatch receipt hash differs');
    const receipt = JSON.parse(bytes);
    assert.equal(receipt.prepareRun, process.env.PREPARE_RUN, 'Different image preparation run');
    await validateRetainedRenderer(receipt,await readFile(path.join(root,receipt.filename)),{commit,version:pkg.version});
    assert.equal(process.env.GITHUB_REF,'refs/tags/' + receipt.identity.tag);
    assert.equal(process.env.GITHUB_SHA,commit);
    run('docker',['load','--input',receipt.filename]);
    const inspected = JSON.parse(run('docker',['image','inspect',receipt.imageId]))[0];
    assert.equal(inspected.Id,receipt.imageId);
    assert.equal(inspected.Os + '/' + inspected.Architecture,receipt.platform);
    await writeFile(path.join(root,'release-identity.json'),JSON.stringify(receipt.identity,null,2)+'\n');
    await writeFile(path.join(root,'smoke-receipt.json'),JSON.stringify(receipt.smoke,null,2)+'\n');
  }
}
