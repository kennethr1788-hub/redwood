import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {auditSite, inspectHtml, findingsForPage} from '../../src/audit/index.js';
import {digest} from '../../src/audit/html-evidence.js';
import {proposePatch, preparePatchHandoff} from '../../src/patch/index.js';

const html = '<!doctype html><html lang="en"><head><title>Field Notes</title></head><body><h1>Field Notes</h1><p>Capture team observations.</p></body></html>';
async function source(t, content = html) {
  const scratch = path.resolve('.work/audit-patch-tests'); await mkdir(scratch, {recursive: true});
  const root = await mkdtemp(path.join(scratch, 'source-')); t.after(() => rm(root, {recursive: true, force: true}));
  await writeFile(path.join(root, 'index.html'), content); return root;
}
async function server(t, handler) {
  const requests = [];
  const app = http.createServer((req, res) => { requests.push({method: req.method, url: req.url}); Promise.resolve(handler(req, res)).catch(error => {res.writeHead(500); res.end(error.message);}); });
  app.listen(0, '127.0.0.1'); await once(app, 'listening');
  t.after(() => new Promise(resolve => app.close(resolve)));
  const origin = `http://127.0.0.1:${app.address().port}`;
  const outputDir = await source(t);
  const runCli = fixtureCli;
  return {origin, requests, options: {allowedLocalOrigin: origin, outputDir, runCli}};
}
// Native runner interface double for fast HTML/patch tests, not runtime evidence.
// The unchanged production runner is exercised twice by tests/e2e.js.
async function fixtureCli({config, outputDir}) {
  const url = config.site;
  await writeFile(path.join(outputDir, 'ci-result.json'), JSON.stringify({routes: [{path: new URL(url).pathname}]}));
  const reportDir = path.join(outputDir, 'reports'); await mkdir(reportDir, {recursive:true});
  await writeFile(path.join(reportDir, 'lighthouse.json'), JSON.stringify({requestedUrl:url, finalUrl:url, lighthouseVersion:'13.5.0',fetchTime:new Date().toISOString(),categories:{seo:{score:1}},audits:{fixture:{score:1,scoreDisplayMode:'binary'}}}));
}

function resource(req, res, sitemap = '<urlset/>', robots = 'User-agent: *\nAllow: /') {
  if (req.url === '/robots.txt') { res.setHeader('Content-Type', 'text/plain'); res.end(robots); return true; }
  if (req.url === '/sitemap.xml') { res.setHeader('Content-Type', 'application/xml'); res.end(sitemap); return true; }
  return false;
}

test('before/after: live finding -> exact source binding -> diff -> inert handoff -> externally changed source -> fresh URL recheck', async t => {
  const root = await source(t);
  const fixture = await server(t, async (req, res) => {
    if (resource(req, res)) return;
    res.setHeader('Content-Type', 'text/html'); res.end(await readFile(path.join(root, 'index.html')));
  });
  const before = await auditSite(fixture.origin, fixture.options);
  assert.equal(before.status, 'COMPLETE');
  const finding = before.findings.find(item => item.rule === 'description-missing');
  const proposal = await proposePatch(root, {description: 'Capture and share field observations.'}, {evidencePage: before.pages[0]});
  assert.equal(proposal.evidenceBinding.auditEvidenceHash, finding.evidenceRef.hash);
  assert.equal(proposal.evidenceBinding.auditEvidenceId, finding.evidenceRef.id);
  assert.equal(proposal.beforeFindings.find(item => item.rule === finding.rule).id, finding.id);
  assert.match(proposal.diff, /\+.*meta name="description"/);
  assert.equal(proposal.status, 'PROPOSED');
  await assert.rejects(preparePatchHandoff(root, proposal), /Explicit approval/);
  assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), html);
  const handoff = await preparePatchHandoff(root, JSON.parse(JSON.stringify(proposal)), {approvedHash: proposal.hash});
  assert.equal(handoff.status, 'HANDOFF_READY');
  assert.equal(handoff.sourceVerification, 'NOT_RUN');
  assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), html);
  // External coding-workflow fixture: Grow only observes the later change.
  await writeFile(path.join(root, 'index.html'), proposal.after);
  const after = await auditSite(fixture.origin, fixture.options);
  assert.equal(after.status, 'COMPLETE');
  assert(!after.findings.some(item => item.rule === 'description-missing'));
  assert.equal(after.pages[0].evidenceHash, digest(proposal.after));
  assert.notEqual(before.runId, after.runId);
  assert.equal(before.findings.find(item => item.id === finding.id).state, 'OPEN');
});

