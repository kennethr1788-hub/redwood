import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, chmodSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {checkSource, checkLocalGit} from './package-source.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
function copy(t) {
  const temp = mkdtempSync(path.join(tmpdir(), 'redwood-public-source-'));
  t.after(() => rmSync(temp, {recursive:true, force:true}));
  const root = path.join(temp, 'source with spaces'); mkdirSync(root);
  const manifest = JSON.parse(readFileSync(path.join(source, 'PUBLIC_SOURCE_MANIFEST.json')));
  for (const name of ['PUBLIC_SOURCE_MANIFEST.json', ...manifest.files.map(f => f.path)]) {
    mkdirSync(path.dirname(path.join(root, name)), {recursive:true});
    cpSync(path.join(source, name), path.join(root, name));
  }
  return {root, temp};
}
test('complete no-Git source validates and ignores an unrelated parent repository', t => {
  const {root, temp} = copy(t);
  execFileSync('git', ['init','-q',temp]);
  assert.equal(checkSource(root).scope, 'PUBLIC_DISTRIBUTION');
  assert.equal(checkLocalGit(root), 'NO_GIT');
  mkdirSync(path.join(root,'.git'));
  assert.throws(() => checkLocalGit(root));
});
for (const [label, mutate] of [
  ['missing fixture', r => rmSync(path.join(r,'launcher/tests/fixtures/legacy-resume/buildCurrent.md'))],
  ['changed source', r => writeFileSync(path.join(r,'launcher/server.mjs'),'changed')],
  ['changed executable bit', r => chmodSync(path.join(r,'launcher/server.mjs'),0o755)],
  ['unexpected file', r => writeFileSync(path.join(r,'unexpected.txt'),'extra')],
  ['unexpected directory', r => mkdirSync(path.join(r,'unexpected'))],
  ['symlink source', r => {rmSync(path.join(r,'README.md'));symlinkSync('/etc/hosts',path.join(r,'README.md'));}],
  ['missing identity', r => rmSync(path.join(r,'PUBLIC_SOURCE_MANIFEST.json'))],
  ['wrong product identity', r => {const p=path.join(r,'PUBLIC_SOURCE_MANIFEST.json');const m=JSON.parse(readFileSync(p));m.product='Other';writeFileSync(p,JSON.stringify(m));}],
  ['incomplete identity', r => {const p=path.join(r,'PUBLIC_SOURCE_MANIFEST.json');const m=JSON.parse(readFileSync(p));m.files=[];writeFileSync(p,JSON.stringify(m));}],
]) test('distribution rejects '+label, t => {const {root}=copy(t);mutate(root);assert.throws(() => checkSource(root));});
test('manifest itself cannot change unnoticed during verification', t => {
  const {root}=copy(t);const before=checkSource(root).digest;
  const p=path.join(root,'PUBLIC_SOURCE_MANIFEST.json');writeFileSync(p,readFileSync(p,'utf8')+'\n');
  assert.throws(() => checkSource(root,before),/manifest changed/);
});
