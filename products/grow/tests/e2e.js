import {chromium} from 'playwright';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import {verifyExport, readDeliveryQueue, extractBundle} from '../src/delivery/index.js';
import {createContentProject, openContentProject} from '../src/content/project.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import {createApp} from '../src/server.js';
import {startSelectedStackFixture} from './fixtures/selected-stack.js';

// Real selected-stack integration. No auditRunner substitution: both passes invoke Unlighthouse.
const root = path.resolve('.work/e2e-selected');
const runRoot = path.join(root, `run-${Date.now()}`);
await mkdir(runRoot, {recursive: true});
const target = await startSelectedStackFixture(path.join(runRoot, 'source'));
let app = createApp({dataDir: path.join(runRoot, 'data'), allowedLocalOrigin: target.origin});
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
let appUrl = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({headless: true});
const page = await browser.newPage({viewport: {width: 1440, height: 1050}});
page.setDefaultTimeout(30_000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const expectedRoutes = ['/', '/about', '/app'];
const screenshot = name => page.screenshot({path: path.join(runRoot, name), fullPage: true});
const post = async (endpoint, data) => {
  const response = await fetch(`${appUrl}${endpoint}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  return result;
};
async function operation(action, click) {
  const response = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/${action}`), {timeout: 240_000});
  await click();
  const result = await response;
  const data = await result.json();
  assert.ok(result.ok(), JSON.stringify(data));
  await page.waitForFunction(() => !document.body.classList.contains('busy'), null, {timeout: 240_000});
  return data;
}
async function nativeEvidence(project, phase) {
  const audit = project.audit;
  assert.ok(audit.runId, 'Audit has its own run identity');
  assert.ok(['COMPLETE', 'PARTIAL'].includes(audit.status), JSON.stringify(audit.errors));
  assert.equal(audit.lab.status, 'COMPLETE', JSON.stringify(audit.lab));
  assert.equal(audit.lab.reports.length, 3);
  assert.deepEqual(audit.lab.expectedRoutes.map(url => new URL(url).pathname).sort(), [...expectedRoutes].sort());
  assert.deepEqual(audit.lab.observedRoutes.map(url => new URL(url).pathname).sort(), [...expectedRoutes].sort());
  const reports = [];
  for (const report of audit.lab.reports) {
    assert.ok(report.version && report.fetchTime && report.requestedUrl && report.finalUrl);
    assert.ok(!report.runtimeError, JSON.stringify(report.runtimeError));
    const artifact = await readFile(report.artifact);
    assert.equal(sha256(artifact), report.sha256, 'Native evidence hash matches saved bytes');
    const lhr = JSON.parse(artifact);
    assert.ok(!lhr.runtimeError);
    assert.equal(lhr.requestedUrl, report.requestedUrl);
    assert.equal(lhr.lighthouseVersion, report.version);
    assert.equal(new URL(lhr.requestedUrl).origin, target.origin);
    const description = report.observations.find(item => item.id === 'meta-description');
    assert.ok(description, 'Passing and failing observations both remain available');
    assert.equal(description.score, lhr.audits['meta-description'].score);
    const relative = path.relative(app.store.projectDir(project.id), report.artifact);
    assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative));
    const response = await fetch(`${appUrl}/api/projects/${project.id}/files/${relative.split(path.sep).map(encodeURIComponent).join('/')}`);
    assert.equal(response.status, 200, 'Native report can be reopened from the workspace');
    assert.equal(sha256(Buffer.from(await response.arrayBuffer())), report.sha256);
    reports.push({url: report.requestedUrl, version: report.version, fetchTime: report.fetchTime, artifact: report.artifact, sha256: report.sha256, categories: report.categories, metaDescription: description.score});
  }
  const appPage = audit.pages.find(item => new URL(item.url).pathname === '/app');
  assert.equal(appPage.rawMetadata.title, 'Loading Field Notes workspace');
  assert.equal(appPage.renderedMetadata.title, 'Field Notes workspace — ready');
  assert.deepEqual(appPage.rawMetadata.description, []);
  assert.equal(appPage.renderedMetadata.description.length, 1);
  assert.equal(appPage.evidenceMode, 'RENDERED_DOM');
  assert.notEqual(appPage.rawSha256, appPage.renderedSha256);
  const snapshot = {runId: audit.runId, status: audit.status, labStatus: audit.lab.status, expectedRoutes: audit.lab.expectedRoutes, observedRoutes: audit.lab.observedRoutes, reports, runWarnings: audit.lab.runWarnings, requests: target.requestCounts()};
  await writeFile(path.join(runRoot, `${phase}-evidence.json`), JSON.stringify(snapshot, null, 2));
  return snapshot;
}

