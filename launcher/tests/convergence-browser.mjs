import {sourceIdentity} from '../../scripts/package-source.mjs';
// Real-owner shell/Advisor journey only. No provider, media generation or publication.
// Requires installed locked dependencies and built launcher/Build frontends.
// LF_EVIDENCE_DIR selects a NEW evidence directory; no historical receipt is overwritten.
// On macOS, run with the existing scripts/loopback-only.sb
// sandbox profile to deny backend non-loopback egress as well as browser requests.
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {DISPLAY_NAMES as names} from '../src/display-names.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const {chromium, expect} = createRequire(path.join(root, 'products/build/package.json'))('@playwright/test');
const local = path.join(root, 'launcher/.local');
await fs.mkdir(local, {recursive: true});
const work = await fs.mkdtemp(path.join(local, 'convergence-'));
const out = process.env.LF_EVIDENCE_DIR ? path.resolve(process.env.LF_EVIDENCE_DIR) : path.join(work, 'evidence');
await fs.mkdir(out, {recursive: true});
assert.deepEqual(await fs.readdir(out), [], 'Use an empty evidence directory; historical evidence is immutable.');
const receiptFile = path.join(out, 'convergence-browser.json');
// Exclusive claim avoids overwriting an earlier run even when a caller reuses a path.
await fs.writeFile(receiptFile, '{"status":"STARTING"}\n', {flag: 'wx'});
const children = [];
let browser;
const receipt = {status: 'RUNNING', scope: 'REAL_OWNER_SHELL_ADVISOR_CONVERGENCE',
  sourceCommit: sourceIdentity(root),
  dependencyProvenance: process.env.LF_DEPENDENCY_PROVENANCE || 'Existing local locked dependencies; see lockfile hashes.',
  work, checks: [], browserErrors: [], consoleErrors: [], httpErrors: [], externalRequests: [],
  apiRequests: [], advisorReplies: [], checkpoints: [], providerCalls: 0, nativeCalls: 0,
  processesStopped: false, environmentKeys: [], sourceSha256: {}};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const ports = {};
for (const id of ['launcher', 'build', 'studio', 'grow']) {
  do { ports[id] = await freePort(); } while (Object.entries(ports).some(([other, value]) => other !== id && value === ports[id]));
}
const targets = Object.fromEntries(Object.entries(ports).map(([id, port]) => [id, `http://127.0.0.1:${port}`]));
receipt.targets = targets;
const bin = path.join(work, 'bin'), tmp = path.join(work, 'tmp');
await fs.mkdir(bin); await fs.mkdir(tmp);
await fs.symlink(process.execPath, path.join(bin, 'node'));
// Native-client canaries fail closed if a selected preference is accidentally executed.
const nativeLog = path.join(work, 'native-calls.txt');
await fs.writeFile(nativeLog, '', {flag: 'wx'});
for (const id of ['codex', 'claude']) await fs.writeFile(path.join(bin, id),
  '#!/bin/sh\nprintf "%s\\n" "$0" >> "$LF_NATIVE_CALL_LOG"\nexit 97\n', {mode: 0o700, flag: 'wx'});
// Allowlist only. No inherited keys, endpoint overrides, NODE_OPTIONS or runtime config.
const env = {PATH: `${bin}:/usr/bin:/bin`, TMPDIR: tmp, LANG: 'en_US.UTF-8',
  LF_NATIVE_CALL_LOG: nativeLog,
  LF_CONNECTIONS_DIR: path.join(work, 'connections'),
  LF_LAUNCHER_PORT: String(ports.launcher), LF_BUILD_PORT: String(ports.build),
  LF_STUDIO_PORT: String(ports.studio), LF_GROW_PORT: String(ports.grow),
  LF_PORT: String(ports.build), LF_WORKSPACE: path.join(work, 'build'),
  STUDIO_PORT: String(ports.studio), STUDIO_PROJECTS_DIR: path.join(work, 'studio'),
  PORT: String(ports.grow), GROW_DATA_DIR: path.join(work, 'grow')};
