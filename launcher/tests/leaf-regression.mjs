// Exact pinned leaf tests against current modules. Research is historical fixtures only.
import {spawnSync} from 'node:child_process';
import {loadLegacyFixtures} from './legacy-fixtures.mjs';
import {mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root = fileURLToPath(new URL('../../', import.meta.url));
const local = path.join(root, 'launcher/.local'); mkdirSync(local, {recursive: true});
const work = mkdtempSync(path.join(local, 'leaf-'));
const sha = value => createHash('sha256').update(value).digest('hex');
const manifests = [];
const pins = [
 ['37b19b5cc02cdf266add19709172349d0733af56', ['tests/agent-bridge']],
 ['bce14cd9e6f77dc39354b67611b13b96840e1d76', ['tests/onboarding-resume']],
 ['c3188d1c78e90543776e03ceaa8c2534481c2bfb', ['tests/connector-registry', 'research/connector-qualification']],
];
try {
 for (const fixture of loadLegacyFixtures().filter(f => f.destination.startsWith('legacy-leaves/'))) {
   const {commit: pin, path: file, content: bytes} = fixture;
   const dest = path.join(work, file); mkdirSync(path.dirname(dest), {recursive: true}); writeFileSync(dest, bytes);
   manifests.push({pin, path: file, sha256: sha(bytes)});
 }
 cpSync(path.join(root, 'integrations'), path.join(work, 'integrations'), {recursive: true});
 mkdirSync(path.join(work, 'launcher/src'), {recursive: true});
 cpSync(path.join(root, 'launcher/src/display-names.js'), path.join(work, 'launcher/src/display-names.js'));
 cpSync(path.join(root, 'launcher/package.json'), path.join(work, 'launcher/package.json'));
 const tests = pins.flatMap(([, dirs]) => dirs.filter(d => d.startsWith('tests/')).flatMap(d => readdirSync(path.join(work, d)).filter(f => f.endsWith('.test.mjs')).map(f => path.join(work, d, f))));
 const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], {cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 4e6});
 const evidence = process.env.LF_EVIDENCE_DIR || path.join(work, 'evidence'); mkdirSync(evidence, {recursive: true});
 writeFileSync(path.join(evidence, 'leaf-tests.tap'), result.stdout + (result.stderr || ''));
 const modules = [];
 function visit(dir) { for (const item of readdirSync(path.join(root, dir), {withFileTypes: true})) { const file = dir + '/' + item.name; if (item.isDirectory()) visit(file); else if (/\.mjs$/.test(file) && !file.includes('/tests/')) modules.push({path: file, sha256: sha(readFileSync(path.join(root, file)))}); } }
 visit('integrations');
 modules.push({path: 'launcher/src/display-names.js', sha256: sha(readFileSync(path.join(root, 'launcher/src/display-names.js')))});
 writeFileSync(path.join(evidence, 'leaf-manifest.json'), JSON.stringify({pins, tests: manifests, candidateModules: modules, exitCode: result.status}, null, 2) + '\n');
 console.log(result.stdout.split('\n').slice(-10).join('\n')); if (result.error) throw result.error; process.exitCode = result.status ?? 1;
} finally { rmSync(work, {recursive: true, force: true}); }