test('real cap and HEAD redirect remain visibly PARTIAL with exact omitted routes', async t => {
  const fixture = await server(t, (req, res) => {
    if (req.url === '/entry') {res.writeHead(301, {Location: '/product'}); res.end(); return;}
    if (resource(req, res, '<urlset><url><loc>/about</loc></url></urlset>')) return;
    res.setHeader('Content-Type', 'text/html'); res.end(html + '<a href="/about">About</a>');
  });
  const result = await auditSite(`${fixture.origin}/entry`, {...fixture.options, maxPages: 1});
  assert.equal(result.status, 'PARTIAL'); assert.equal(result.limits.truncated, true);
  assert.deepEqual(result.coverage.omitted, [`${fixture.origin}/about`]);
  assert(result.coverage.partialReasons.includes('PAGE_LIMIT'));
  assert.equal(result.requestedUrl, `${fixture.origin}/entry`); assert.equal(result.finalUrl, `${fixture.origin}/product`);
  assert.deepEqual(fixture.requests.slice(0, 3), [{method: 'HEAD', url: '/entry'}, {method: 'HEAD', url: '/product'}, {method: 'GET', url: '/robots.txt'}]);
});

test('duplicate known routes do not fabricate omissions; selected runner cap still limits completeness', async t => {
  const fixture = await server(t, (req, res) => {
    if (resource(req, res, '<urlset><url><loc>/</loc></url><url><loc>/</loc></url></urlset>')) return;
    res.setHeader('Content-Type', 'text/html'); res.end(html + '<a href="/">Home</a>');
  });
  const result = await auditSite(fixture.origin, {...fixture.options, maxPages: 1});
  assert.equal(result.status, 'PARTIAL'); assert.equal(result.limits.truncated, true); assert.equal(result.pages.length, 1); assert.deepEqual(result.coverage.omitted, []);
});

test('selected runner rejects failed entry preflight without running a fallback crawler', async t => {
  const fixture = await server(t, (req, res) => {res.writeHead(503);res.end('Unavailable');});
  let ran = false;
  const failed = await auditSite(fixture.origin, {...fixture.options, runCli: async()=>{ran=true;}});
  assert.equal(failed.status, 'FAILED'); assert.equal(failed.pages.length, 0);
  assert.match(failed.errors[0].message, /503/); assert.equal(ran, false);
});

for (const [name, sitemap, reason] of [
  ['index', '<sitemapindex><sitemap><loc>https://example.com/child.xml</loc></sitemap></sitemapindex>', 'SITEMAP_INDEX_NOT_EXPANDED'],
  ['invalid XML', '<urlset><url></urlset>', null],
]) test(`uninspected sitemap ${name} is visibly partial`, async t => {
  const fixture = await server(t, (req, res) => {if (resource(req, res, sitemap)) return;res.setHeader('Content-Type', 'text/html');res.end(html);});
  const result = await auditSite(fixture.origin, fixture.options);
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.resources.sitemap.evidenceHash, digest(sitemap));
  if (reason) assert(result.coverage.partialReasons.includes(reason)); else assert(result.findings.some(f => f.rule === 'sitemap-unreadable'));
});

test('technical findings retain exact duplicates, syntax blocks, structural and header evidence', () => {
  const body = '<html><head><title>A</title><title>B</title><meta name="DESCRIPTION" content=""><meta name="description" content="Second"><link rel="canonical alternate" href="/relative"><link rel="canonical" href="javascript:bad"><meta property="og:title" content="A"><meta property="og:title" content="B"><meta property="og:image" content="javascript:bad"><meta name="robots" content="index"><meta name="GOOGLEBOT" content="none"><script type="application/ld+json">{invalid</script><script type="application/ld+json">null</script></head><body><h1></h1><h1>Heading</h1><h3>Skip</h3></body></html>';
  const page = inspectHtml(body, 'https://example.com/', 200, {xRobotsTag: 'googlebot: noindex, nofollow'});
  const findings = findingsForPage(page);
  for (const rule of ['title-duplicate','description-duplicate','canonical-duplicate','canonical-invalid','og-title-duplicate','og-image-invalid','noindex','x-robots-noindex','schema-invalid-json','schema-invalid-shape','h1-multiple','heading-level-skip','html-lang-missing']) assert(findings.some(f => f.rule === rule), rule);
  assert.deepEqual(page.metadata.descriptions, ['', 'Second']);
  assert.equal(page.jsonLdBlocks[0].raw, '{invalid');
  assert.equal(page.jsonLdBlocks[1].parsed, null); assert.equal(page.jsonLdBlocks[1].parseError, null);
  assert.equal(findings.filter(f => f.rule === 'canonical-invalid').length, 2);
  assert.equal(new Set(findings.map(f => f.id)).size, findings.length);
  assert.equal(findings.find(f => f.rule === 'x-robots-noindex').evidenceRef.kind, 'HTTP_HEADERS');
  assert.equal(findings.find(f => f.rule === 'schema-invalid-json').evidenceRef.hash, digest(body));
});

