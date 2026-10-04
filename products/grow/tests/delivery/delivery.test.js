import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { defaultCampaign } from '../../src/creative/index.js';
import { renderCampaign } from '../../src/render/index.js';
import { exportCampaign, readDeliveryQueue, verifyExport, extractBundle, verifyBundle } from '../../src/delivery/index.js';
import { createApp } from '../../src/server.js';
import { hash } from '../../src/export/index.js';

const exec = promisify(execFile);
let fixtureRoot, render;
const campaign = { ...defaultCampaign({ url: 'https://example.com/', pages: [{ title: 'Field Notes', description: 'Keep your field observations together.', h1: ['Take your ideas outside'] }] }), confirmed: true };
before(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'grow-delivery-fixture-'));
  render = await renderCampaign(campaign, join(fixtureRoot, 'render'));
});
after(async () => { await rm(fixtureRoot, { recursive: true, force: true }); });
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'grow-delivery-'));
  await cp(render.outputDir, join(root, 'render'), { recursive: true });
  const localRender = { ...render, outputDir: join(root, 'render') };
  try { await run(root, localRender); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const request = render => ({ campaign, render, content: '# Reviewed article\n\nReady to use.', scheduledAt: '2026-10-04T09:30:00-07:00' });

test('complete platform bundle has paired media/copy, UTC calendar, manifests and anchored hashes', async () => fixture(async (root, render) => {
  const result = await exportCampaign(request(render), root);
  assert.equal(result.status, 'EXPORTED');
  assert.equal(result.files[0].name, 'bundle.json');
  assert.equal(result.publishedAt, null);
  assert.equal(result.scheduledAt, '2026-10-04T16:30:00.000Z');
  assert.equal(result.platformBundles.length, 7);
  for (const post of result.platformBundles) {
    assert.equal(post.status, 'EXPORTED');
    assert.equal(post.publishedAt, null);
    assert((await readFile(join(result.directory, post.captionPath), 'utf8')).includes(post.headline));
    assert((await readFile(join(result.directory, post.assets[0]))).length > 1000);
  }
  for (const name of ['calendar.csv', 'calendar.json', 'copy.md', 'copy.json', 'article.md', 'campaign-manifest.json', 'manifest.json', 'integrity.json', 'bundle.json']) assert(result.files.some(f => f.name === name));
  const calendar = JSON.parse(await readFile(result.calendarPath.replace('.csv', '.json')));
  assert.equal(calendar.scheduling, 'PLANNING_ONLY');
  assert.equal(calendar.items.length, 7);
  assert.equal((await verifyExport(result.directory, result.integritySha256)).valid, true);
  const manifest = JSON.parse(await readFile(result.manifestPath));
  for (const entry of manifest.files) assert.equal(hash(await readFile(join(result.directory, entry.path))), entry.sha256);
  const queue = await readDeliveryQueue(root, { verify: true });
  assert.equal(queue.items[0].integrity, 'VALID');
  assert.deepEqual(queue.items[0].history.map(h => h.status), ['DRAFT', 'READY', 'EXPORTED']);
  assert.equal(queue.items[0].bundleSha256, hash(await readFile(result.bundlePath)));
}));

test('single-file download extracts exact original bytes offline and refuses overwrite', async () => fixture(async (root, render) => {
  const result = await exportCampaign(request(render), root);
  const target = join(root, 'unpacked');
  assert.equal((await extractBundle(result.bundlePath, target)).valid, true);
  for (const file of result.files) assert.deepEqual(await readFile(file.path), await readFile(join(target, file.name)));
  await assert.rejects(extractBundle(result.bundlePath, target), /EEXIST/);
  const { stdout } = await exec(process.execPath, ['src/export/index.js', 'verify', target]);
  assert.equal(JSON.parse(stdout).valid, true);
}));

test('queue survives a fresh process and concurrent exports do not drop entries', async () => fixture(async (root, render) => {
  const results = await Promise.all([exportCampaign(request(render), root), exportCampaign(request(render), root), exportCampaign(request(render), root)]);
  assert.equal(new Set(results.map(r => r.id)).size, 3);
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', 'import {readDeliveryQueue} from "./src/delivery/index.js"; console.log(JSON.stringify(await readDeliveryQueue(process.argv[1], {verify:true})));', root]);
  const reopened = JSON.parse(stdout);
  assert.equal(reopened.items.length, 3);
  assert(reopened.items.every(item => item.status === 'EXPORTED' && item.integrity === 'VALID' && item.publishedAt === null));
}));

test('failure persists honestly, preserves earlier exports and leaves no partial export folder', async () => fixture(async (root, render) => {
  const first = await exportCampaign(request(render), root);
  await writeFile(join(render.outputDir, render.files[0].name), 'tampered');
  await assert.rejects(exportCampaign(request(render), root), error => error.deliveryStatus === 'FAILED' && /changed/.test(error.message));
  const queue = await readDeliveryQueue(root, { verify: true });
  assert.equal(queue.items.find(i => i.id === first.id).status, 'EXPORTED');
  const failed = queue.items.find(i => i.status === 'FAILED');
  assert.equal(failed.publishedAt, null);
  assert.equal(failed.exportedAt, null);
  assert.match(failed.error, /changed/);
  const folders = await readdir(join(root, 'exports'));
  assert(!folders.some(name => name.startsWith('.building-')));
  assert(!folders.includes(failed.id));
}));

test('independent exporting processes preserve all authoritative queue records', async () => fixture(async (root, render) => {
  await writeFile(join(root, 'input.json'), JSON.stringify(request(render)));
  const script = 'import {readFile} from "node:fs/promises"; import {exportCampaign} from "./src/delivery/index.js"; const root=process.argv[1]; console.log((await exportCampaign(JSON.parse(await readFile(root+"/input.json")),root)).id);';
  const outcomes = await Promise.all([exec(process.execPath, ['--input-type=module', '-e', script, root]), exec(process.execPath, ['--input-type=module', '-e', script, root])]);
  assert.notEqual(outcomes[0].stdout, outcomes[1].stdout);
  const queue = await readDeliveryQueue(root, { verify: true });
  assert.equal(queue.items.length, 2);
  assert(queue.items.every(i => i.status === 'EXPORTED' && i.integrity === 'VALID'));
}));

test('editing copy after rendering fails instead of delivering mismatched media', async () => fixture(async (root, render) => {
  await assert.rejects(exportCampaign({ ...request(render), campaign: { ...campaign, headline: 'New headline' } }, root), /changed since rendering/);
  assert.equal((await readDeliveryQueue(root)).items[0].status, 'FAILED');
}));

test('tampering with copy, media, inventory or bundle is detected on reopen', async () => fixture(async (root, render) => {
  const result = await exportCampaign(request(render), root);
  for (const name of ['copy.md', 'assets/campaign-1-square.png', 'integrity.json', 'bundle.json']) {
    const file = join(result.directory, name);
    const original = await readFile(file);
    await writeFile(file, Buffer.concat([original, Buffer.from('changed')]));
    await assert.rejects(verifyExport(result.directory, result.integritySha256));
    const reopened = await readDeliveryQueue(root, { verify: true });
    assert.equal(reopened.items[0].status, 'FAILED');
    assert.equal(reopened.items[0].publishedAt, null);
    await writeFile(file, original);
  }
  assert.equal((await readDeliveryQueue(root, { verify: true })).items[0].status, 'EXPORTED');
}));

test('bundle rejects traversal, duplicate paths, corrupt base64 and missing inventory before extraction', async () => fixture(async (root, render) => {
  const result = await exportCampaign(request(render), root);
  const valid = JSON.parse(await readFile(result.bundlePath));
  for (const change of [
    bundle => { bundle.files[0].path = '../escape.txt'; },
    bundle => { bundle.files.push(bundle.files[0]); },
    bundle => { bundle.files[0].data += '!'; },
    bundle => { bundle.files = bundle.files.filter(f => f.path !== 'integrity.json'); },
  ]) {
    const bundle = structuredClone(valid); change(bundle);
    assert.throws(() => verifyBundle(bundle));
    const input = join(root, 'invalid.json'); await writeFile(input, JSON.stringify(bundle));
    await assert.rejects(extractBundle(input, join(root, 'no-output')));
    assert(!(await readdir(root)).includes('no-output'));
  }
}));

test('missing variant media, symlink escape and ambiguous time fail closed', async () => fixture(async (root, render) => {
  await assert.rejects(exportCampaign({ ...request(render), render: { ...render, files: render.files.filter(f => f.name !== 'campaign-2-square.png') } }, root), /Missing 1080x1080/);
  await assert.rejects(exportCampaign({ ...request(render), scheduledAt: '2026-10-04T09:30' }, root), /timezone/);
  await assert.rejects(exportCampaign({ ...request(render), scheduledAt: '2026-02-30T09:30:00Z' }, root), /invalid date/);
  const source = join(render.outputDir, render.files[0].name);
  await rm(source);
  await symlink(join(fixtureRoot, 'render', render.files[0].name), source);
  await assert.rejects(exportCampaign(request(render), root), /inside the project/);
  assert((await readDeliveryQueue(root)).items.every(i => i.status === 'FAILED'));
}));

test('packaging failure after READY persists FAILED and an unscheduled retry stays export-only', async () => fixture(async (root, render) => {
  await assert.rejects(exportCampaign({ ...request(render), content: { markdown: 42 } }, root), /Markdown text/);
  const queue = await readDeliveryQueue(root);
  assert.equal(queue.items[0].status, 'FAILED');
  assert.deepEqual(queue.items[0].history.map(h => h.status), ['DRAFT', 'READY', 'FAILED']);
  const retry = await exportCampaign({ campaign, render }, root);
  assert.equal(retry.status, 'EXPORTED');
  assert.equal(retry.scheduledAt, null);
  assert.equal(retry.publishedAt, null);
  assert((await readDeliveryQueue(root)).items.some(i => i.status === 'FAILED'));
}));

test('legacy queue migrates without loss; malformed records are never overwritten or published', async () => fixture(async (root, render) => {
  await mkdir(join(root, 'exports'));
  const legacy = { id: 'export-00000000-0000-0000-0000-000000000000', status: 'EXPORTED', publishedAt: null, exportedAt: '2026-10-01T00:00:00Z' };
  await writeFile(join(root, 'exports', 'queue.json'), JSON.stringify({ version: 1, items: [legacy] }));
  await exportCampaign(request(render), root);
  assert.equal((await readDeliveryQueue(root)).items.length, 2);
  const file = join(root, 'exports', 'queue', `${legacy.id}.json`);
  const original = await readFile(file, 'utf8');
  const forged = JSON.parse(original); forged.status = 'PUBLISHED'; forged.publishedAt = '2026-10-01T00:00:00Z';
  await writeFile(file, JSON.stringify(forged));
  await assert.rejects(readDeliveryQueue(root), /no publisher/);
  await assert.rejects(exportCampaign(request(render), root), /no publisher/);
  assert.equal(await readFile(file, 'utf8'), JSON.stringify(forged));
}));

test('spreadsheet cells neutralize formulas and preserve quoted multiline article as Markdown', async () => fixture(async (root, render) => {
  const formulaCampaign = structuredClone(campaign);
  formulaCampaign.variants[0].headline = '=1+1';
  const formulaRender = await renderCampaign(formulaCampaign, join(root, 'formula-render'));
  const result = await exportCampaign({ ...request(formulaRender), campaign: formulaCampaign, content: '# Notes\n\n"quoted", commas\nand newlines' }, root);
  assert.match(await readFile(result.calendarPath, 'utf8'), /"'=1\+1"/);
  assert.equal(await readFile(join(result.directory, 'article.md'), 'utf8'), '# Notes\n\n"quoted", commas\nand newlines');
}));

test('existing HTTP export route downloads every file and reopens persisted exports after server restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grow-delivery-http-'));
  let app = createApp({ dataDir: root });
  const listen = async () => { app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening'); return `http://127.0.0.1:${app.server.address().port}`; };
  const close = () => new Promise(resolve => { app.server.closeAllConnections(); app.server.close(resolve); });
  try {
    const project = await app.store.create({ name: 'Campaign', url: campaign.url });
    const dir = app.store.projectDir(project.id);
    await cp(render.outputDir, join(dir, 'render'), { recursive: true });
    Object.assign(project, { campaign, article: '# Saved article', render: { ...render, outputDir: join(dir, 'render') } });
    await app.store.save(project);
    let origin = await listen();
    const route = `/api/projects/${project.id}`;
    const response = await fetch(`${origin}${route}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scheduledAt: '2026-10-04T09:30:00Z' }) });
    assert.equal(response.status, 200);
    const saved = await response.json();
    for (const file of saved.exports[0].files) {
      const download = await fetch(`${origin}${route}/files/${file.relativePath}`);
      assert.equal(download.status, 200, file.relativePath);
      assert.equal(hash(Buffer.from(await download.arrayBuffer())), file.sha256);
    }
    await close();
    app = createApp({ dataDir: root }); origin = await listen();
    const reopened = await (await fetch(`${origin}${route}`)).json();
    assert.equal(reopened.exports[0].status, 'EXPORTED');
    assert.equal(reopened.exports[0].publishedAt, null);
    assert.equal(reopened.exports[0].bundleSha256, saved.exports[0].bundleSha256);
    assert.equal((await readDeliveryQueue(dir, { verify: true })).items[0].integrity, 'VALID');
  } finally { await close(); await rm(root, { recursive: true, force: true }); }
});
