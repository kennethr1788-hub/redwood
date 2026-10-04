import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {createContentProject, openContentProject} from '../../src/content/project.js';
import {audit, intake} from './fixtures.js';

async function fixture(t) {
  await mkdir('.work/content-tests', {recursive: true});
  const root = await mkdtemp(path.resolve('.work/content-tests/project-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  return {root, directory: path.join(root, 'content')};
}

test('ordinary project files reopen deterministically and retain all outputs', async t => {
  const {directory} = await fixture(t);
  const result = await createContentProject(directory, audit, intake);
  assert.equal(result.status, 'DRAFT_REQUIRES_REVIEW');
  const opened = await openContentProject(directory);
  assert.deepEqual(opened, await openContentProject(directory));
  assert.deepEqual(opened.report.changedFiles, []);
  assert.equal(opened.report.ledgerMatches, true);
  assert.ok(opened.files['article.html'].includes('<h2>How to get started</h2>'));
  assert.ok(opened.files['article.md'].includes('fact: export'));
  assert.equal(JSON.parse(opened.files['faq.json'])[0].answer, 'Export a notebook as Markdown.');
  assert.ok(opened.files['EDITING.md'].includes('existing official Codex, Claude Code, Cursor'));
  assert.ok(opened.report.unsupportedFacts.some(f => f.id === 'fake-price'));
});

test('Markdown, HTML, FAQ and metadata edits survive reopening and stay unverified', async t => {
  const {directory} = await fixture(t);
  await createContentProject(directory, audit, intake);
  const edits = {
    'article.md': '# My article\n\nUnsourced guarantee: 100% success. [fact: export]\n',
    'article.html': '<article><h1>My edited HTML</h1><p>Independent copy.</p></article>\n',
    'faq.json': JSON.stringify([{question: 'Will I succeed?', answer: 'Always.', factIds: ['export']}]),
    'metadata.json': JSON.stringify({title: 'Guaranteed success', factIds: ['export']}),
  };
  for (const [name, value] of Object.entries(edits)) await writeFile(path.join(directory, name), value);
  const reopened = await openContentProject(directory);
  for (const [name, value] of Object.entries(edits)) {
    assert.equal(reopened.files[name], value);
    assert.equal(await readFile(path.join(directory, name), 'utf8'), value);
    assert.equal(reopened.report.artifacts[name], 'EDITED_UNVERIFIED');
  }
  assert.equal(reopened.report.status, 'DRAFT_REQUIRES_REVIEW');
  assert.match(reopened.report.warnings.join(' '), /Citation IDs alone do not validate/);
  await assert.rejects(createContentProject(directory, audit, intake), {code: 'EEXIST'});
  assert.equal(await readFile(path.join(directory, 'article.md'), 'utf8'), edits['article.md']);
});

test('changed sources invalidate stale output and recompute the ledger without rewriting drafts', async t => {
  const {directory} = await fixture(t);
  await createContentProject(directory, audit, intake);
  const article = await readFile(path.join(directory, 'article.md'), 'utf8');
  const modified = structuredClone(intake);
  modified.sources[0].excerpt = 'Exports were discontinued.';
  await writeFile(path.join(directory, 'intake.json'), JSON.stringify(modified));
  const reopened = await openContentProject(directory);
  assert.equal(reopened.report.inputsChanged, true);
  assert.equal(reopened.report.ledgerMatches, false);
  assert.equal(reopened.ledger.facts.find(f => f.id === 'export').status, 'UNVERIFIED');
  assert.equal(reopened.report.artifacts['article.md'], 'STALE_INPUTS_REVIEW_REQUIRED');
  assert.equal(reopened.files['article.md'], article);
});

test('forged ledger status is not accepted as source provenance', async t => {
  const {directory} = await fixture(t);
  await createContentProject(directory, audit, intake);
  const file = path.join(directory, 'ledger.json');
  const ledger = JSON.parse(await readFile(file, 'utf8'));
  ledger.facts.find(f => f.id === 'fake-price').status = 'SOURCE_BACKED';
  await writeFile(file, JSON.stringify(ledger));
  const reopened = await openContentProject(directory);
  assert.equal(reopened.report.ledgerMatches, false);
  assert.equal(reopened.ledger.facts.find(f => f.id === 'fake-price').status, 'UNVERIFIED');
});

test('malformed editor JSON fails without destroying the edited file', async t => {
  const {directory} = await fixture(t);
  await createContentProject(directory, audit, intake);
  const file = path.join(directory, 'faq.json');
  await writeFile(file, '{unfinished edit');
  await assert.rejects(openContentProject(directory), /Invalid JSON in faq.json; edit preserved/);
  assert.equal(await readFile(file, 'utf8'), '{unfinished edit');
});

test('reopening rejects symlink files, missing manifest and oversized editor files', async t => {
  const {root, directory} = await fixture(t);
  await mkdir(directory);
  await assert.rejects(openContentProject(directory), {code: 'ENOENT'});
  await rm(directory, {recursive: true});
  await createContentProject(directory, audit, intake);
  const file = path.join(directory, 'article.md');
  const external = path.join(root, 'external.md');
  await writeFile(external, 'Untouched');
  await rm(file);
  await symlink(external, file);
  await assert.rejects(openContentProject(directory), /ELOOP/);
  assert.equal(await readFile(external, 'utf8'), 'Untouched');
  await rm(file);
  await writeFile(file, 'x'.repeat(2_000_001));
  await assert.rejects(openContentProject(directory), /ordinary file under 2 MB/);
});

test('CLI initializes from a saved app project then reviews edits in another process', async t => {
  const {root, directory} = await fixture(t);
  const auditFile = path.join(root, 'app-project.json'), intakeFile = path.join(root, 'intake.json');
  await writeFile(auditFile, JSON.stringify({audit}));
  await writeFile(intakeFile, JSON.stringify(intake));
  const run = args => JSON.parse(execFileSync(process.execPath, ['src/content/cli.js', ...args], {encoding: 'utf8'}));
  assert.equal(run(['init', '--audit', auditFile, '--intake', intakeFile, '--out', directory]).status, 'DRAFT_REQUIRES_REVIEW');
  await writeFile(path.join(directory, 'article.md'), '# Saved external edit\n');
  const result = run(['review', '--project', directory]);
  assert.equal(result.artifacts['article.md'], 'EDITED_UNVERIFIED');
  assert.equal(await readFile(path.join(directory, 'article.md'), 'utf8'), '# Saved external edit\n');
  const invalid = spawnSync(process.execPath, ['src/content/cli.js', 'init', '--out', directory, '--bogus', 'value'], {encoding: 'utf8'});
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Grow content/);
});