test('finding IDs survive discovery order and changed evidence, not unrelated URL changes', () => {
  const a = findingsForPage(inspectHtml(html, 'https://example.com/'));
  const b = findingsForPage(inspectHtml(html.replace('Field Notes', 'New title'), 'https://example.com/'));
  const c = findingsForPage(inspectHtml(html, 'https://example.com/other'));
  const pick = values => values.find(f => f.rule === 'description-missing');
  assert.equal(pick(a).id, pick(b).id); assert.notEqual(pick(a).evidenceRef.hash, pick(b).evidenceRef.hash);
  assert.notEqual(pick(a).id, pick(c).id);
});

test('indexing substrings are not incorrectly treated as directives', () => {
  const findings = findingsForPage(inspectHtml('<meta name="robots" content="index, x-noindex-test">', 'https://example.com/'));
  assert(!findings.some(f => f.rule === 'noindex'));
});

test('adding valid JSON-LD does not mark existing broken author JSON-LD repaired', async t => {
  const root = await source(t, html.replace('</head>', '<script type="application/ld+json">{broken</script></head>'));
  const proposal = await proposePatch(root, {jsonLd: {'@context': 'https://schema.org', '@type': 'WebPage', name: 'Field Notes'}});
  const applied = await preparePatchHandoff(root, proposal, {approvedHash: proposal.hash});
  assert(findingsForPage(inspectHtml(proposal.after, 'https://example.com/')).some(f => f.rule === 'schema-invalid-json'));
  assert.equal(applied.sourceVerification, 'NOT_RUN');
  assert.match(await readFile(path.join(root, 'index.html'), 'utf8'), /\{broken/);
});

test('reviewed OG changes and duplicate metadata are diffed and rechecked', async t => {
  const root = await source(t, html.replace('</head>', '<title>Duplicate</title><meta property="og:title" content="old"><meta property="og:title" content="duplicate"></head>'));
  const proposal = await proposePatch(root, {title: 'Field Notes', canonical: 'https://example.com/', og: {title: 'Field Notes & teams', description: 'Take notes', image: 'https://example.com/image.png', url: 'https://example.com/', type: 'website'}});
  const applied = await preparePatchHandoff(root, proposal, {approvedHash: proposal.hash});
  assert(applied.checks.every(check => check.passed));
  const candidateFindings = findingsForPage(inspectHtml(proposal.after, 'https://example.com/'));
  for (const rule of ['title-duplicate', 'og-title-duplicate', 'og-image-missing']) assert(!candidateFindings.some(f => f.rule === rule));
  assert(candidateFindings.some(f => f.rule === 'description-missing'));
  assert.equal(applied.sourceVerification, 'NOT_RUN');
});

for (const [name, content] of [
  ['template', '<html><head>{{ metadata }}</head><body>Text</body></html>'],
  ['Vite/React shell', '<html><head><title>App</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>'],
  ['Next shell', '<html><head></head><body><div id="__next"></div></body></html>'],
]) test(`unsupported ${name} fails honestly and leaves bytes untouched`, async t => {
  const root = await source(t, content);
  await assert.rejects(proposePatch(root, {title: 'Change'}), /unsupported/);
  assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), content);
});

test('mismatched audit, rendered evidence and unsupported page mapping cannot claim a source binding', async t => {
  const root = await source(t);
  for (const page of [inspectHtml(html + 'changed', 'https://example.com/'), inspectHtml(html, 'https://example.com/inner'), inspectHtml(html, 'https://example.com/', 200, {evidenceKind: 'RENDERED_DOM'})]) {
    await assert.rejects(proposePatch(root, {title: 'New'}, {evidencePage: page}), /match|mapping/);
  }
});

