import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import http from 'node:http';
import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {ResumeRecord} from '../../integrations/resume/contracts.mjs';
import {DISPLAY_NAMES as names} from '../src/display-names.js';

// Shell acceptance uses labeled HTTP fixtures. It never starts product sources,
// probes a provider, or treats fixture readiness as live product qualification.
const root = fileURLToPath(new URL('../../', import.meta.url));
const {chromium, expect} = createRequire(path.join(root, 'products/build/package.json'))('@playwright/test');
const out = process.env.LF_EVIDENCE_DIR || path.join(root, 'launcher/tests/evidence/shell-r1');
const connectionWork = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-connections-'));
const routes = ['home', 'setup', 'build', 'studio', 'grow', 'advisor', 'connections', 'settings'];
const projectId = 'shell-fixture-project';
const projectName = 'Shell fixture project';
let completionState = 'NOT_RUN';
let buildAvailable = true;
let launcher, browser;
let expectedHttpFailure = null;
const fixtures = [];
const receipt = {
  status: 'RUNNING',
  qualification: 'LAUNCHER_SHELL_WITH_LABELED_OWNER_FIXTURES_ONLY',
  productSourcesExecuted: false,
  providerCalls: 0,
  checks: [],
  browserErrors: [],
  consoleErrors: [],
  expectedConsoleErrors: [],
  httpErrors: [],
  unexpectedRequests: [],
  browserApiRequests: [],
  fixtureRequests: [],
};

function resumeFixture() {
  return ResumeRecord.parse({
    schemaVersion: 1, derived: true, projectId, projectName, product: 'build',
    sourceIdentity: 'a'.repeat(64), currentRevision: null,
    lastOpenedAt: '2026-10-03T00:00:00.000Z', lastVerifiedAt: null,
    derivedFrom: {statePath: '.launchforge/project.json', snapshotSha256: 'b'.repeat(64), identityScope: 'Labeled shell browser fixture'},
    currentStage: 'brief', completionState, lastSuccessfulAction: null, lastFailedAction: null,
    unresolvedItems: [], relevantPaths: [], instructionPaths: [], receipts: [], externalRequests: [],
    nextRecommendedAction: {kind: 'VERIFY', summary: 'Read fresh fixture state before continuing.', targetPath: '.launchforge/project.json'},
  });
}

