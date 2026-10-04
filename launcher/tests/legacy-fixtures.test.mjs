import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, cpSync, rmSync, writeFileSync, readFileSync, symlinkSync, mkdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadLegacyFixtures, fixturePath} from './legacy-fixtures.mjs';

const source = fileURLToPath(new URL('./fixtures/', import.meta.url));
const legacy = 'legacy-resume/buildCurrent.md';
function copy(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'redwood-fixtures-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const root = path.join(dir, 'fixtures'); cpSync(source, root, {recursive: true}); return root;
}
test('all eleven public-safe historical inputs validate without Git metadata', () => {
  const files = loadLegacyFixtures();
  assert.equal(files.length, 11);
  assert.equal(files.filter(f => f.destination.startsWith('legacy-leaves/')).length, 10);
  assert.equal(files.find(f => f.destination === legacy).sha256, '7c54fe16f74b416ee4f645fc3d61d62f2f4074c95d4389e6f1523f3f80a034a7');
});
for (const [label, mutate] of [
  ['missing fixture', root => rmSync(path.join(root, legacy))],
  ['changed byte', root => {const p = path.join(root, legacy); const b = readFileSync(p); b[10] ^= 1; writeFileSync(p, b);}],
  ['extra fixture', root => writeFileSync(path.join(root, 'extra.mjs'), 'throw Error("must not execute")')],
  ['extra directory', root => mkdirSync(path.join(root, 'extra'))],
  ['symlink escape', root => {rmSync(path.join(root, legacy)); symlinkSync('/etc/hosts', path.join(root, legacy));}],
  ['symlink directory', root => {rmSync(path.join(root, 'legacy-resume'), {recursive: true}); symlinkSync('/tmp', path.join(root, 'legacy-resume'));}],
]) test('rejects ' + label + ' before any historical test executes', t => {
  const root = copy(t); mutate(root); assert.throws(() => loadLegacyFixtures(root));
});
for (const [label, mutate] of [
  ['wrong digest', m => {m.files[0].sha256 = '0'.repeat(64);}],
  ['wrong historical pin', m => {m.files[0].commit = '0'.repeat(40);}],
  ['extra manifest entry', m => {m.files.push(m.files[0]);}],
  ['path traversal', m => {m.files[0].destination = '../escape';}],
  ['absolute path', m => {m.files[0].destination = '/etc/hosts';}],
]) test('rejects manifest ' + label, t => {
  const root = copy(t), file = path.join(root, 'legacy-manifest.json');
  const m = JSON.parse(readFileSync(file)); mutate(m); writeFileSync(file, JSON.stringify(m));
  assert.throws(() => loadLegacyFixtures(root), /manifest digest mismatch/);
});
test('path validator rejects traversal and absolute paths independently of manifest binding', () => {
  for (const value of ['../escape', '/etc/hosts', 'a/../../escape', 'a\\b', 'C:/escape', './x', 'a//b', 'a/']) {
    assert.throws(() => fixturePath(source, value), /Invalid fixture path/);
  }
});
test('symlink fixture root is refused', t => {
  const root = copy(t), link = root + '-link'; symlinkSync(root, link);
  assert.throws(() => loadLegacyFixtures(link), /Invalid fixture root/);
});