test('recheck does not clear an issue when approved value still violates the rule', async t => {
  const root = await source(t, html.replace('Field Notes', 'x'.repeat(80)));
  const proposal = await proposePatch(root, {title: 'y'.repeat(90)});
  const applied = await preparePatchHandoff(root, proposal, {approvedHash: proposal.hash});
  assert(findingsForPage(inspectHtml(proposal.after, 'https://example.com/')).some(f => f.rule === 'title-length'));
  assert.equal(applied.sourceVerification, 'NOT_RUN');
});

test('moving an author JSON-LD block cannot make its syntax error look repaired', async t => {
  const root = await source(t, html.replace('</head>', '<script type="application/ld+json" data-launchforge="schema">{}</script><script type="application/ld+json">{broken</script></head>'));
  const proposal = await proposePatch(root, {jsonLd: {'@context': 'https://schema.org', '@type': 'WebPage', name: 'Field Notes'}});
  const old = proposal.beforeFindings.find(f => f.rule === 'schema-invalid-json');
  const applied = await preparePatchHandoff(root, proposal, {approvedHash: proposal.hash});
  const remaining = findingsForPage(inspectHtml(proposal.after, 'https://example.com/'));
  assert.notEqual(old.id, remaining.find(f => f.rule === old.rule).id);
  assert(remaining.some(f => f.rule === old.rule));
  assert.equal(applied.sourceVerification, 'NOT_RUN');
});

test('server API uses the inert handoff path and persists honest state across reopen', async t => {
  const {createApp} = await import('../../src/server.js');
  const root = await source(t);
  const site = await server(t, async (req, res) => {if (resource(req, res)) return;res.setHeader('Content-Type', 'text/html');res.end(await readFile(path.join(root, 'index.html')));});
  const dataDir = path.join(root, 'project-data');
  const app = createApp({dataDir, allowedLocalOrigin: site.origin, auditRunner:(url,options)=>auditSite(url,{...options,runCli:fixtureCli})});
  app.server.listen(0, '127.0.0.1');await once(app.server, 'listening');
  t.after(() => new Promise(resolve => {app.server.closeAllConnections();app.server.close(resolve);}));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, input) => {
    const response = await fetch(`${origin}${route}`, input === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(input)});
    return {status: response.status, data: await response.json()};
  };
  const created = await request('/api/projects', {name: 'Source recheck proof', url: site.origin, sourceDir: root, trustedSite: true});
  assert.equal(created.status, 201);const route = `/api/projects/${created.data.id}`;
  assert.equal((await request(`${route}/audit`, {})).data.audit.status, 'COMPLETE');
  const proposed = await request(`${route}/propose-patch`, {title: 'Field Notes', description: 'Capture actual field observations.', canonical: `${site.origin}/`});
  assert.equal(proposed.status, 200);assert.equal(proposed.data.patch.evidenceBinding.basis, 'EXACT_AUDIT_BYTES_MATCH');
  assert.equal((await request(`${route}/apply-patch`, {})).status, 410);
  const handoff = await request(`${route}/prepare-patch-handoff`, {approvedHash: proposed.data.patch.hash});
  assert.equal(handoff.status, 200);assert.equal(handoff.data.patchHandoff.status, 'HANDOFF_READY');
  assert.equal(handoff.data.patchHandoff.sourceVerification, 'NOT_RUN');
  assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), html);
  const reaudited = await request(`${route}/audit`, {});
  assert(reaudited.data.audit.findings.some(f => f.rule === 'description-missing'));
  const reopened = createApp({dataDir, allowedLocalOrigin: site.origin});
  const restored = await reopened.store.get(created.data.id);
  assert.deepEqual(restored.patchHandoff, handoff.data.patchHandoff);
  assert.deepEqual(restored.patch, proposed.data.patch);
  assert.equal(restored.patchResult, undefined);

});

test('candidate that cannot survive HTML parsing is rejected before handoff and has no success result', async t => {
  const root = await source(t);
  const proposal = await proposePatch(root, {description: 'Text\u0000with invalid null'});
  await assert.rejects(preparePatchHandoff(root, proposal, {approvedHash: proposal.hash}), /Candidate source recheck failed/);
  assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), html);
});
