import { chromium } from 'playwright';
import { createApp } from '../src/server.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = await mkdtemp(path.join(tmpdir(), 'redwood-grow-polish-'));
const evidence = path.resolve(process.env.LF_EVIDENCE_DIR || path.join(root, 'evidence'));
await mkdir(evidence, { recursive: true });
let auditCalls = 0;
const app = createApp({ dataDir: path.join(root, 'data'), auditRunner: () => { auditCalls++; throw new Error('Unexpected audit'); } });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ headless: true });
const errors = [], networkBlocked = [], measurements = [];
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      networkBlocked.push(route.request().url());
      return route.abort();
    });
    const shot = name => page.screenshot({ path: path.join(evidence, `${name}-${width}.png`) });
    await page.goto(origin);
    await page.locator('#welcome-create').waitFor();
    const welcome = await page.locator('.welcome').innerText();
    assert.match(welcome, /Build implements source changes; return to Grow to recheck/);
    assert.doesNotMatch(welcome, /Diff, apply, recheck|Applied only on approval|publishedAt/);
    await shot('welcome');
    await page.locator('#new-project').click();
    const form = page.locator('#create-form');
    const mode = form.locator('[name=planOnly]');
    const url = form.locator('[name=url]');
    const consent = form.locator('[name=trustedSite]');
    assert.equal(await mode.isChecked(), true);
    assert.equal(await url.evaluate(node => node.required), false);
    assert.equal(await consent.isVisible(), false);
    assert.equal(await consent.isDisabled(), true);
    assert.match(await page.locator('#intake-url-label').innerText(), /optional/);
    await shot('intake-plan');
    await mode.uncheck();
    assert.equal(await url.evaluate(node => node.required), true);
    assert.equal(await consent.isVisible(), true);
    assert.equal(await consent.evaluate(node => node.required), true);
    assert.equal(await form.evaluate(node => node.checkValidity()), false);
    await consent.check();
    await shot('intake-audit');
    await mode.check();
    assert.equal(await consent.isChecked(), false);
    await mode.uncheck();
    assert.equal(await consent.isChecked(), false, 'Prior audit consent must not survive a plan-only choice');
    await mode.check();
    await form.locator('[name=name]').fill(`Polish fixture ${width}`);
    const created = page.waitForResponse(response => response.request().method() === 'POST' && response.url() === `${origin}/api/projects`);
    await form.locator('button[type=submit]').click();
    const response = await created;
    assert.equal(response.status(), 201);
    const request = response.request().postDataJSON();
    assert.equal(request.planOnly, true);
    assert.equal(request.url, '');
    assert.equal(request.trustedSite, false);
    assert.equal(request.renderDom, false);
    await page.locator('#growth-plan-form').waitFor();
    assert.match(await page.locator('.panel').innerText(), /Ad platforms · NOT CONNECTED/i);
    assert.match(await page.locator('.panel').innerText(), /Plan locally without an ad account or payment/);
    assert.equal(await page.locator('#run-audit').isDisabled(), true);
    assert.equal(await page.locator('[data-tab]').count(), 10);
    await page.evaluate(() => window.scrollTo(0, 0));
    const layout = await page.evaluate(() => ({
      width: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      navHeight: document.querySelector('.path').getBoundingClientRect().height,
      panelTop: document.querySelector('.panel').getBoundingClientRect().top,
      formTop: document.querySelector('#growth-plan-form').getBoundingClientRect().top,
    }));
    assert.ok(layout.documentWidth <= width + 1, 'Document fits the viewport');
    if (width === 390) {
      assert.ok(layout.navHeight <= 74, 'Mobile section navigation occupies one compact row');
      assert.ok(layout.formTop < 844, 'Growth plan form begins in the first mobile viewport');
    }
    measurements.push(layout);
    await shot('planner');
    const destinations = await page.locator('[data-tab]').evaluateAll(nodes => nodes.map(node => node.dataset.tab));
    await page.locator(`[data-tab="${destinations[0]}"]`).focus();
    for (const destination of destinations) {
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.tab), destination, 'Tab reaches every section in order');
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('[aria-current=step]').getAttribute('data-tab'), destination);
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.tab), destination, 'Focus remains on the selected section');
      assert.ok((await page.locator('.panel').innerText()).length > 0);
      await page.keyboard.press('Tab');
    }
    await page.locator('[data-tab=overview]').click();
    const overview = await page.locator('.panel').innerText();
    assert.match(overview, /Choose the work you need/);
    assert.doesNotMatch(overview, /URL only|publishedAt|The work, in the order it happens/);
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot('overview');
    await context.close();
  }
  assert.equal(auditCalls, 0);
  assert.deepEqual(networkBlocked, []);
  assert.deepEqual(errors, []);
  const receipt = { status: 'PASS', widths: [1440, 390], measurements, auditCalls, networkBlocked, pageErrors: errors, note: 'Synthetic no-URL projects, loopback-only browser traffic, no media generation or provider calls.' };
  await writeFile(path.join(evidence, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  await browser.close();
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
  await rm(path.join(root, 'data'), { recursive: true, force: true });
}
