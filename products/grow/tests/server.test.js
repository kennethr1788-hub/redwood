import { DISPLAY_NAMES } from "../../../launcher/src/display-names.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import {inspectHtml} from '../src/audit/index.js';
import {randomUUID} from 'node:crypto';

// API isolation only. The selected engine runs for real in test:e2e.
async function apiFixtureAudit(url) {
 const response=await fetch(url);const body=await response.text();
 return {runId:randomUUID(),engine:'API_TEST_DOUBLE',status:response.ok?'COMPLETE':'FAILED',url,createdAt:new Date().toISOString(),pages:response.ok?[inspectHtml(body,url,response.status)]:[],findings:[],resources:{},limits:{},errors:response.ok?[]:[{url,message:`Page returned HTTP ${response.status}`}],lab:{reports:[]},artifacts:[]};
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'grow-server-'));
  const site = http.createServer((req, res) => {
    if (req.url === '/robots.txt' || req.url === '/sitemap.xml') { res.writeHead(404); res.end('Not found'); return; }
    if (req.url === '/broken') { res.writeHead(503); res.end('Source unavailable'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><title>Fieldnote</title><meta name="description" content="Capture field observations in a team notebook."></head><body><h1>Fieldnote team notes</h1><p>Share field observations with your team.</p></body></html>');
  });
  const siteOrigin = await listen(site);
  const dataDir = path.join(root, 'projects');
  const app = createApp({ dataDir, allowedLocalOrigin: siteOrigin, auditRunner:apiFixtureAudit });
  const origin = await listen(app.server);
  const request = async (route, input) => {
    const response = await fetch(`${origin}${route}`, input === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({...input, trustedSite:true}),
    });
    return { status: response.status, body: await response.json() };
  };
  try { await run({ root, siteOrigin, dataDir, app, origin, request }); }
  finally { await close(app.server); await close(site); await rm(root, { recursive: true, force: true }); }
}

test('API creates, audits, edits, rejects premature export, and reopens persisted project', async () => {
  await fixture(async ({ request, siteOrigin, dataDir, app }) => {
    const created = await request('/api/projects', { name: 'Field campaign', url: siteOrigin });
    assert.equal(created.status, 201);
    const route = `/api/projects/${created.body.id}`;
    const audited = await request(`${route}/audit`, {});
    assert.equal(audited.status, 200);
    assert.equal(audited.body.audit.status, 'COMPLETE');
    assert.equal(audited.body.audit.pages[0].title, 'Fieldnote');
    assert(audited.body.content.suggestions.length > 0);
    assert(audited.body.content.faq[0].sourceUrl.startsWith(siteOrigin));
    assert.match(audited.body.article, /source-backed overview/);
    assert.equal(audited.body.campaign.confirmed, false);

    const markdown = '# Reviewed Fieldnote article\n\nOur editor verified this copy.\n';
    const edited = await request(`${route}/article`, { markdown });
    assert.equal(edited.body.article, markdown);
    const campaign = await request(`${route}/campaign`, { headline: 'Your field notes, together', color: '#123456', confirmed: true });
    assert.equal(campaign.body.campaign.headline, 'Your field notes, together');
    assert.equal(campaign.body.campaign.confirmed, true);
    const invalid = await request(`${route}/campaign`, { color: 'red', confirmed: true });
    assert.equal(invalid.status, 400);
    const exportFailure = await request(`${route}/export`, { scheduledAt: '2026-10-04T12:00:00Z' });
    assert.equal(exportFailure.status, 400);
    assert.match(exportFailure.body.error, /Render the reviewed campaign first/);
    const afterFailure = await request(route);
    assert.equal(afterFailure.body.campaign.color, '#123456');
    assert.equal(afterFailure.body.exports.length, 0);
    assert.equal(await readFile(path.join(app.store.projectDir(created.body.id), 'content', 'article.md'), 'utf8'), markdown);

    const reopened = createApp({ dataDir, allowedLocalOrigin: siteOrigin, auditRunner:apiFixtureAudit });
    const secondOrigin = await listen(reopened.server);
    try {
      const restored = await (await fetch(`${secondOrigin}${route}`)).json();
      assert.equal(restored.article, markdown);
      assert.equal(restored.campaign.headline, 'Your field notes, together');
      assert.equal(restored.audit.status, 'COMPLETE');
      const listing = await (await fetch(`${secondOrigin}/api/projects`)).json();
      assert.equal(listing[0].id, created.body.id);
    } finally { await close(reopened.server); }
  });
});

