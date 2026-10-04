// Exact historical test inputs; no Git fallback, provider access or production snapshot.
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const LEGACY_MANIFEST_SHA256 = 'e8990b319d87cc425d82cc9b593417a248bdc367cb2d2abdfcaf64fdb1809695';
const defaultRoot = fileURLToPath(new URL('./fixtures/', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export function fixturePath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') ||
      relative.split('/').some(part => !part || part === '.' || part === '..') ||
      path.isAbsolute(relative) || /[\x00-\x1f:]/.test(relative)) throw Error('Invalid fixture path');
  let current = root;
  if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) throw Error('Invalid fixture root');
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    if (lstatSync(current).isSymbolicLink()) throw Error('Fixture symlink rejected');
  }
  if (!lstatSync(current).isFile()) throw Error('Fixture must be regular');
  return current;
}

export function loadLegacyFixtures(root = defaultRoot) {
  const bytes = readFileSync(fixturePath(root, 'legacy-manifest.json'));
  if (sha(bytes) !== LEGACY_MANIFEST_SHA256) throw Error('Legacy manifest digest mismatch');
  const manifest = JSON.parse(bytes);
  const expected = new Set(['legacy-manifest.json']);
  const files = manifest.files.map(entry => {
    if (expected.has(entry.destination)) throw Error('Duplicate fixture');
    expected.add(entry.destination);
    const content = readFileSync(fixturePath(root, entry.destination));
    if (content.length !== entry.bytes || sha(content) !== entry.sha256) throw Error('Legacy fixture digest mismatch: ' + entry.destination);
    return {...entry, content};
  });
  const actual = [];
  function visit(relative = '') {
    for (const item of readdirSync(path.join(root, relative), {withFileTypes: true})) {
      const name = relative ? relative + '/' + item.name : item.name;
      if (item.isSymbolicLink()) throw Error('Fixture symlink rejected');
      if (item.isDirectory()) {
        if (![...expected].some(file => file.startsWith(name + '/'))) throw Error('Unexpected fixture directory: ' + name);
        visit(name);
      } else {
        if (!item.isFile() || !expected.has(name)) throw Error('Unexpected fixture: ' + name);
        actual.push(name);
      }
    }
  }
  visit();
  if (actual.length !== expected.size) throw Error('Incomplete fixture set');
  return files;
}