receipt.environmentKeys = Object.keys(env).sort();
async function start(id) {
  const cwd = path.join(root, id === 'launcher' ? 'launcher' : `products/${id}`);
  const args = id === 'build' ? ['--import', 'tsx', 'src/backend/server.ts'] : [id === 'launcher' ? 'server.mjs' : 'src/server.js'];
  const child = spawn(process.execPath, args, {cwd, env, stdio: ['ignore', 'pipe', 'pipe']});
  children.push({id, child});
  let log = '';
  child.stdout.on('data', b => { log = (log + b).slice(-12000); });
  child.stderr.on('data', b => { log = (log + b).slice(-12000); });
  child.on('error', error => { log += error.message; });
  child.once('exit', () => { void fs.writeFile(path.join(out, `${id}-server.log`), log); });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw Error(`${id} exited before readiness: ${log}`);
    try { if ((await fetch(targets[id], {signal: AbortSignal.timeout(500)})).ok) return; } catch { /* Only await this owned child. */ }
    await delay(100);
  }
  throw Error(`${id} readiness timeout: ${log}`);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
  });
}
async function api(owner, route, body, extraHeaders = {}) {
  const response = await fetch(targets[owner] + route, {method: body ? 'POST' : 'GET',
    headers: {'X-LaunchForge': '1', 'Content-Type': 'application/json', ...extraHeaders},
    ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(3000)});
  return {status: response.status, body: await response.json()};
}
async function navigate(page, id) {
  const menu = page.getByRole('button', {name: 'Menu', exact: true});
  if (await menu.isVisible() && await menu.getAttribute('aria-expanded') === 'false') await menu.click();
  await page.locator(`nav a[href="#${id}"]`).click();
  await expect(page.locator('#' + id)).toBeVisible();
  assert.equal(await page.locator('[data-view]:visible').count(), 1);
}
async function capture(page, filename) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal overflow');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({path: path.join(out, filename), fullPage: true});
}
async function checkpoint(page, label) {
  const raw = await page.evaluate(() => localStorage.getItem('launchforge-advisor-v1'));
  assert.equal(typeof raw, 'string'); assert.ok(Buffer.byteLength(raw) <= 2048);
  const value = JSON.parse(raw);
  assert.deepEqual(Object.keys(value).sort(), ['conversationId', 'lastTopicIds', 'projectId', 'runtimeId', 'schemaVersion', 'style', 'unresolvedTopicIds']);
  assert.equal(value.schemaVersion, 1);
  for (const key of ['lastTopicIds', 'unresolvedTopicIds']) assert.ok(Array.isArray(value[key]) && value[key].length <= 3);
  assert.doesNotMatch(raw, /QUESTION_NOT_PERSISTED|REPLY_NOT_PERSISTED|PRIVATE_OWNER_TEXT|currentState|completionState|question|answer|transcript|credential/);
  receipt.checkpoints.push({label, raw});
  return value;
}
async function ask(page, question, button = 'Ask for help') {
  const preparingPrompt = button === 'Prepare coding-agent prompt';
  const selectedRuntime = await page.locator('#advisor-runtime').inputValue();
  // This is an offline real-owner journey: only inert prompt preparation may select Codex.
  assert.ok(preparingPrompt ? ['', 'codex'].includes(selectedRuntime) : selectedRuntime === '',
    'HELP must explicitly use local fallback; never attempt the qualified native conversation.');
  await page.locator('#advisor-question').fill(question);
  const before = receipt.apiRequests.filter(r => r.path === '/api/advisor' && r.method === 'POST').length;
  const responsePromise = page.waitForResponse(r => r.url() === targets.launcher + '/api/advisor' && r.request().method() === 'POST');
  await page.getByRole('button', {name: button, exact: true}).click();
  const response = await responsePromise;
  assert.equal(response.status(), 200);
  const value = await response.json();
  const reply = value.reply;
  await expect(page.locator('#advisor-result h3')).toHaveText(names.advisor);
  assert.equal(await page.locator('#advisor-host').count(), 1);
  assert.equal(await page.locator('#advisor-form').count(), 1);
  assert.equal(await page.locator('#advisor-result h3').count(), 1);
  assert.equal(receipt.apiRequests.filter(r => r.path === '/api/advisor' && r.method === 'POST').length, before + 1);
  assert.equal(reply.role, 'assistant'); assert.equal(reply.roleId, 'advisor');
  assert.equal(reply.displayName, names.advisor); assert.equal(reply.modelCalls, 0);
  assert.equal(reply.executionAuthority, 'NONE'); assert.equal(reply.sourceEditAuthority, 'NONE');
  assert.equal(reply.runtimeId, selectedRuntime || null);
  assert.equal(reply.answerSource, 'LOCAL');
  assert.equal(reply.status, preparingPrompt ? 'HANDOFF_PREPARED' : 'SETUP_REQUIRED');
  receipt.advisorReplies.push({runtimeId: reply.runtimeId, status: reply.status, role: reply.role,
    conversationId: reply.conversationId, modelCalls: reply.modelCalls, currentState: reply.currentState});
  await checkpoint(page, `reply-${receipt.advisorReplies.length}`);
  return value;
}