test('API re-audit preserves edited article and confirmed campaign', async () => {
  await fixture(async ({ request, siteOrigin }) => {
    const created = await request('/api/projects', { name: 'Preserve edits', url: siteOrigin });
    const route = `/api/projects/${created.body.id}`;
    await request(`${route}/audit`, {});
    const markdown = '# Author-owned article\n\nDo not overwrite this on recheck.';
    await request(`${route}/article`, { markdown });
    const edited = await request(`${route}/campaign`, { brandName: 'Reviewed Fieldnote', headline: 'Editorial headline', color: '#abcdef', confirmed: true });
    const rechecked = await request(`${route}/audit`, {});
    assert.equal(rechecked.status, 200);
    assert.deepEqual({ article: rechecked.body.article, campaign: rechecked.body.campaign }, { article: markdown, campaign: edited.body.campaign });
  });
});

test('API records failed crawl and source proposal failure without claiming success', async () => {
  await fixture(async ({ request, siteOrigin, root }) => {
    const broken = await request('/api/projects', { name: 'Unavailable site', url: `${siteOrigin}/broken` });
    const route = `/api/projects/${broken.body.id}`;
    const audited = await request(`${route}/audit`, {});
    assert.equal(audited.status, 200);
    assert.equal(audited.body.audit.status, 'FAILED');
    assert.equal(audited.body.audit.pages.length, 0);
    assert.match(audited.body.audit.errors[0].message, /503/);
    assert.equal(audited.body.article, '');
    assert.equal(audited.body.campaign, null);
    assert.equal((await request(route)).body.audit.status, 'FAILED');

    const sourceDir = path.join(root, 'unsupported-source');
    await mkdir(sourceDir);
    const sourceProject = await request('/api/projects', { name: 'Unsupported source', url: siteOrigin, sourceDir });
    const sourceRoute = `/api/projects/${sourceProject.body.id}`;
    await request(`${sourceRoute}/audit`, {});
    const proposed = await request(`${sourceRoute}/propose-patch`, { title: 'Fieldnote', description: 'Reviewed description', canonical: siteOrigin });
    assert.equal(proposed.status, 400);
    assert.match(proposed.body.error, /static index.html/);
    const unchanged = await request(sourceRoute);
    assert.equal(unchanged.body.patch, null);
    assert.equal(unchanged.body.audit.status, 'COMPLETE');
    assert(unchanged.body.article.length > 0);
  });
});

