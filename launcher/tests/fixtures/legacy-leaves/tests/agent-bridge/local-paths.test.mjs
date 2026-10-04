import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inspectTaskPaths } from '../../integrations/agents/local-paths.mjs';
import { task } from './fixtures.mjs';
const here = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
function fixture(t) {
  const root = mkdtempSync(here + '/.runtime-'); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(root + '/src'); writeFileSync(root + '/src/example.js', 'ordinary synthetic fixture');
  const packet = task(); packet.workspace = root;
  return { root, packet };
}
test('bounded inspection reads metadata only and allows not-yet-written evidence and receipt', t => {
  const { root, packet } = fixture(t); const observation = inspectTaskPaths(packet);
  assert.equal(observation.workspace, root); assert.equal(observation.executionAuthorized, false);
  assert.equal(observation.contentHashesVerified, false);
  assert.equal(observation.observed.find(o => o.path === packet.expectedReceiptPath).state, 'MISSING');
  assert.equal(readFileSync(root + '/src/example.js', 'utf8'), 'ordinary synthetic fixture');
});
test('missing workspace/input/cwd and file-as-directory are rejected', t => {
  const { root, packet } = fixture(t);
  packet.workspace = root + '/missing'; assert.throws(() => inspectTaskPaths(packet), /LOCAL_PATH_UNAVAILABLE/);
  packet.workspace = root; packet.inputs[0].path = 'missing'; assert.throws(() => inspectTaskPaths(packet), /LOCAL_PATH_UNAVAILABLE/);
  packet.inputs[0].path = 'src/example.js'; packet.commands[0].cwd = 'src/example.js'; assert.throws(() => inspectTaskPaths(packet), /LOCAL_FILE_TYPE_REJECTED/);
});
test('workspace, input and missing output parents reject symlinks without following them', t => {
  const { root, packet } = fixture(t);
  symlinkSync(root + '/src', root + '/alias');
  packet.workspace = root + '/alias'; assert.throws(() => inspectTaskPaths(packet), /LOCAL_SYMLINK_REJECTED/);
  packet.workspace = root; packet.inputs[0].path = 'alias/example.js'; assert.throws(() => inspectTaskPaths(packet), /LOCAL_SYMLINK_REJECTED/);
  packet.inputs[0].path = 'src/example.js'; packet.expectedReceiptPath = 'alias/new/receipt.json'; assert.throws(() => inspectTaskPaths(packet), /LOCAL_SYMLINK_REJECTED/);
});
test('directory input and multiply-linked input are rejected', t => {
  const { root, packet } = fixture(t);
  packet.inputs[0].path = 'src'; assert.throws(() => inspectTaskPaths(packet), /LOCAL_FILE_TYPE_REJECTED/);
  packet.inputs[0].path = 'src/example.js'; linkSync(root + '/src/example.js', root + '/hardlink');
  assert.throws(() => inspectTaskPaths(packet), /LOCAL_HARDLINK_REJECTED/);
});
