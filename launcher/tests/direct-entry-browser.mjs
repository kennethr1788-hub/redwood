// Direct-entry smoke only: real owners, disposable data, no generation or provider calls.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {promises as fs} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {DISPLAY_NAMES as names} from '../src/display-names.js';
const root = fileURLToPath(new URL('../../', import.meta.url));
const {chromium, expect} = createRequire(path.join(root, 'products/build/package.json'))('@playwright/test');
const out = process.env.LF_EVIDENCE_DIR || path.join(root, 'launcher/tests/evidence/shell-r1-direct');
await fs.mkdir(out, {recursive: true});
await fs.mkdir(path.join(root, 'launcher/.local'), {recursive: true});
const work = await fs.mkdtemp(path.join(root, 'launcher/.local/direct-'));
const children = []; let browser;
const receipt = {status: 'RUNNING', scope: 'REAL_OWNER_DIRECT_ENTRY_ONLY', checks: [], errors: [], externalRequests: [], providerCalls: 0, processesStopped: false};
async function port() { const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); const value = server.address().port; await new Promise(r => server.close(r)); return value; }
const ports = Object.fromEntries(await Promise.all(['launcher','build','studio','grow'].map(async id => [id, await port()])));
const targets = Object.fromEntries(Object.entries(ports).map(([id, port]) => [id, 'http://127.0.0.1:' + port]));
const env = {...process.env, LF_LAUNCHER_PORT: String(ports.launcher), LF_BUILD_PORT: String(ports.build), LF_STUDIO_PORT: String(ports.studio), LF_GROW_PORT: String(ports.grow), LF_PORT: String(ports.build), LF_WORKSPACE: path.join(work,'build'), STUDIO_PORT: String(ports.studio), STUDIO_PROJECTS_DIR: path.join(work,'studio'), PORT: String(ports.grow), GROW_DATA_DIR: path.join(work,'grow'), LF_CONNECTIONS_DIR: path.join(work,'connections')};
async function start(id) {
  const cwd = path.join(root, id === 'launcher' ? 'launcher' : 'products/' + id);
  const args = id === 'build' ? ['--import','tsx','src/backend/server.ts'] : [id === 'launcher' ? 'server.mjs' : 'src/server.js'];
  const child = spawn(process.execPath, args, {cwd, env, stdio: ['ignore','ignore','pipe']}); children.push(child);
  let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
  for (let i=0;i<100;i++) { if (child.exitCode !== null) throw Error(id + ': ' + stderr); try { if ((await fetch(targets[id], {signal: AbortSignal.timeout(500)})).ok) return; } catch {} await new Promise(r=>setTimeout(r,100)); }
  throw Error(id + ' start timeout: ' + stderr);
}
try {
  for (const id of ['build','studio','grow','launcher']) await start(id);
  browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  await context.route('**/*', async route => { const origin = new URL(route.request().url()).origin; if (!Object.values(targets).includes(origin)) {receipt.externalRequests.push(origin); await route.abort();} else await route.continue(); });
  context.on('page', page => { page.on('pageerror', error => receipt.errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') receipt.errors.push(message.text()); }); });
  const page = await context.newPage(); await page.goto(targets.launcher);
  for (const id of ['build','studio','grow']) {
    await page.locator('nav a[href="#' + id + '"]').click();
    const [owner] = await Promise.all([context.waitForEvent('page'), page.locator('#' + id + ' .address a').click()]);
    await owner.waitForLoadState('networkidle');
    assert.equal(new URL(owner.url()).origin, targets[id]);
    await expect(owner).toHaveTitle(new RegExp(names.umbrella + ' ' + names[id]));
    await expect(owner.locator('body')).toContainText(new RegExp(names[id], 'i'));
    assert.doesNotMatch(await owner.locator('body').innerText(), /\b(?:LaunchForge|Forge|Studio)\b/);
    assert.ok((await owner.locator('button,input,a').count()) > 0);
    await owner.screenshot({path: path.join(out, id + '-direct.png'), fullPage: true});
    await owner.setViewportSize({width:390,height:844});
    await expect(owner).toHaveTitle(new RegExp(names.umbrella + ' ' + names[id]));
    assert.ok(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), id + ' must fit 390px');
    await owner.screenshot({path:path.join(out,id+'-direct-mobile.png'),fullPage:true});
    await expect(page.locator('#' + id)).toBeVisible();
    await owner.close();
    receipt.checks.push(id + ': real direct owner opens in separate tab; shell remains on selected product');
  }
  await page.goto(targets.launcher + '/#home');
  await page.screenshot({path: path.join(out, 'home-desktop.png'), fullPage: true});
  assert.deepEqual(receipt.errors, []); assert.deepEqual(receipt.externalRequests, []); receipt.status = 'PASS';
} finally {
  await browser?.close();
  for (const child of children.reverse()) if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => { const timer = setTimeout(()=>child.kill('SIGKILL'),3000); child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM'); });
  receipt.processesStopped = children.every(c => c.exitCode !== null || c.signalCode !== null);
  await fs.writeFile(path.join(out, 'direct-entry.json'), JSON.stringify(receipt,null,2)+'\n');
}
console.log(JSON.stringify(receipt));