test('API rejects a foreign-origin mutation', async () => {
  await fixture(async ({ origin, siteOrigin, request }) => {
    const response = await fetch(`${origin}/api/projects`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' },
      body: JSON.stringify({ name: 'No mutation', url: siteOrigin }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual((await request('/api/projects')).body, []);
  });
});

test('saved legacy project requires explicit trusted-site confirmation before browser audit', async () => {
  await fixture(async ({origin,siteOrigin,request}) => {
    const created=await fetch(`${origin}/api/projects`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Unconfirmed',url:siteOrigin})}).then(r=>r.json());
    const route=`/api/projects/${created.id}`;
    const denied=await fetch(`${origin}${route}/audit`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(denied.status,400);
    assert.match((await denied.json()).error,/own or trust/);
    assert.equal((await request(route)).body.audit,null);
  });
});

test('GROW_CAN_DIRECTLY_MUTATE_PRODUCT_SOURCE = NO: API refuses apply and preserves historical receipts', async () => {
  await fixture(async ({ request, siteOrigin, root, app }) => {
    const sourceDir = path.join(root, 'static-source');
    await mkdir(sourceDir);
    const html = '<!doctype html><html><head><title>Old title</title></head><body><h1>Product</h1></body></html>';
    const file = path.join(sourceDir, 'index.html');
    await writeFile(file, html);
    const created = await request('/api/projects', { name: 'Static source', url: siteOrigin, sourceDir });
    const route = `/api/projects/${created.body.id}`;
    const legacy = {status:'APPLIED_RECHECKED', sourceHash:'historical', deployedVerification:'NOT_RUN'};
    const saved = await app.store.get(created.body.id); saved.patchResult = legacy; await app.store.save(saved);
    await request(`${route}/audit`, {});
    const input = { title: 'Reviewed first title', description: 'Reviewed source description', canonical: siteOrigin };
    const proposed = await request(`${route}/propose-patch`, input);
    assert.equal(proposed.status, 200);
    for (const body of [{}, {approvedHash: proposed.body.patch.hash}]) {
      const denied = await request(`${route}/apply-patch`, body);
      assert.equal(denied.status, 410);
      assert.match(denied.body.error, /Build or your coding tool/);
    }
    assert.equal((await request(`${route}/prepare-patch-handoff`, {})).status, 400);
    const handoff = await request(`${route}/prepare-patch-handoff`, {approvedHash: proposed.body.patch.hash});
    assert.equal(handoff.status, 200);
    assert.equal(handoff.body.patchHandoff.status, 'HANDOFF_READY');
    assert.equal(handoff.body.patchHandoff.sourceWrite, 'NONE');
    assert.equal(await readFile(file, 'utf8'), html);
    assert.deepEqual(handoff.body.patchResult, legacy);
    assert.equal((await request(route)).body.patchHandoff.status, 'HANDOFF_READY');
    await writeFile(file, html + '<!-- user change -->');
    const persisted = await readFile(path.join(app.store.projectDir(created.body.id), 'grow.project.json'));
    const stale = await request(route);
    assert.equal(stale.body.patchHandoff.status, 'STALE');
    assert.equal(stale.body.patchHandoff.prompt, null);
    assert.deepEqual(await readFile(path.join(app.store.projectDir(created.body.id), 'grow.project.json')), persisted);
    assert.equal((await request(`${route}/audit`, {})).body.patchHandoff.status, 'STALE', 'A fresh audit must not resurface an obsolete handoff');
    assert.equal((await request(`${route}/prepare-patch-handoff`, {approvedHash: proposed.body.patch.hash})).status, 400);
    const second = await request(`${route}/propose-patch`, input);
    assert.equal(second.status, 200);
    assert.notEqual(second.body.patch.hash, proposed.body.patch.hash);
    assert.equal(second.body.patchHandoff, null);
    assert.deepEqual(second.body.patchResult, legacy);
    assert.equal((await request(`${route}/prepare-patch-handoff`, {approvedHash: proposed.body.patch.hash})).status, 400);
    assert.equal(await readFile(file, 'utf8'), html + '<!-- user change -->');
  });
});

test('Advisor projection is fresh and read-only even when product inputs would need invalidation', async () => {
  await fixture(async ({request, app}) => {
    const created=await request('/api/projects',{name:'Read-only help',planOnly:true});
    const id=created.body.id, file=path.join(app.store.projectDir(id),'grow.project.json');
    const p=JSON.parse(await readFile(file,'utf8'));
    p.productPack={notice:'Private fixture text must not leave the owner'};
    p.exports=[{id:'old-export',stale:true}];
    await writeFile(file,JSON.stringify(p));
    const before=await readFile(file);
    const response=await request(`/api/projects/${id}/advisor-context`);
    assert.equal(response.status,200);assert.equal(response.body.completionState,'STALE');
    assert.deepEqual(Object.keys(response.body).sort(),['completionState','freshness','product','projectId','revision']);
    assert.deepEqual(await readFile(file),before);
    p.exports=[];await writeFile(file,JSON.stringify(p));const next=await readFile(file);
    assert.equal((await request(`/api/projects/${id}/advisor-context`)).body.completionState,'UNKNOWN');
    assert.deepEqual(await readFile(file),next);
  });
});

test('direct browser shell uses current display labels while saved user names remain literal', async () => {
  await fixture(async ({ request, origin }) => {
    const shell = await (await fetch(origin)).text();
    assert.ok(shell.includes(`<title>${DISPLAY_NAMES.umbrella} ${DISPLAY_NAMES.grow} —`));
    assert.ok(shell.includes(`aria-label="${DISPLAY_NAMES.umbrella} ${DISPLAY_NAMES.grow} home"`));
    assert.ok(shell.includes('Growth plan'));
    assert.ok(!shell.includes('%LABEL_'));
    const name = 'LaunchForge Studio %LABEL_UMBRELLA%';
    const created = await request('/api/projects', { name, planOnly:true });
    assert.equal(created.status, 201);
    assert.equal(created.body.name, name);
    const reopened = await request(`/api/projects/${created.body.id}`);
    assert.equal(reopened.body.name, name);
  });
});
