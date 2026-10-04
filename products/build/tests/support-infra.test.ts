import {beforeEach, afterEach, test, expect} from 'vitest';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {Projects} from '../src/core/projects';
import {prepareHandoff, buildResume} from '../src/agent/support';
import {sourceIdentity} from '../src/core/verification';
import {readBounded, writeDerived} from '../../../integrations/resume/files.mjs';
let root: string, store: Projects;
beforeEach(async () => { await fs.mkdir('.local', {recursive: true}); root = await fs.mkdtemp(path.resolve('.local/support-')); store = new Projects(root, path.resolve('templates/react')); await store.init(); });
afterEach(async () => { await fs.rm(root, {recursive: true, force: true}); });
const input = {name: 'Resume Fixture', brief: 'Keep the user project and implement the reviewed brief.', tool: 'manual' as const};
for (const [tool, executable] of [['codex', '/official/codex'], ['claude', '/official/claude'], ['cursor', '/official/agent'], ['gemini', '/official/gemini'], ['manual', undefined]] as const) {
 test(`integrated ${tool} task generation is bounded, read back, non-executing and separate from completion`, async () => {
  const p = await store.create({...input, tool}); const folder = await store.folder(p.id);
  const source = await sourceIdentity(folder); const metadata = await fs.readFile(path.join(folder, '.launchforge/project.json'));
  const result = await prepareHandoff(p, folder, {reviewed: true, ...(executable ? {executable, mode: 'ACCOUNT'} : {})});
  expect(result.execution).toBe('NOT_RUN'); expect(result.auth).toBe('UNKNOWN'); expect(result.productCompletion).toBe('NOT_ASSESSED');
  expect(result.plan.executionAuthorized).toBe(false); expect(result.resume.completionState).toBe('NOT_RUN');
  expect(await sourceIdentity(folder)).toBe(source); expect(await fs.readFile(path.join(folder, '.launchforge/project.json'))).toEqual(metadata);
  const task = JSON.parse(await fs.readFile(path.join(folder, '.launchforge/agent-task.json'), 'utf8'));
  expect(task.inputs.map((i: {path: string}) => i.path)).toContain('.launchforge/resume.json');
  const reopened = new Projects(root, path.resolve('templates/react')); await reopened.init();
  const again = await reopened.detail(p.id, {status: 'stopped', log: ''}, false, null); expect(again.resume?.completionState).toBe('NOT_RUN');
 });
}
test('missing review, shell-bearing executable and linked packet destinations fail before outputs', async () => {
 const p = await store.create(input), folder = await store.folder(p.id);
 await expect(prepareHandoff(p, folder, {reviewed: false})).rejects.toThrow();
 await store.persist({...p, tool: 'codex'}); const current = await store.read(p.id);
 await expect(prepareHandoff(current, folder, {reviewed: true, executable: '/evil/$(touch-owned)/codex'})).rejects.toThrow();
 const outside = path.join(root, 'sentinel'); await fs.writeFile(outside, 'unchanged');
 await fs.symlink(outside, path.join(folder, '.launchforge/agent-task.md'));
 await expect(prepareHandoff(current, folder, {reviewed: true})).rejects.toThrow();
 expect(await fs.readFile(outside, 'utf8')).toBe('unchanged');
 await expect(fs.access(path.join(folder, '.launchforge/resume.json'))).rejects.toThrow();
});
test('resume follows current Build verification, edits, restore gate and failure without logs or provider reports', async () => {
 const p = await store.create(input), folder = await store.folder(p.id); const identity = await sourceIdentity(folder);
 const run = {id: 'd32ad610-0b20-45d3-86d4-6eaf82d97468', identity, startedAt: p.createdAt, endedAt: p.createdAt, status: 'PASSED' as const,
  checks: Object.fromEntries(['typecheck', 'build', 'test'].map(k => [k, {status: 'passed' as const, at: p.createdAt, log: 'password=synthetic-canary-do-not-export'}])), diagnostics: []};
 const verified = {...p, verification: run}; await store.persist(verified);
 const record = (await buildResume(verified, folder, identity)).record;
 expect(record.completionState).toBe('CURRENT_CHECKS_PASS_NO_FLOW'); expect(JSON.stringify(record)).not.toContain('synthetic-canary');
 await fs.writeFile(path.join(folder, '.launchforge/provider-result.json'), JSON.stringify({success: true, completion: 'PASSED'}));
 expect((await buildResume(p, folder, identity)).record.completionState).toBe('NOT_RUN');
 await fs.appendFile(path.join(folder, 'src/main.tsx'), '\n// changed source\n');
 expect((await buildResume(verified, folder, await sourceIdentity(folder))).record.completionState).toBe('STALE');
 expect((await buildResume({...verified, restore: {id: 'r', at: p.createdAt, target: 't', paths: [], outcome: 'RESTORED_SOURCE_ONLY', verificationRequired: true}}, folder, identity)).record.completionState).toBe('STALE');
 expect((await buildResume({...verified, verification: {...run, status: 'FAILED', checks: {...run.checks, build: {status: 'NOT_RUN_IN_THIS_RUN', at: p.createdAt, log: ''}}}}, folder, identity)).record.completionState).toBe('INCOMPLETE');
});
test('bounded file adapter rejects hardlinks and oversized reads, and writes private derived files', async () => {
 const p = await store.create(input), folder = await store.folder(p.id);
 await fs.writeFile(path.join(folder, 'first'), '12345'); await fs.link(path.join(folder, 'first'), path.join(folder, 'second'));
 await expect(readBounded(folder, 'second')).rejects.toThrow(); await expect(readBounded(folder, 'package.json', 4)).rejects.toThrow();
 await writeDerived(folder, '.launchforge/resume.md', 'derived'); expect((await fs.stat(path.join(folder, '.launchforge/resume.md'))).mode & 0o777).toBe(0o600);
});
test('full brief is hash-bound without truncation or copying credentials into a portable task', async () => {
 const p = await store.create({...input, brief: 'x'.repeat(9000) + ' password=synthetic-sensitive-text'}); const folder = await store.folder(p.id);
 const result = await prepareHandoff(p, folder, {reviewed: true});
 expect(result.plan.packet.markdown).not.toContain('synthetic-sensitive-text');
 expect((await fs.readFile(path.join(folder, '.launchforge/brief.md'), 'utf8'))).toContain(p.brief);
 expect(result.plan.packet.markdown).toContain('.launchforge/brief.md');
});
