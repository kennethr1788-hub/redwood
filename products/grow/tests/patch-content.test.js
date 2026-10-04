import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, symlink, rm} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {buildContent, validateMarkdown} from '../src/content/index.js';
import {proposePatch, preparePatchHandoff} from '../src/patch/index.js';

const fixture = '<!doctype html>\n<html><head><title>Old title</title></head><body><h1>Real product</h1><p>Actual page text.</p></body></html>\n';
const changes = {title: 'Real product & tools', description: 'Actual page description.', canonical: 'https://example.com/', jsonLd: {'@context': 'https://schema.org', '@type': 'WebSite', name: 'Real product', url: 'https://example.com/'}};
async function checkout(t, git = false) {
  const scratch = path.resolve('.work/patch-tests');
  await mkdir(scratch, {recursive: true});
  const root = await mkdtemp(path.join(scratch, 'source-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(path.join(root, 'index.html'), fixture);
  if (git) {
    const run = args => execFileSync('git', ['-C', root, ...args], {stdio: 'pipe'});
    run(['init']); run(['add', 'index.html']);
    run(['-c', 'user.name=Grow test', '-c', 'user.email=grow@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  }
  return root;
}

test('source-backed draft cites real excerpts and describes evidence honestly', () => {
  const result = buildContent({url: 'https://example.com/', pages: [
    {url: 'https://example.com/', title: 'Real product', description: 'A documented writing tool.', links: []},
    {url: 'https://example.com/help', title: 'Help', text: 'Export Markdown from the editor.'},
  ], findings: []});
  assert.equal(result.faq[0].answer, 'A documented writing tool.');
  assert.equal(result.claims[1].sourceUrl, 'https://example.com/help');
  assert.equal(result.jsonLd['@type'], 'WebSite');
  assert.equal(result.evidenceType, 'CRAWLER_OBSERVATION');
  assert.ok(result.suggestions.some(item => item.kind === 'INTERNAL_LINK_REVIEW'));
  assert.ok(result.markdown.includes('[Source](https://example.com/)'));
  assert.ok(result.markdown.includes('No ranking or answer-engine inclusion is promised'));
  assert.equal(validateMarkdown(result.markdown).valid, true);
  assert.throws(() => buildContent({pages: []}), /No successfully crawled/);
  assert.throws(() => validateMarkdown('x'.repeat(200_001)), /smaller than 200 KB/);
});

test('inner-page schema does not invent an organization or site root', () => {
  const content = buildContent({pages: [{url: 'https://example.com/features', title: 'Features', text: ''}]});
  assert.equal(content.jsonLd['@type'], 'WebPage');
  assert.equal(content.claims.length, 0);
  assert.equal(content.faq.length, 0);
  const titleFallback = buildContent({pages: [{url: 'https://example.com/a%20b(test)', title: 'Actual title', h1: [], text: '<script>untrusted</script>'}]});
  assert.equal(titleFallback.jsonLd.name, 'Actual title');
  assert.ok(titleFallback.markdown.includes('https://example.com/a%20b%28test%29'));
  assert.ok(!titleFallback.markdown.includes('> <script>'));
});

test('missing and unsupported source fail without a fabricated patch', async t => {
  await assert.rejects(proposePatch('', changes), /Select an explicit/);
  await assert.rejects(proposePatch(path.resolve('.work/not-a-checkout'), changes), /does not exist/);
  const root = await checkout(t);
  await writeFile(path.join(root, 'index.html'), '<html><head>{{ renderMetadata() }}</head></html>');
  await assert.rejects(proposePatch(root, changes), /Template source is unsupported/);
});

test('explicit approval and untampered proposal are required', async t => {
  const root = await checkout(t);
  const proposal = await proposePatch(root, changes);
  assert.match(proposal.diff, /--- a\/index.html/);
  await assert.rejects(preparePatchHandoff(root, proposal), /Explicit approval/);
  await assert.rejects(preparePatchHandoff(root, proposal, {approvedHash: 'wrong'}), /Explicit approval/);
  for (const modified of [{...proposal, after: proposal.after + '<script>bad()</script>'}, {...proposal, diff: proposal.diff + 'tampered'}, {...proposal, evidenceBinding: {...proposal.evidenceBinding, sourceHash: 'wrong'}}]) {
    await assert.rejects(preparePatchHandoff(root, modified, {approvedHash: proposal.hash}), /Explicit approval/);
  }
  assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), fixture);
});

test('stale source is preserved and requires a new proposal', async t => {
  const root = await checkout(t);
  const proposal = await proposePatch(root, changes);
  const edited = fixture.replace('Actual page text.', 'User edited this.');
  await writeFile(path.join(root, 'index.html'), edited);
  await assert.rejects(preparePatchHandoff(root, proposal, {approvedHash: proposal.hash}), /changed/);
  assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), edited);
});

test('reviewed handoff validates candidate without writing source or unrelated dirty files', async t => {
  const root = await checkout(t, true);
  await writeFile(path.join(root, 'notes.txt'), 'Unrelated user edits');
  const proposal = await proposePatch(root, changes);
  assert.ok(proposal.baseCommit);
  const applied = await preparePatchHandoff(root, proposal, {approvedHash: proposal.hash});
  assert.equal(applied.status, 'HANDOFF_READY');
  assert.equal(applied.sourceWrite, 'NONE');
  assert.match(applied.prompt, /Run Build verification afterward/);
  assert.match(applied.prompt, /Do not deploy or publish/);
  assert.equal(applied.gitCheck, 'PASSED');
  assert.equal(applied.deployedVerification, 'NOT_RUN');
  assert.ok(applied.checks.every(check => check.passed));
  assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'Unrelated user edits');
  assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), fixture);
  assert.equal((await preparePatchHandoff(root, proposal, {approvedHash: proposal.hash})).status, 'HANDOFF_READY');
});

test('symlink source and mismatched checkout cannot redirect a reviewed handoff', async t => {
  const root = await checkout(t);
  const target = await checkout(t);
  const proposal = await proposePatch(root, changes);
  await assert.rejects(preparePatchHandoff(target, proposal, {approvedHash: proposal.hash}), /different source/);
  await rm(path.join(root, 'index.html'));
  await symlink(path.join(target, 'index.html'), path.join(root, 'index.html'));
  await assert.rejects(preparePatchHandoff(root, proposal, {approvedHash: proposal.hash}), /ordinary file/);
  assert.equal(await readFile(path.join(target, 'index.html'), 'utf8'), fixture);
});


test('changed Git base requires fresh proposal and review even with identical HTML', async t => {
  const root = await checkout(t, true);
  const proposal = await proposePatch(root, changes);
  execFileSync('git', ['-C', root, '-c', 'user.name=Grow test', '-c', 'user.email=grow@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'new base'], {stdio: 'pipe'});
  await assert.rejects(preparePatchHandoff(root, proposal, {approvedHash: proposal.hash}), /base commit changed/);
  const next = await proposePatch(root, changes);
  assert.notEqual(next.hash, proposal.hash);
  await assert.rejects(preparePatchHandoff(root, next, {approvedHash: proposal.hash}), /Explicit approval/);
});

test('GROW_CAN_DIRECTLY_MUTATE_PRODUCT_SOURCE = NO: module exposes no executor', async () => {
  const api = await import('../src/patch/index.js');
  assert.equal(api.applyPatch, undefined);
  assert.deepEqual(Object.keys(api).sort(), ['preparePatchHandoff', 'proposePatch']);
});
