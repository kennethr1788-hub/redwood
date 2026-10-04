import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir, mkdtemp, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {importLighthouseReport, importUnlighthouseRun, compareLighthouseReports} from '../../src/audit/lighthouse-report.js';
import {importUnlighthouseDirectory} from '../../src/audit/import-unlighthouse.js';
import {digest} from '../../src/audit/html-evidence.js';

const origin = 'https://example.com';
const lhr = (url = `${origin}/`, overrides = {}) => ({lighthouseVersion: '13.5.0', requestedUrl: url, finalDisplayedUrl: url, finalUrl: url, fetchTime: '2026-10-03T10:00:00Z', configSettings: {formFactor: 'desktop'}, categories: {seo: {score: 0.9}, performance: {score: null}}, audits: {
  'meta-description': {id: 'meta-description', title: 'Description', score: 0, scoreDisplayMode: 'binary', details: {type: 'table', items: [{node: {snippet: '<head>'}}]}},
  na: {score: null, scoreDisplayMode: 'notApplicable'}, manual: {score: null, scoreDisplayMode: 'manual'}, info: {score: null, scoreDisplayMode: 'informative'}, pass: {score: 1, scoreDisplayMode: 'binary'},
}, runWarnings: ['Synthetic fixture'], ...overrides});
const run = overrides => importUnlighthouseRun({origin, ciReport: {routes: [{path: '/'}], summary: {score: 1}}, reports: [{path: 'reports/lighthouse.json', report: lhr()}], expectedUrls: [`${origin}/`], truncated: false, exitCode: 0, config: {maxRoutes: 3}, sourceRevision: 'fixture-r1', ...overrides});

test('native report exact bytes, URLs, warnings, details and all scores survive import', () => {
  const raw = `${JSON.stringify(lhr(), null, 2)}\n`;
  const imported = importLighthouseReport(raw, {artifactPath: 'reports/lighthouse.json', runId: 'fixture-run'});
  assert.equal(imported.evidenceHash, digest(raw)); assert.equal(imported.hashBasis, 'EXACT_INPUT_BYTES');
  assert.equal(imported.categories.find(c => c.id === 'performance').score, null);
  assert.deepEqual(imported.rawReport, lhr()); assert.deepEqual(imported.runWarnings, ['Synthetic fixture']);
  assert.equal(imported.observations.find(a => a.id === 'na').state, 'NOT_APPLICABLE');
  assert.equal(imported.observations.find(a => a.id === 'manual').state, 'MANUAL');
  assert.equal(imported.observations.find(a => a.id === 'pass').state, 'PASS');
  assert.equal(imported.observations.find(a => a.id === 'meta-description').details.items[0].node.snippet, '<head>');
  assert.deepEqual(imported.findings.map(f => f.rule), ['lighthouse:meta-description']);
  assert.equal(imported.completeness, 'COMPLETE');
});

test('missing/unknown/error native observations are never converted into zero/fixed', () => {
  for (const audit of [{score: null}, {score: 5}, {score: '1'}, {score: null, scoreDisplayMode: 'error', errorMessage: 'timeout'}]) {
    const result = importLighthouseReport(lhr(undefined, {audits: {issue: audit}}));
    assert.equal(result.completeness, 'PARTIAL'); assert.equal(result.findings.length, 0); assert.equal(result.observations[0].score, null);
  }
  const result = importLighthouseReport(lhr(undefined, {runtimeError: {code: 'NO_FCP', message: 'No content'}}));
  assert.equal(result.completeness, 'FAILED'); assert.equal(result.findings.length, 0);
});

test('exact inventory yields complete; cap, missing, duplicate, extra and error runs stay partial/failed', () => {
  assert.equal(run().status, 'COMPLETE');
  assert.equal(run({truncated: true}).status, 'PARTIAL');
  assert.equal(run({truncated: undefined}).status, 'PARTIAL');
  assert.equal(run({exitCode: 1}).status, 'PARTIAL');
  assert.equal(run({expectedUrls: [`${origin}/`, `${origin}/about`]}).status, 'PARTIAL');
  assert.equal(run({reports: []}).status, 'FAILED');
  assert.equal(run({reports: [null]}).status, 'FAILED');
  assert.equal(run({reports: [{path: 'bad', report: '{}'}]}).status, 'FAILED');
  assert.equal(run({ciReport: {routes: []}}).status, 'PARTIAL');
  assert.equal(run({reports: [{path: 'a', report: lhr()}, {path: 'b', report: lhr()}]}).status, 'PARTIAL');
  assert.equal(run({reports: [{path: 'a', report: lhr()}, {path: 'b', report: lhr(`${origin}/extra`)}]}).status, 'PARTIAL');
  assert.equal(run({reports: [{path: 'a', report: lhr(undefined, {runtimeError: {code: 'TIMEOUT'}})}]}).status, 'FAILED');
});