try {
  await page.goto(appUrl);
  await screenshot('01-home.png');
  await page.locator('#new-project').click();
  await page.getByLabel('Start without an audit', {exact: false}).uncheck();
  await page.getByLabel('Project name', {exact: true}).fill('Field Notes');
  await page.getByLabel('Product URL · required for audit', {exact: true}).fill(target.origin);
  await page.getByLabel('I own or trust this site and approve this bounded browser audit', {exact: true}).check();
  await page.getByText('Have the source or brand assets?').click();
  await page.getByLabel('Source checkout path', {exact: false}).fill(target.sourceDir);
  await page.getByLabel('Capture JavaScript-rendered content', {exact: true}).check();
  await page.getByLabel('Readiness selector', {exact: false}).fill('html[data-ready="true"]');
  console.log('Running the first bounded three-route Unlighthouse audit through the browser.');
  let project = await operation('audit', () => page.getByRole('button', {name: 'Create workspace'}).click());
  const before = await nativeEvidence(project, 'before');
  assert.equal(before.reports.find(report => new URL(report.url).pathname === '/').metaDescription, 0);
  assert.equal(target.requests.includes('/admin'), false);
  assert.equal(target.requests.includes('/overflow'), false);
  await screenshot('02-overview.png');
  await page.getByRole('button', {name: 'Evidence', exact: true}).click();
  await page.getByRole('heading', {name: 'Lighthouse lab evidence', exact: true}).waitFor();
  await page.getByText('Inspect evidence', {exact: true}).first().click();
  await screenshot('03-evidence-before.png');
  assert.equal(project.audit.status, 'PARTIAL');
  assert(project.audit.coverage.omitted.some(url=>new URL(url).pathname==='/overflow'));

  await page.getByRole('button', {name: 'Content', exact: true}).click();
  assert.match(await page.getByLabel('Article Markdown').inputValue(), /Source/);
  await screenshot('03-content.png');
  const intake=JSON.parse(await readFile(new URL('../src/content/examples/intake.json',import.meta.url)));
  const contentFolder=path.join(runRoot,'editable-content');
  await createContentProject(contentFolder,project.audit,intake);
  const ledger=JSON.parse(await readFile(path.join(contentFolder,'ledger.json')));
  assert.equal(ledger.facts.find(f=>f.id==='fake-price').status,'UNVERIFIED');
  assert(!(await readFile(path.join(contentFolder,'article.md'),'utf8')).includes('Plans cost $9'));
  await openContentProject(contentFolder);
  await page.getByLabel('Article Markdown').fill(`# Field Notes\n\nA calmer place for project notes.\n\n[Source](${target.origin}/)`);
  await operation('article', () => page.getByRole('button', {name: 'Save article', exact: true}).click());
  await page.getByRole('button', {name: 'Source proposal', exact: true}).click();
  await page.getByLabel('Title', {exact: true}).fill('Field Notes — A calmer workspace');
  await page.getByLabel('Meta description', {exact: true}).fill('Field Notes brings project notes, decisions and next steps into one clear workspace.');
  await page.getByLabel('Canonical URL', {exact: true}).fill(`${target.origin}/`);
  project = await operation('propose-patch', () => page.getByRole('button', {name: 'Create candidate diff'}).click());
  assert.match(project.patch.diff, /meta name="description"/);
  assert.equal(project.patch.evidenceBinding.basis,'EXACT_AUDIT_BYTES_MATCH');
  await page.getByText('Review the exact change', {exact: true}).waitFor();
  await screenshot('04-patch.png');
  assert.equal(await page.getByRole('button', {name: 'Apply this exact patch'}).count(), 0);
  const sourceBefore = await readFile(path.join(target.sourceDir, 'index.html'), 'utf8');
  page.once('dialog', dialog => dialog.accept());
  project = await operation('prepare-patch-handoff', () => page.getByRole('button', {name: 'Prepare reviewed handoff'}).click());
  assert.equal(project.patchHandoff.status, 'HANDOFF_READY');
  assert.equal(project.patchHandoff.sourceVerification, 'NOT_RUN');
  assert.equal(await readFile(path.join(target.sourceDir, 'index.html'), 'utf8'), sourceBefore);
  assert.match(await page.getByLabel('Implementation handoff').inputValue(), /Run Build verification afterward/);
  const artifact = await fetch(appUrl + await page.getByRole('link', {name: 'Download exact proposal'}).getAttribute('href')).then(r => r.json());
  assert.deepEqual(artifact, project.patch);
  const denied = await fetch(`${appUrl}/api/projects/${project.id}/apply-patch`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({approvedHash:project.patch.hash})});
  assert.equal(denied.status, 410);
  assert.equal(await readFile(path.join(target.sourceDir, 'index.html'), 'utf8'), sourceBefore);
  await screenshot('04-handoff.png');
  await page.reload();
  await page.getByRole('button', {name: 'Source proposal', exact: true}).click();
  assert.match(await page.getByLabel('Implementation handoff').inputValue(), /Do not deploy or publish/);
  // Test-owned external coding step. No Grow code writes the selected product source.
  await writeFile(path.join(target.sourceDir, 'index.html'), project.patch.after);
  await page.reload();
  await page.getByRole('button', {name: 'Source proposal', exact: true}).click();
  assert.equal(await page.getByLabel('Implementation handoff').count(), 0);
  await page.getByText('Source or base commit changed; generate and review a fresh proposal.', {exact:true}).waitFor();
  console.log('GROW_CAN_DIRECTLY_MUTATE_PRODUCT_SOURCE = NO. Re-auditing an external source change.');
  project = await operation('audit', () => page.getByRole('button', {name: 'Recheck audited site', exact: true}).click());
  const after = await nativeEvidence(project, 'after');
  assert.notEqual(after.runId, before.runId);
  assert.equal(after.reports.find(report => new URL(report.url).pathname === '/').metaDescription, 1);
  assert.equal(project.audit.recheck.status, 'COMPARED');
  assert.equal(project.audit.recheck.baselineRunId, before.runId);
  assert.equal(project.audit.recheck.currentRunId, after.runId);
  const resolved = project.audit.recheck.changes.find(change => new URL(change.url).pathname === '/' && change.id === 'meta-description');
  assert.deepEqual({before: resolved?.before, after: resolved?.after, outcome: resolved?.outcome}, {before: 0, after: 1, outcome: 'RESOLVED'});
  assert.equal(target.requests.includes('/admin'), false, 'Robots-disallowed page was never requested');
  assert.equal(target.requests.includes('/overflow'), false, 'Fourth permitted page was never requested');
  await page.getByRole('button', {name: 'Evidence', exact: true}).click();
  await screenshot('05-evidence-after.png');
  assert.match(project.article, /A calmer place for project notes/, 'Recheck preserves the edited article');

  await page.getByRole('button', {name: 'Campaign', exact: true}).click();
  await page.getByLabel('Local brand image', {exact: false}).fill(path.join(runRoot,'02-overview.png'));
  await page.getByLabel('Brand name', {exact: true}).fill('Field Notes');
  await page.getByLabel('Product summary', {exact: true}).fill('Project notes, decisions and next steps. Together at last.');
  await page.getByLabel('Headline', {exact: true}).fill('Make room for your best ideas.');
  await page.getByLabel('Body copy', {exact: true}).fill('Project notes, decisions and next steps. Together at last.');
  await page.getByLabel('Call to action', {exact: true}).fill('Explore Field Notes');
  await page.getByLabel('I reviewed these product claims', {exact: false}).check();
  await operation('campaign', () => page.getByRole('button', {name: 'Save reviewed creative brief'}).click());
  project = await operation('render', () => page.getByRole('button', {name: 'Render assets'}).click());
  await page.locator('.asset-grid video').waitFor();
  assert.equal(await page.locator('.asset-grid img').count(), 9);
  await page.locator('.asset-grid img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
  assert.ok(await page.locator('.asset-grid img').evaluateAll(images => images.every(image => image.naturalWidth > 0)));
  await screenshot('06-creative.png');
  assert.deepEqual(await page.locator('.concept-card h3').allTextContents(), ['Spotlight', 'Editorial', 'Signal']);
  assert.match(await page.locator('.creative-toolbar').innerText(), /3 rendered directions · 9 static images · 8s motion/);
  const video = page.locator('video');
  await video.evaluate(async element => { await element.play(); });
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.5);
  assert.equal(await video.evaluate(element => element.error), null);
  await video.evaluate(element => element.pause());
  await video.screenshot({path: path.join(runRoot, '07-motion-frame.png')});
  const motion = await video.evaluate(element => ({currentTime: element.currentTime, duration: element.duration, width: element.videoWidth, height: element.videoHeight, readyState: element.readyState}));
  assert.ok(motion.duration === 8 && motion.width > 0 && motion.height > 0);

  await page.getByRole('button', {name: 'Export queue', exact: true}).click();
  project = await operation('export', () => page.getByRole('button', {name: 'Build export bundle'}).click());
  await page.getByText('EXPORTED', {exact: true}).waitFor();
  await page.getByText('NOT PUBLISHED', {exact: true}).waitFor();
  assert.equal(await page.getByText('PUBLISHED', {exact: true}).count(), 0);
  await screenshot('08-export.png');
  assert.equal(project.exports[0].status, 'EXPORTED');
  assert.equal(project.exports[0].publishedAt, null);
  for (const file of project.render.files) {
    const response = await fetch(`${appUrl}/api/projects/${project.id}/files/${file.relativePath}`);
    assert.equal(response.status, 200);
  }
  assert.equal((await verifyExport(project.exports[0].directory,project.exports[0].integritySha256)).valid,true);
  const queue=await readDeliveryQueue(app.store.projectDir(project.id),{verify:true});
  assert.equal(queue.items[0].integrity,'VALID');
  assert.deepEqual(queue.items[0].history.map(h=>h.status),['DRAFT','READY','EXPORTED']);
  await extractBundle(project.exports[0].bundlePath,path.join(runRoot,'unpacked-export'));
  // Actually stop and recreate the server on the same origin, then reopen through the UI.
  const restartPort=app.server.address().port;
  app.server.closeAllConnections(); await new Promise(resolve=>app.server.close(resolve));
  app=createApp({dataDir:path.join(runRoot,'data'),allowedLocalOrigin:target.origin});
  await new Promise(resolve=>app.server.listen(restartPort,'127.0.0.1',resolve));
  await page.reload();
  await page.getByRole('button', {name: 'Content', exact: true}).click();
  assert.match(await page.getByLabel('Article Markdown').inputValue(), /A calmer place/);
  await page.getByRole('button', {name: 'Export queue', exact: true}).click();
  await page.getByText('EXPORTED', {exact: true}).waitFor();
  await page.getByText('NOT PUBLISHED', {exact: true}).waitFor();
  const reopened = await (await fetch(`${appUrl}/api/projects/${project.id}`)).json();
  assert.equal(reopened.audit.runId, after.runId);
  assert.equal(reopened.exports[0].id, project.exports[0].id);
  assert.equal(reopened.exports[0].publishedAt, null);
  await screenshot('08-export-reopened.png');
  await page.setViewportSize({width: 390, height: 844});
  await page.getByRole('button', {name: 'Overview', exact: true}).click();
  await screenshot('09-mobile.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.ok(await page.locator('.intake-facts dd').evaluateAll(cells => cells.every(cell => cell.scrollWidth <= cell.clientWidth)), 'Intake values fit their own mobile card without overlapping adjacent facts');
  const mobile = [];
  for (const [stage, name] of [['Evidence', 'evidence'], ['Source proposal', 'source'], ['Content', 'content'], ['Campaign', 'creative'], ['Export queue', 'export']]) {
    await page.getByRole('button', {name: stage, exact: true}).click();
    const dimensions = await page.evaluate(() => ({width: innerWidth, documentWidth: document.documentElement.scrollWidth}));
    assert.ok(dimensions.documentWidth <= dimensions.width, `${stage} overflows at 390px: ${JSON.stringify(dimensions)}`);
    if (name === 'creative') await page.locator('.asset-grid img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    await screenshot(`10-mobile-${name}.png`);
    mobile.push({stage, ...dimensions});
  }

  // Entry failure is preflight evidence, not a third expensive browser scan or a mocked success.
  const failed = await post('/api/projects', {name: 'Unavailable site', url: `${target.origin}/unavailable503`, trustedSite: true});
  const failureStarted = Date.now();
  const failure = await post(`/api/projects/${failed.id}/audit`, {});
  assert.notEqual(failure.audit.status, 'COMPLETE');
  assert.equal(failure.audit.lab.reports.length, 0);
  assert.ok(failure.audit.errors.some(error => error.message.includes('503')), JSON.stringify(failure.audit.errors));
  assert.ok(!failure.audit.recheck?.changes?.some(change => change.outcome === 'RESOLVED'));
  assert.equal(target.requests.includes('/admin'), false);
  assert.equal(target.requests.includes('/overflow'), false);
  await page.reload();
  await page.locator(`[data-project="${failed.id}"]`).click();
  await page.getByRole('button', {name: 'Evidence', exact: true}).click();
  await page.getByText('Collection issues', {exact: true}).waitFor();
  assert.match(await page.locator('.status-readout').innerText(), /FAILED/);
  await screenshot('11-mobile-failed-audit.png');
  const tiles=await Promise.all(project.render.files.filter(f=>f.type==='image').map(f=>sharp(f.path).resize(270,480,{fit:'contain',background:'#d8ddcf'}).png().toBuffer()));
  await sharp({create:{width:810,height:1440,channels:3,background:'#d8ddcf'}}).composite(tiles.map((input,i)=>({input,left:i%3*270,top:Math.floor(i/3)*480}))).png().toFile(path.join(runRoot,'static-contact-sheet.png'));
  const exec=promisify(execFile); const times=[0.25,1.2,3.5,5.7,6.5,7.9];
  const movie=project.render.files.find(f=>f.type==='video').path;
  for(const time of times) await exec('ffmpeg',['-v','error','-y','-ss',String(time),'-i',movie,'-frames:v','1','-threads','2',path.join(runRoot,`frame-${time}.png`)]);
  const frames=await Promise.all(times.map(time=>sharp(path.join(runRoot,`frame-${time}.png`)).resize(240,427).png().toBuffer()));
  await sharp({create:{width:1440,height:427,channels:3,background:'#14231c'}}).composite(frames.map((input,i)=>({input,left:i*240,top:0}))).png().toFile(path.join(runRoot,'motion-contact-sheet.png'));
  const result = {
    status: 'PASS', scope: 'synthetic-owned-local-fixture', browser: await browser.version(), node: process.version,
    projectId: project.id, projectDir: app.store.projectDir(project.id), render: project.render, export: project.exports[0].directory,
    sourceOwnership: {growCanDirectlyMutateProductSource: false, retiredApplyStatus: denied.status, unchangedSourceSha256: sha256(sourceBefore), proposalHash: artifact.hash, implementationOwner: 'BUILD_OR_CODING_WORKFLOW', handoff: 'INERT', automaticCodexExecution: false},
    before, after, controlledMetaDescription: {before: 0, after: 1}, recheck: project.audit.recheck,
    routeCountPerAudit: 3, robotsDisallowedRequests: 0, overflowRequests: 0, requestCounts: target.requestCounts(), motion,
    failure: {status: failure.audit.status, labStatus: failure.audit.lab.status, elapsedMs: Date.now() - failureStarted, errors: failure.audit.errors},
    checks: ['trusted-site admission', 'real Unlighthouse CLI', 'three native Lighthouse reports per run', 'native report hashes and download', 'raw/rendered metadata separation', 'robots exclusion', 'route cap', 'source-backed article and FAQ', 'unsupported claims remain UNVERIFIED in editable content project', 'exact export integrity and bundle extraction', 'article editing', 'reviewed inert handoff and exact proposal download', 'GROW_CAN_DIRECTLY_MUTATE_PRODUCT_SOURCE = NO', 'external source change invalidates handoff', 'fresh native meta-description 0→1 recheck', 'edited article preserved', 'nine decoded static images and intact product screenshot', 'eight-second motion playback', 'EXPORTED not PUBLISHED', 'server restart and UI reopen', 'mobile layout', 'honest HTTP 503 preflight failure'],
    consoleErrors: errors, screenshots: runRoot, mobile,
  };
  assert.deepEqual(errors, []);
  await writeFile(path.join(runRoot, 'result.json'), JSON.stringify(result, null, 2));
  await writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({status: result.status, checks: result.checks, projectDir: result.projectDir, screenshots: runRoot, before: before.runId, after: after.runId, controlledMetaDescription: result.controlledMetaDescription, requestCounts: result.requestCounts, consoleErrors: errors}, null, 2));
} catch (error) {
  await screenshot('failure.png');
  await writeFile(path.join(runRoot, 'failure.html'), await page.content());
  await writeFile(path.join(runRoot, 'failure.json'), JSON.stringify({message: error.message, stack: error.stack, consoleErrors: errors, requestCounts: target.requestCounts()}, null, 2));
  throw error;
} finally {
  await browser.close();
  await new Promise(resolve => app.server.close(resolve));
  await target.close();
}