async function fixture(owner, handler) {
  const server = http.createServer((req, res) => {
    receipt.fixtureRequests.push({owner, method: req.method, path: req.url});
    res.setHeader('Content-Type', 'application/json');
    handler(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  fixtures.push(server);
  return server.address().port;
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

async function startLauncher(ports) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: path.join(root, 'launcher'),
    env: {...process.env, LF_LAUNCHER_PORT: String(ports.launcher), LF_BUILD_PORT: String(ports.build), LF_STUDIO_PORT: String(ports.studio), LF_GROW_PORT: String(ports.grow), LF_CONNECTIONS_DIR: path.join(connectionWork, 'connections')},
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  launcher = child;
  let stderr = '';
  child.stderr.on('data', value => { stderr = (stderr + value).slice(-2000); });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw Error('Launcher exited before readiness: ' + stderr);
    try {
      if ((await fetch(`http://127.0.0.1:${ports.launcher}`, {signal: AbortSignal.timeout(500)})).ok) return;
    } catch { /* Wait only for this child, never an existing developer server. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Launcher did not serve its built shell within ten seconds.');
}

async function panel(page, id) {
  await expect(page.locator('#' + id)).toBeVisible();
  for (const other of routes.filter(route => route !== id)) await expect(page.locator('#' + other)).toBeHidden();
}

async function navigate(page, id, mobile = false) {
  const menu = page.getByRole('button', {name: 'Menu', exact: true});
  if (mobile && await menu.getAttribute('aria-expanded') === 'false') await menu.click();
  const link = page.locator(`nav a[href="#${id}"]`);
  await expect(link).toBeVisible();
  await link.click();
  await panel(page, id);
  if (mobile) {
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#route-title')).toBeFocused();
  }
}

async function noOverflow(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'The shell must fit the viewport.');
}

async function screenshot(page, name) {
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  await page.screenshot({path: path.join(out, name), fullPage: true});
}

async function holdNextResponse(page, apiPath) {
  let unlock, markReady, markDelivered;
  const gate = new Promise(resolve => { unlock = resolve; });
  const ready = new Promise(resolve => { markReady = resolve; });
  const delivered = new Promise(resolve => { markDelivered = resolve; });
  let held = false;
  const pattern = '**' + apiPath;
  const handler = async route => {
    if (held) return route.continue();
    held = true;
    const response = await route.fetch();
    markReady();
    await gate;
    await route.fulfill({response});
    markDelivered();
  };
  await page.route(pattern, handler);
  return {ready, release: async () => {
    unlock();
    await delivered;
    await page.unroute(pattern, handler);
    // Let the delivered fetch settle in the page before testing absence of stale UI.
    await page.waitForLoadState('networkidle');
  }};
}

const evidenceInputs = ['index.html', 'server.mjs', 'src/main.js', 'src/advisor.js', 'src/shell.js', 'src/styles.css', 'src/display-names.js', 'tests/shell-browser.mjs', 'dist/index.html'];
for (const name of (await fs.readdir(path.join(root, 'launcher/dist/assets'))).sort()) if (/\.(js|css)$/.test(name)) evidenceInputs.push('dist/assets/' + name);
receipt.sourceSha256 = Object.fromEntries(await Promise.all(evidenceInputs.map(async relative => [relative, createHash('sha256').update(await fs.readFile(path.join(root, 'launcher', relative))).digest('hex')])));
await fs.mkdir(out, {recursive: true});
try {
  const build = await fixture('BUILD_LIST_AND_RESUME_FIXTURE', (req, res) => {
    if (!buildAvailable) { res.statusCode = 503; res.end(JSON.stringify({error: 'Labeled fixture is offline.'})); return; }
    if (req.url === '/api/projects') res.end(JSON.stringify({workspace: '/fixture-only', projects: [{id: projectId, name: projectName}]}));
    else if (req.url === `/api/projects/${projectId}/resume`) res.end(JSON.stringify(resumeFixture()));
    else { res.statusCode = 404; res.end(JSON.stringify({error: 'No fixture route.'})); }
  });
  const otherOwner = await fixture('STUDIO_GROW_LIST_FIXTURE_ONLY', (req, res) => {
    res.statusCode = req.url === '/api/projects' ? 200 : 404;
    res.end(req.url === '/api/projects' ? '[]' : JSON.stringify({error: 'No fixture route.'}));
  });
  const ports = {launcher: await freePort(), build, studio: otherOwner, grow: otherOwner};
  const origin = `http://127.0.0.1:${ports.launcher}`;
  const targets = Object.fromEntries(['build', 'studio', 'grow'].map(id => [id, `http://127.0.0.1:${ports[id]}`]));
  const allowedOrigins = new Set([origin, ...Object.values(targets)]);
  await startLauncher(ports);
  browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (!allowedOrigins.has(url.origin)) { receipt.unexpectedRequests.push(url.origin); await route.abort(); }
    else await route.continue();
  });
  context.on('page', page => {
    page.on('pageerror', error => receipt.browserErrors.push(error.message));
    page.on('console', message => {
      if (message.type() !== 'error') return;
      const record = {text: message.text(), url: message.location().url};
      if (expectedHttpFailure && record.url === origin + expectedHttpFailure.path && /Failed to load resource.*status of 400/.test(record.text)) receipt.expectedConsoleErrors.push(record);
      else receipt.consoleErrors.push(record);
    });
  });
  context.on('response', response => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    receipt.httpErrors.push({path: url.pathname, status: response.status(), expected: !!expectedHttpFailure && url.origin === origin && url.pathname === expectedHttpFailure.path && response.status() === expectedHttpFailure.status});
  });
  context.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) receipt.browserApiRequests.push({method: request.method(), path: url.pathname});
  });
  const page = await context.newPage();
  await page.goto(origin);
  await panel(page, 'home');
  for (const id of routes) await expect(page.locator(`nav a[href="#${id}"]`)).toBeVisible();
  for (const id of routes.filter(id => id !== 'home')) {
    await navigate(page, id);
    if (['build', 'studio', 'grow'].includes(id)) await expect(page.locator('#current-context')).toContainText(names[id]);
  }
  await noOverflow(page);
  await screenshot(page, 'desktop-shell.png');
  receipt.checks.push('Desktop shell keeps all eight navigation routes available and shows one panel at a time.');

  await navigate(page, 'build');
  await navigate(page, 'studio');
  await page.goBack(); await panel(page, 'build');
  await page.goForward(); await panel(page, 'studio');
  for (const id of routes) {
    await page.goto(origin + '/#' + id); await panel(page, id);
    await page.reload(); await panel(page, id);
    await expect(page.locator('#route-title')).toBeInViewport();
  }
  for (const alias of ['recent', 'entry', 'path']) { await page.goto(origin + '/#' + alias); await panel(page, 'home'); }
  await page.goto(origin + '/#unknown-shell-route'); await panel(page, 'home');
  receipt.checks.push('Browser history, direct hashes, refresh, legacy aliases, and unknown-route fallback retain a usable shell.');

  await navigate(page, 'setup');
  await page.getByLabel('Project name', {exact: true}).fill('Shell onboarding fixture');
  await page.getByLabel('Desired outcome').fill('Preserve the existing owner intake and source of truth.');
  await page.getByLabel('Audience (optional)').fill('Local fixture teams');
  await navigate(page, 'connections'); await navigate(page, 'settings'); await navigate(page, 'setup');
  await expect(page.getByLabel('Project name', {exact: true})).toHaveValue('Shell onboarding fixture');
  await expect(page.getByLabel('Desired outcome')).toHaveValue('Preserve the existing owner intake and source of truth.');
  await expect(page.getByLabel('Audience (optional)')).toHaveValue('Local fixture teams');
  for (const [startingPoint, product] of [['IDEA', 'build'], ['REPO', 'build'], ['APP_OR_RECORDING', 'studio'], ['GROW_INPUTS', 'grow']]) {
    await page.locator('#setup-form select[name="startingPoint"]').selectOption(startingPoint);
    await expect(page.locator('#current-context')).toContainText(names[product]);
    await expect(page.locator('#next-action')).toHaveAttribute('href', '#' + product);
    await page.getByLabel('Coding tool', {exact: true}).selectOption('manual');
    await page.getByRole('button', {name: 'Check setup', exact: true}).click();
    await expect(page.getByTestId('setup-state')).toHaveText('READY');
    const link = page.locator('#setup-result a.continue');
    await expect(link).toHaveAttribute('href', product === 'build' ? new RegExp('^' + targets.build.replaceAll('.', '\\.') + '/#setup=') : targets[product]);
    if (product === 'build') {
      const href = await link.getAttribute('href');
      const context = JSON.parse(decodeURIComponent(href.split('#setup=')[1]));
      assert.equal(context.startingPoint, startingPoint);
      assert.equal(context.selectedAgentAdapterId, 'manual');
      assert.equal(context.projectName, 'Shell onboarding fixture');
    }
  }
  await page.locator('#setup-form select[name="startingPoint"]').selectOption('IDEA');
  await page.getByLabel('Coding tool', {exact: true}).selectOption('codex');
  await page.getByRole('button', {name: 'Check setup', exact: true}).click();
  await expect(page.getByTestId('setup-state')).toHaveText('UNKNOWN');
  await expect(page.getByTestId('entry-state')).toHaveText('Local Build entry: ready.');
  const nativeContinuation = page.locator('#setup-result a.continue');
  await expect(nativeContinuation).toHaveText('Continue to Build — native-client handoff');
  assert.equal(JSON.parse(decodeURIComponent((await nativeContinuation.getAttribute('href')).split('#setup=')[1])).selectedAgentAdapterId, 'codex');
  await expect(page.locator('#setup-result')).toContainText('authentication and billing have not been checked here');
  await page.getByRole('button', {name: 'Use manual handoff instead'}).click();
  await expect(page.getByTestId('setup-state')).toHaveText('READY');
  buildAvailable = false;
  await page.getByRole('button', {name: 'Check setup', exact: true}).click();
  await expect(page.getByTestId('setup-state')).toHaveText('NEEDS_SETUP');
  await expect(page.locator('#setup-result a.continue')).toHaveCount(0);
  buildAvailable = true;
  receipt.checks.push('Setup form survives route changes; all four stable starting IDs reuse owner intake; manual READY, provider UNKNOWN, and offline NEEDS_SETUP remain distinct.');

  await page.getByRole('button', {name: 'Check setup', exact: true}).click();
  await expect(page.getByTestId('setup-state')).toHaveText('READY');
  await page.locator('#setup-form select[name="startingPoint"]').selectOption('GROW_INPUTS');
  await expect(page.getByTestId('setup-state')).toHaveCount(0);
  await expect(page.locator('#setup-result a.continue')).toHaveCount(0);
  await page.getByRole('button', {name: 'Check setup', exact: true}).click();
  await expect(page.getByTestId('setup-state')).toHaveText('READY');
  await navigate(page, 'studio');
  await page.locator('#next-action').click(); await panel(page, 'setup');
  await expect(page.locator('#setup-form select[name="startingPoint"]')).toHaveValue('APP_OR_RECORDING');
  await expect(page.locator('#current-context')).toContainText(names.studio);
  await expect(page.getByTestId('setup-state')).toHaveCount(0);
  const delayedSetup = await holdNextResponse(page, '/api/setup');
  await page.getByRole('button', {name: 'Check setup', exact: true}).click();
  await delayedSetup.ready;
  await page.locator('#setup-form select[name="startingPoint"]').selectOption('GROW_INPUTS');
  await delayedSetup.release();
  await expect(page.getByRole('button', {name: 'Check setup', exact: true})).toBeEnabled();
  await expect(page.getByTestId('setup-state')).toHaveCount(0);
  await expect(page.locator('#setup-result a.continue')).toHaveCount(0);
  await expect(page.locator('#current-context')).toContainText(names.grow);
  receipt.checks.push('Changed setup input and product shortcuts invalidate old readiness; a delayed response cannot restore READY or a Continue link for superseded input.');

  await navigate(page, 'connections');
  await expect(page.locator('#doctor-rows')).toContainText('UNKNOWN');
  await expect(page.locator('#connections')).toContainText('Optional media support is available');
  await expect(page.locator('#connections')).toContainText('Read-only evidence');
  await expect(page.locator('.connection-row').first()).toContainText('Codex');
  await expect(page.locator('.connection-row').filter({hasText: 'Higgsfield'})).toContainText('Optional · media');
  await expect(page.locator('.connection-row').filter({hasText: 'ElevenLabs'})).toContainText('Not required · competition scope excludes ElevenLabs');
  await expect(page.locator('#doctor-rows')).not.toContainText('select and verify a mode');
  assert.equal(await page.locator('#connections input[type="password"]').count(), 0);
  const beforeAdvisor = receipt.browserApiRequests.length;
  await navigate(page, 'advisor');
  await expect(page.locator('#advisor-host')).toHaveAttribute('data-integration-slot', 'advisor');
  await expect(page.locator('#advisor-host')).toHaveAttribute('data-state', 'CODEX_SELECTED');
  await expect(page.locator('#advisor')).toContainText('Advisor uses your existing Codex account');
  await expect(page.locator('#advisor-context')).toContainText('Prior shell context: ');
  await expect(page.locator('#advisor-context')).toContainText('Next: ');
  await expect(page.locator('#advisor-mode')).toHaveText('Codex-backed expert selected');
  await expect(page.locator('#advisor-runtime option')).toHaveCount(2);
  await expect(page.locator('#advisor-runtime option[value="claude"]')).toHaveCount(0);
  await page.locator('#advisor-product').selectOption('build');
  await expect(page.locator('#current-context')).toContainText('Prior shell context:');
  await expect(page.locator('#advisor-context')).toContainText('uses the Product and Project selected below');
  await page.locator('#advisor-runtime').selectOption('');
  await expect(page.locator('#advisor-mode')).toHaveText('Local deterministic help selected');
  await page.locator('#advisor-runtime').selectOption('codex');
  await expect(page.locator('#advisor-mode')).toHaveText('Codex-backed expert selected');
  assert.equal(await page.locator('#advisor textarea').count(), 1);
  assert.equal(await page.locator('#advisor form').count(), 1);
  assert.equal(await page.locator('#advisor [contenteditable="true"]').count(), 0);
  assert.equal(receipt.browserApiRequests.length, beforeAdvisor, 'Opening Advisor must not call a runtime.');
  assert.ok(!receipt.browserApiRequests.some(request => /advisor|chat|completion|generate/i.test(request.path)));
  receipt.checks.push('Connections exposes integrated but unchecked provider truth; one Advisor composer opens without a runtime or API call.');

  for (const product of ['build', 'studio', 'grow']) {
    await navigate(page, product);
    const link = page.locator(`#${product} .address a`);
    await expect(link).toHaveAttribute('href', targets[product]);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(page.locator(`#${product}-command`)).toBeVisible();
  }
  receipt.checks.push('Each standalone owner retains a direct link using its configured loopback port and its copyable start command.');

  await navigate(page, 'home');
  await page.getByRole('button', {name: 'Read current projects', exact: true}).click();
  const delayedNavigationResume = await holdNextResponse(page, '/api/build-resume/' + projectId);
  await page.getByRole('button', {name: 'Resume ' + projectName, exact: true}).click();
  await delayedNavigationResume.ready;
  await navigate(page, 'studio');
  await delayedNavigationResume.release();
  await expect(page.locator('#current-context')).toContainText(names.studio);
  await navigate(page, 'advisor');
  await expect(page.locator('#advisor-context')).toContainText('Prior shell context: ' + names.studio + '.');
  await expect(page.locator('#advisor-context')).not.toContainText(projectName);
  await navigate(page, 'home');
  const delayedAdvisorResume = await holdNextResponse(page, '/api/build-resume/' + projectId);
  await page.getByRole('button', {name: 'Resume ' + projectName, exact: true}).click();
  await delayedAdvisorResume.ready;
  await navigate(page, 'advisor');
  await expect(page.locator('#advisor-context')).toContainText('Reading current project state…');
  await delayedAdvisorResume.release();
  await expect(page.locator('#advisor-context')).toContainText(projectName);
  await expect(page.locator('#advisor-context')).toContainText('Read fresh fixture state before continuing.');
  await expect(page.locator('#advisor-context')).not.toContainText('Reading current project state…');
  await navigate(page, 'home');
  const cancelledResume = await holdNextResponse(page, '/api/build-resume/' + projectId);
  await page.getByRole('button', {name: 'Resume ' + projectName, exact: true}).click();
  await cancelledResume.ready;
  await page.getByRole('button', {name: 'Read current projects', exact: true}).click();
  await expect(page.getByRole('button', {name: 'Resume ' + projectName, exact: true})).toBeVisible();
  await cancelledResume.release();
  await expect(page.getByTestId('recent-state')).toHaveCount(0);
  await expect(page.locator('#current-context')).not.toContainText('Reading current project state…');
  await expect(page.locator('#current-context')).toContainText('Choose a project from the current owner list');
  await navigate(page, 'advisor');
  await expect(page.locator('#advisor-context')).not.toContainText('Reading current project state…');
  await expect(page.locator('#advisor-context')).toContainText('Choose a project from the current owner list');
  await navigate(page, 'home');
  const delayedOldResume = await holdNextResponse(page, '/api/build-resume/' + projectId);
  await page.getByRole('button', {name: 'Resume ' + projectName, exact: true}).click();
  await delayedOldResume.ready;
  completionState = 'STALE';
  await page.getByRole('button', {name: 'Resume ' + projectName, exact: true}).click();
  await expect(page.getByTestId('recent-state')).toHaveText('STALE');
  await delayedOldResume.release();
  await expect(page.getByTestId('recent-state')).toHaveText('STALE');
  completionState = 'NOT_RUN';
  receipt.checks.push('A late resume cannot replace a newer product context or overwrite a more recent resume response; Advisor receives the result when no different product was selected; list refresh cancels pending resume and clears its pending context.');
  await page.getByRole('button', {name: 'Resume ' + projectName, exact: true}).click();
  await expect(page.getByTestId('recent-state')).toHaveText('NOT_RUN');
  completionState = 'STALE';
  await page.getByRole('button', {name: 'Resume ' + projectName, exact: true}).click();
  await expect(page.getByTestId('recent-state')).toHaveText('STALE');
  await expect(page.locator('#current-context')).toContainText(projectName);
  await navigate(page, 'advisor');
  await expect(page.locator('#advisor-context')).toContainText(projectName);
  await expect(page.locator('#advisor-context')).toContainText('Read fresh fixture state before continuing.');
  await navigate(page, 'home');
  assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('launchforge-recent-v1'))), {schemaVersion: 1, projects: [{product: 'build', id: projectId}]});
  buildAvailable = false;
  expectedHttpFailure = {path: '/api/build-resume/' + projectId, status: 400};
  await page.getByRole('button', {name: 'Resume ' + projectName, exact: true}).click();
  await expect(page.getByTestId('recent-state')).toHaveCount(0);
  await expect(page.locator('#resume-result')).toContainText('No cached completion is shown.');
  await expect(page.locator('#current-context')).toContainText('Current state unavailable.');
  expectedHttpFailure = null;
  buildAvailable = true;
  await page.reload();
  await page.getByRole('button', {name: 'Resume ' + projectName, exact: true}).click();
  await expect(page.getByTestId('recent-state')).toHaveText('STALE');
  receipt.checks.push('Every resume requests fresh owner state; offline failure removes stale completion; reload persists only the {product,id} pointer.');

  await page.setViewportSize({width: 390, height: 844});
  const menu = page.getByRole('button', {name: 'Menu', exact: true});
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click(); await expect(menu).toHaveAttribute('aria-expanded', 'true');
  for (const id of routes) await expect(page.locator(`nav a[href="#${id}"]`)).toBeVisible();
  await screenshot(page, 'mobile-navigation-390.png');
  for (const id of routes.filter(id => id !== 'home')) { await navigate(page, id, true); await noOverflow(page); }
  await navigate(page, 'home', true); await noOverflow(page);
  await screenshot(page, 'mobile-home-390.png');
  await navigate(page, 'connections', true);
  await screenshot(page, 'mobile-connections-390.png');
  receipt.checks.push('At 390px all routes stay reachable through Menu; selection closes it, focuses the route heading, and causes no horizontal overflow.');

  // Synthetic presentation fixture only: every request is intercepted before the host.
  const recorded = {answerSource: 'CODEX', status: 'ANSWERED',
    answer: 'Synthetic presentation fixture. Output is stale.\n\nReview the owning product before rerendering.',
    nextStep: 'Inspect the saved revision.', answerContract: null,
    currentState: {product: 'studio', completionState: 'STALE', freshness: 'STALE'},
    executionAuthority: 'NONE', sourceEditAuthority: 'NONE'};
  receipt.advisorPresentation = {source: 'SYNTHETIC_PRESENTATION_ONLY', providerCalls: 0, widths: [], requestsIntercepted: 0};
  let replay = recorded;
  await page.route('**/api/advisor', async route => {
    assert.equal(route.request().postDataJSON().runtimeId, 'codex');
    receipt.advisorPresentation.requestsIntercepted++;
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify({reply: replay, checkpoint: null})});
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({width, height: width === 390 ? 844 : 1000});
    await page.goto(origin + '/#studio');
    await navigate(page, 'advisor', width === 390);
    await page.locator('#advisor-product').selectOption('build');
    await expect(page.locator('#current-context')).toContainText('Prior shell context: Present');
    await expect(page.locator('#advisor-context')).toContainText('uses the Product and Project selected below');
    await page.locator('#advisor-product').selectOption('studio');
    await page.locator('#advisor-question').fill('Replay fixture only: explain the synthetic stale state.');
    replay = recorded;
    await page.getByRole('button', {name: 'Ask for help', exact: true}).click();
    await expect(page.locator('#advisor-mode')).toHaveText('Codex-backed answer');
    for (const paragraph of recorded.answer.split(/\n\s*\n/).filter(Boolean)) await expect(page.locator('#advisor-result p').filter({hasText: paragraph})).toHaveCount(1);
    await expect(page.locator('#advisor-result')).toContainText('Completion: STALE · Freshness: STALE');
    await noOverflow(page);
    await screenshot(page, 'advisor-replay-' + width + '.png');
    replay = {...recorded, answerSource: 'LOCAL', status: 'BRIDGE_UNAVAILABLE', answerContract: null,
      answer: 'Synthetic fallback presentation.\n\nLocal help remains available.', nextStep: 'Review the current product state.'};
    await page.getByRole('button', {name: 'Ask for help', exact: true}).click();
    await expect(page.locator('#advisor-mode')).toHaveText('Local help fallback');
    await expect(page.locator('#advisor-result')).toContainText('Local help remains available.');
    await navigate(page, 'connections', width === 390);
    await page.locator('.connection-row').first().locator('summary').click();
    await expect(page.locator('.connection-row').first()).toContainText('NONE granted by this shell');
    await noOverflow(page);
    await screenshot(page, 'connections-evidence-' + width + '.png');
    await navigate(page, 'setup', width === 390);
    await page.getByLabel('Project name', {exact: true}).fill('Codex handoff presentation fixture');
    await page.getByLabel('Desired outcome').fill('Review the prepared task in the existing native client.');
    await page.getByLabel('Coding tool', {exact: true}).selectOption('codex');
    await page.getByRole('button', {name: 'Check setup', exact: true}).click();
    await expect(page.getByTestId('entry-state')).toHaveText('Local Build entry: ready.');
    await expect(page.getByTestId('setup-state')).toHaveText('UNKNOWN');
    await expect(page.locator('#setup-result a.continue')).toHaveText('Continue to Build — native-client handoff');
    await noOverflow(page);
    await screenshot(page, 'setup-codex-' + width + '.png');
    receipt.advisorPresentation.widths.push(width);
  }
  await page.unroute('**/api/advisor');
  assert.equal(receipt.advisorPresentation.requestsIntercepted, 4);
  receipt.checks.push('M1–M4: selected Codex identity and explicit local fallback; prior shell context labeled at 1440/390; read-only primary/optional/not-required Connections roles; local-ready/provider-UNKNOWN native-client continuation preserves Codex. Synthetic answer fixture keeps paragraphs and labeled state; no live Advisor request reaches the host.');

  assert.deepEqual(receipt.browserErrors, []);
  assert.deepEqual(receipt.consoleErrors, []);
  assert.equal(receipt.httpErrors.length, 1, 'Only the explicit offline resume may produce an HTTP failure.');
  assert.ok(receipt.httpErrors.every(response => response.expected));
  assert.deepEqual(receipt.unexpectedRequests, []);
  assert.ok(receipt.fixtureRequests.every(request => request.method === 'GET'), 'Fixtures must remain read-only.');
  receipt.status = 'PASS';
} catch (error) {
  receipt.status = 'FAIL';
  receipt.error = error.stack;
  throw error;
} finally {
  await browser?.close();
  await stop(launcher);
  await fs.rm(connectionWork, {recursive: true, force: true});
  for (const server of fixtures) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  await fs.writeFile(path.join(out, 'shell-browser.json'), JSON.stringify(receipt, null, 2) + '\n');
}
console.log(JSON.stringify(receipt));