try {
  const sources = ['launcher/index.html', 'launcher/server.mjs', 'launcher/advisor-host.mjs',
    'launcher/src/advisor.js', 'launcher/src/main.js', 'launcher/src/shell.js', 'launcher/src/display-names.js',
    'launcher/tests/convergence-browser.mjs', 'launcher/dist/index.html',
    ...['launcher', 'products/build', 'products/studio', 'products/grow'].map(dir => dir + '/package-lock.json')];
  for (const file of await fs.readdir(path.join(root, 'launcher/dist/assets'))) sources.push('launcher/dist/assets/' + file);
  for (const file of sources) receipt.sourceSha256[file] = digest(await fs.readFile(path.join(root, file)));
  for (const id of ['build', 'studio', 'grow', 'launcher']) await start(id);
  browser = await chromium.launch({headless: true, env: {PATH: env.PATH, TMPDIR: tmp, LANG: env.LANG}});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, permissions: ['clipboard-read', 'clipboard-write']});
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!Object.values(targets).includes(url.origin)) { receipt.externalRequests.push(url.origin); await route.abort(); }
    else await route.continue();
  });
  context.on('page', page => {
    page.on('pageerror', e => receipt.browserErrors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') receipt.consoleErrors.push({text: m.text(), url: m.location().url}); });
  });
  context.on('request', r => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) receipt.apiRequests.push({method: r.method(), origin: u.origin, path: u.pathname}); });
  context.on('response', r => { if (r.status() >= 400) receipt.httpErrors.push({url: r.url(), status: r.status()}); });
  let page = await context.newPage();
  await page.goto(targets.launcher);
  await expect(page.locator('#home')).toBeVisible();
  await expect(page).toHaveTitle(names.umbrella + ' — Projects / recent work');
  await expect(page.locator('#path summary')).toHaveText('Build. Present. Grow.');
  await capture(page, 'home-desktop.png');
  await navigate(page, 'setup');
  await page.getByLabel('Project name', {exact: true}).fill('Convergence local journey');
  await page.getByLabel('Desired outcome').fill('Keep local products independent and preserve current work.');
  await page.getByLabel('Coding tool', {exact: true}).selectOption('manual');
  for (const [startingPoint, product] of [['IDEA', 'build'], ['REPO', 'build'], ['APP_OR_RECORDING', 'studio'], ['GROW_INPUTS', 'grow']]) {
    await page.locator('#setup-form select[name="startingPoint"]').selectOption(startingPoint);
    await page.getByRole('button', {name: 'Check setup', exact: true}).click();
    await expect(page.getByTestId('setup-state')).toHaveText('READY');
    await expect(page.locator('#setup-result')).toContainText('Optional connectors selected: 0. Optional media support is available.');
    await expect(page.locator('#setup-result a.continue')).toHaveText('Continue to ' + names[product]);
  }
  receipt.checks.push('All three real owners permit zero-connector manual setup; entry readiness is READY.');
  for (const id of ['build', 'studio', 'grow']) {
    await navigate(page, id);
    const [owner] = await Promise.all([context.waitForEvent('page'), page.locator(`#${id} .address a`).click()]);
    await owner.waitForLoadState('networkidle');
    assert.equal(new URL(owner.url()).origin, targets[id]);
    await expect(owner).toHaveTitle(new RegExp(names.umbrella + ' ' + names[id]));
    assert.doesNotMatch(await owner.locator('body').innerText(), /\b(?:LaunchForge|Forge|Studio)\b/);
    assert.ok(await owner.locator('button,input,a').count());
    await capture(owner, `${id}-direct-desktop.png`); await owner.close();
    await expect(page.locator('#' + id)).toBeVisible();
  }
  receipt.checks.push('Build, Studio and Grow open their real landing pages; shell keeps selected product.');
  await navigate(page, 'connections');
  await expect(page.locator('#media-summary')).toHaveText('Optional media support is available. Account capability has not been checked.');
  const higgsfield = page.locator('.connection-row').filter({hasText: 'Higgsfield'});
  await higgsfield.locator('summary').click();
  await expect(higgsfield).toContainText('VIDEO_GENERATION: UNKNOWN');
  await expect(higgsfield).toContainText('NONE granted by this shell');
  assert.doesNotMatch(await page.locator('#connections').innerText(), /PENDING/);
  await capture(page, 'connections-desktop.png');
  await navigate(page, 'advisor');
  await page.locator('#advisor-runtime').selectOption('');
  const first = await ask(page, 'Can I use Higgsfield?');
  assert.equal(first.mediaIntegration, 'OFFLINE_QUALIFIED');
  await expect(page.locator('#advisor-result')).toContainText('support is available');
  await page.locator('#advisor-result summary').click();
  await expect(page.locator('#advisor-result')).toContainText('UNKNOWN');
  assert.doesNotMatch(await page.locator('#advisor-result').innerText(), /PENDING/);
  await capture(page, 'advisor-higgsfield-desktop.png');
  receipt.checks.push('One Advisor host asks Higgsfield; integrated support available and account capability unchecked stay distinct.');
  const conversations = [];
  for (const id of ['codex', '']) {
    await page.locator('#advisor-runtime').selectOption(id);
    const value = await ask(page, 'Fix inaccessible field labels. QUESTION_NOT_PERSISTED', 'Prepare coding-agent prompt');
    assert.equal(value.reply.runtimeId, id || null); conversations.push(value.reply.conversationId);
    await expect(page.locator('#advisor-prompt')).toContainText(id === 'codex' ? 'Codex' : 'your chosen coding agent');
    await page.getByRole('button', {name: 'Copy coding-agent prompt', exact: true}).click();
    await expect(page.locator('#advisor-selection-status')).toContainText('Prompt copied.');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), value.reply.codingPrompt);
    assert.equal((await checkpoint(page, id || 'local-fallback')).runtimeId, id || null);
  }
  assert.notEqual(conversations[0], conversations[1]);
  await capture(page, 'advisor-prompt-desktop.png');
  await navigate(page, 'grow'); await navigate(page, 'advisor');
  const beforeReload = await checkpoint(page, 'before-reload');
  await page.reload();
  await expect(page.locator('#advisor-runtime')).toHaveValue('');
  await expect(page.locator('#advisor-question')).toHaveValue('');
  assert.deepEqual(await checkpoint(page, 'after-reload'), beforeReload);
  const reopened = await ask(page, 'Can I use Higgsfield?');
  assert.equal(reopened.reply.conversationId, beforeReload.conversationId);
  await page.close(); page = await context.newPage(); await page.goto(targets.launcher + '/#advisor');
  const tabReopen = await ask(page, 'Can I use Higgsfield?');
  assert.equal(tabReopen.reply.conversationId, beforeReload.conversationId);
  receipt.checks.push('Codex inert handoff and local fallback use distinct conversations; prompts copy without execution; the bounded local-help checkpoint survives reload and tab reopen.');

  // Real Grow creation, then inert source fixture matching its read-only projection regression.
  const created = await api('grow', '/api/projects', {name: 'Read-only selected Grow', planOnly: true});
  assert.equal(created.status, 201);
  const file = path.join(env.GROW_DATA_DIR, created.body.id, 'grow.project.json');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.productPack = {notice: 'PRIVATE_OWNER_TEXT must not leave its owner'};
  saved.exports = [{id: 'old-export', stale: true}];
  await fs.writeFile(file, JSON.stringify(saved, null, 2) + '\n');
  const before = await fs.readFile(file), beforeStat = await fs.stat(file);
  await page.locator('#advisor-product').selectOption('grow');
  await page.locator('#advisor-read-projects').click();
  await expect(page.locator('#advisor-project option').filter({hasText: 'Read-only selected Grow'})).toHaveCount(1);
  await page.locator('#advisor-project').selectOption(created.body.id);
  const selected = await ask(page, 'What is current in Grow? QUESTION_NOT_PERSISTED');
  assert.equal(selected.reply.currentState.completionState, 'STALE');
  assert.equal(selected.reply.currentState.freshness, 'STALE');
  await expect(page.locator('#advisor-result')).toContainText('STALE');
  assert.doesNotMatch(JSON.stringify(selected), /PRIVATE_OWNER_TEXT/);
  assert.deepEqual(await fs.readFile(file), before);
  assert.equal((await fs.stat(file)).mtimeMs, beforeStat.mtimeMs);
  receipt.readOnlyOwner = {product: 'grow', projectId: created.body.id, beforeSha256: digest(before),
    afterSha256: digest(await fs.readFile(file)), beforeMtimeMs: beforeStat.mtimeMs, afterMtimeMs: (await fs.stat(file)).mtimeMs};
  receipt.checks.push('Selected real Grow project yields fresh STALE projection; saved state bytes and mtime remain unchanged; private owner text stays excluded.');
  const malicious = {product: 'grow', projectId: null, runtimeId: null, question: 'Help', intent: 'HELP', checkpoint: null};
  for (const field of ['state', 'doctor', 'liveContext', 'transport']) assert.equal((await api('launcher', '/api/advisor', {...malicious, [field]: {completionState: 'CURRENT_PASS'}})).status, 400);
  assert.equal((await api('launcher', '/api/advisor', malicious, {Origin: 'https://invalid.example'})).status, 403);
  receipt.checks.push('Host API rejects injected owner/Doctor/transport fields and foreign Origin through local-only requests.');
  await page.setViewportSize({width: 390, height: 844});
  await capture(page, 'advisor-selected-grow-390.png');
  await navigate(page, 'connections'); await capture(page, 'connections-390.png');
  await navigate(page, 'home'); await capture(page, 'home-390.png');
  await navigate(page, 'advisor');
  const compact = await ask(page, 'Can I use Higgsfield?');
  assert.equal(compact.reply.currentState.completionState, 'STALE');
  await capture(page, 'advisor-higgsfield-390.png');
  receipt.checks.push('390px journey retains one composer and response, all navigation and no horizontal overflow.');
  assert.deepEqual(receipt.browserErrors, []); assert.deepEqual(receipt.consoleErrors, []);
  assert.deepEqual(receipt.httpErrors, []); assert.deepEqual(receipt.externalRequests, []);
  assert.equal(await fs.readFile(nativeLog, 'utf8'), '');
  assert.ok(receipt.advisorReplies.every(r => r.modelCalls === 0));
  receipt.status = 'PASS';
} catch (error) {
  receipt.status = 'FAIL'; receipt.error = error.stack; throw error;
} finally {
  await browser?.close();
  for (const {child} of [...children].reverse()) await stop(child);
  receipt.processesStopped = children.every(({child}) => child.exitCode !== null || child.signalCode !== null);
  receipt.processes = children.map(({id, child}) => ({id, pid: child.pid, exitCode: child.exitCode, signal: child.signalCode}));
  receipt.nativeCanaryLog = await fs.readFile(nativeLog, 'utf8');
  receipt.nativeCalls = receipt.nativeCanaryLog.trim() ? receipt.nativeCanaryLog.trim().split('\n').length : 0;
  await fs.writeFile(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
}
console.log(JSON.stringify({status: receipt.status, checks: receipt.checks.length, advisorReplies: receipt.advisorReplies.length,
  externalRequests: receipt.externalRequests.length, nativeCalls: receipt.nativeCalls, processesStopped: receipt.processesStopped, evidence: receiptFile}));