test('native requested URL joins independently of output filename and retains redirect identity', () => {
  const result = run({reports: [{path: 'reports/arbitrary-name/lighthouse.json', report: lhr(undefined, {finalUrl: `${origin}/final`, finalDisplayedUrl: `${origin}/final`})}]});
  assert.equal(result.status, 'COMPLETE'); assert.equal(result.pages[0].requestedUrl, `${origin}/`); assert.equal(result.pages[0].url, `${origin}/final`);
  assert.throws(() => run({expectedUrls: ['http://other.example/']}), /same-origin/);
});

test('frozen qualified Unlighthouse 13.5.0 reports prove score 0 -> 1 and exact artifact hashes', async () => {
  const files = new URL('./fixtures/', import.meta.url);
  const before = importLighthouseReport(await readFile(new URL('before-lighthouse.json', files)));
  const after = importLighthouseReport(await readFile(new URL('after-lighthouse.json', files)));
  const hashes = JSON.parse(await readFile(new URL('sha256.json', files), 'utf8'));
  assert.equal(before.evidenceHash, hashes['before-lighthouse.json']); assert.equal(after.evidenceHash, hashes['after-lighthouse.json']);
  assert.equal(before.lighthouseVersion, '13.5.0');
  assert.equal(before.observations.find(a => a.id === 'meta-description').score, 0);
  assert.equal(after.observations.find(a => a.id === 'meta-description').score, 1);
  assert.equal(compareLighthouseReports(before, after, 'meta-description').state, 'RECHECK_PASSED');
});

test('stale, null/notApplicable, wrong URL, settings drift and runtime error cannot pass a lab recheck', () => {
  const before = importLighthouseReport(lhr());
  const fixed = {fetchTime: '2026-10-03T10:01:00Z', audits: {'meta-description': {score: 1, scoreDisplayMode: 'binary'}}};
  assert.equal(compareLighthouseReports(before, importLighthouseReport(lhr(undefined, fixed)), 'meta-description').state, 'RECHECK_PASSED');
  for (const changes of [
    {fetchTime: lhr().fetchTime}, {requestedUrl: `${origin}/other`}, {lighthouseVersion: '14.0.0'}, {runtimeError: {code: 'FAIL'}},
    {audits: {}}, {audits: {'meta-description': {score: null, scoreDisplayMode: 'notApplicable'}}}, {configSettings: {formFactor: 'mobile'}}, {configSettings: undefined},
  ]) assert.equal(compareLighthouseReports(before, importLighthouseReport(lhr(undefined, {...fixed, ...changes})), 'meta-description').state, 'UNVERIFIED');
  assert.equal(compareLighthouseReports(before, before, 'meta-description').state, 'UNVERIFIED');
});

test('directory integration reads root/nested native reports and reports static-stage missing JSON honestly', async t => {
  const scratch = path.resolve('.work/lhr-import'); await mkdir(scratch, {recursive: true});
  const root = await mkdtemp(path.join(scratch, 'run-')); t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'reports', 'about'), {recursive: true});
  await writeFile(path.join(root, 'ci-result.json'), JSON.stringify({routes: [{path: '/'}, {path: '/about'}]}));
  await writeFile(path.join(root, 'reports', 'lighthouse.json'), JSON.stringify(lhr()));
  await writeFile(path.join(root, 'reports', 'about', 'lighthouse.json'), JSON.stringify(lhr(`${origin}/about`)));
  const options = {origin, expectedUrls: [`${origin}/`, `${origin}/about`], truncated: false};
  assert.equal((await importUnlighthouseDirectory(root, options)).status, 'COMPLETE');
  await rm(path.join(root, 'reports'), {recursive: true});
  const missing = await importUnlighthouseDirectory(root, options);
  assert.equal(missing.status, 'FAILED'); assert.equal(missing.coverage.missing.length, 2);
});
