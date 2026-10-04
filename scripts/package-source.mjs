// Distribution identity is local to this root. Never discover a parent repository.
import {createHash} from 'node:crypto';
import {lstatSync, readFileSync, readdirSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex');
const generated = new Set(['.git', 'launcher/node_modules', 'launcher/dist', 'launcher/.local',
  'products/build/node_modules', 'products/build/dist', 'products/build/.local',
  'products/build/templates/react/node_modules', 'products/build/templates/react/dist',
  'products/studio/node_modules', 'products/studio/.studio', 'products/studio/.local',
  'products/grow/node_modules', 'products/grow/.grow-data', 'products/grow/.local',
  'integrations/media/node_modules', 'products/grow/.work', 'products/grow/tests/creative/.work', 'tests/media-connectors/.tmp']);

function regular(root, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || /[\x00-\x1f:]/.test(name) ||
      name.split('/').some(p => !p || p === '.' || p === '..') || path.isAbsolute(name)) throw Error('Invalid source path');
  let p = root;
  for (const part of name.split('/')) {
    p = path.join(p, part);
    if (lstatSync(p).isSymbolicLink()) throw Error('Source symlink rejected: ' + name);
  }
  const s = lstatSync(p);
  if (!s.isFile()) throw Error('Source must be regular: ' + name);
  return {p, s};
}

export function checkSource(root = defaultRoot, expectedDigest) {
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw Error('Invalid source root');
  root = realpathSync(root);
  const manifestPath = regular(root, 'PUBLIC_SOURCE_MANIFEST.json').p;
  const bytes = readFileSync(manifestPath), digest = sha(bytes), manifest = JSON.parse(bytes);
  if (expectedDigest && digest !== expectedDigest) throw Error('Source manifest changed during verification');
  if (manifest.schemaVersion !== 1 || manifest.product !== 'Redwood' || manifest.scope !== 'PUBLIC_DISTRIBUTION' ||
      !Array.isArray(manifest.files) || manifest.files.length < 1) throw Error('Invalid public source identity');
  const names = new Set(['PUBLIC_SOURCE_MANIFEST.json']);
  for (const entry of manifest.files) {
    if (names.has(entry.path) || [...generated].some(g => entry.path === g || entry.path.startsWith(g + '/')))
      throw Error('Invalid or duplicate manifest entry');
    names.add(entry.path);
    const {p, s} = regular(root, entry.path);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || s.size !== entry.bytes || (s.mode & 0o777) !== entry.mode ||
        sha(readFileSync(p)) !== entry.sha256) throw Error('Source content/mode mismatch: ' + entry.path);
  }
  for (const required of ['README.md','COMMUNITY_EVALUATION_TERMS.md','scripts/verify-redwood.sh',
    'scripts/package-source.mjs','launcher/package.json','products/build/package.json',
    'products/studio/package.json','products/grow/package.json','integrations/media/package.json']) {
    if (!names.has(required)) throw Error('Incomplete source manifest: ' + required);
  }
  const found = new Set();
  function visit(dir = '') {
    for (const item of readdirSync(path.join(root, dir), {withFileTypes: true})) {
      const name = dir ? dir + '/' + item.name : item.name;
      if (generated.has(name)) continue;
      if (item.isSymbolicLink()) throw Error('Unexpected source symlink: ' + name);
      if (item.isDirectory()) {
        if (![...names].some(n => n.startsWith(name + '/'))) throw Error('Unexpected source directory: ' + name);
        visit(name);
      } else {
        if (!item.isFile() || !names.has(name)) throw Error('Unexpected source file: ' + name);
        found.add(name);
      }
    }
  }
  visit();
  if (found.size !== names.size) throw Error('Incomplete distribution');
  return {scope: manifest.scope, digest, sourceIdentity: 'sha256:' + digest, files: manifest.files.length};
}

export function sourceIdentity(root = defaultRoot) { return checkSource(root).sourceIdentity; }

export function checkLocalGit(root = defaultRoot) {
  // Git is optional for source ZIPs. A present, broken .git is an error, not parent discovery.
  if (!readdirSync(root).includes('.git')) return 'NO_GIT';
  const env = {...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'};
  for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE']) delete env[key];
  const git = args => execFileSync('git', ['-C', root, ...args], {env, encoding:'utf8'}).trim();
  if (realpathSync(git(['rev-parse','--show-toplevel'])) !== realpathSync(root)) throw Error('Unrelated parent repository rejected');
  if (git(['status','--porcelain','--untracked-files=all'])) throw Error('Public source checkout is dirty');
  return git(['rev-parse','HEAD']);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, digest] = process.argv.slice(2);
  if (command === 'check') console.log(checkSource(defaultRoot, digest).digest);
  else if (command === 'git') console.log(checkLocalGit());
  else throw Error('Usage: node scripts/package-source.mjs check [expected-digest] | git');
}
