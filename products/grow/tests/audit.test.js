import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { auditSite, fetchText, inspectHtml, extractMetadata, isPublicAddress } from '../src/audit/index.js';

async function fixture(run) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === '/robots.txt') { res.setHeader('Content-Type', 'text/plain'); res.end('User-agent: *\nDisallow: /private'); return; }
    if (req.url === '/sitemap.xml') { res.setHeader('Content-Type', 'application/xml'); res.end('<urlset><url><loc>/</loc></url><url><loc>/app</loc></url><url><loc>/unobserved</loc></url></urlset>'); return; }
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' }); res.end(); return; }
    if (req.url === '/broken') { res.writeHead(503); res.end('Unavailable'); return; }
    if (req.url === '/huge') { res.end('X'.repeat(2000)); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><title>Fieldnote product</title><meta name="description" content="Notes for field teams."></head><body><h1>Fieldnote</h1><p>Capture observations.</p><a href="/unobserved">Never discover this in Grow</a></body></html>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'grow-audit-interface-'));
  try { await run({ origin, outputDir, requests }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(outputDir, { recursive: true, force: true }); }
}

function mockCli(origin, { routes = ['/', '/app'], omit = [], runtimeError = null, nullScore = false } = {}) {
  return async ({ config, configPath, outputDir, logPath, deadlineMs, killGraceMs }) => {
    assert.equal(config.scanner.maxRoutes <= 3, true);
    assert.equal(config.scanner.samples, 1);
    assert.equal(config.puppeteerClusterOptions.maxConcurrency, 1);
    assert.equal(config.cache, false);
    assert.deepEqual(config.ci, { reporter: 'jsonExpanded', buildStatic: false });
    assert.equal(deadlineMs, 180000); assert.equal(killGraceMs, 5000);
    const imported = await import(`file://${configPath}`);
    assert.equal(imported.default.site, `${origin}/`);
    await writeFile(logPath, 'Fixture mock CLI; no browser scan executed.\n');
    await writeFile(path.join(outputDir, 'ci-result.json'), JSON.stringify({ routes: routes.map(path => ({ path })) }));
    for (const [index, route] of routes.entries()) {
      if (omit.includes(route)) continue;
      const dir = path.join(outputDir, 'reports', String(index)); await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'lighthouse.json'), JSON.stringify({
        requestedUrl: origin + route, finalUrl: origin + route, fetchTime: '2026-10-03T18:00:00.000Z', lighthouseVersion: '13.5.0', runtimeError,
        categories: { seo: { title: 'SEO', score: nullScore ? null : 1 } },
        audits: { 'meta-description': { title: 'Description exists', description: 'Observed source', score: nullScore ? null : index, scoreDisplayMode: nullScore ? 'notApplicable' : 'binary', details: { type: 'table', items: [] } } },
      }));
    }
  };
}

test('qualified CLI owns discovery; exact report evidence and only observed metadata are consumed', async () => {
  await fixture(async ({ origin, outputDir, requests }) => {
    const audit = await auditSite(origin, { outputDir, allowedLocalOrigin: origin, runCli: mockCli(origin), sourceRevision: 'abc123' });
    assert.equal(audit.status, 'PARTIAL');
    assert.deepEqual(audit.coverage.omitted, [`${origin}/unobserved`]);
    assert.equal(audit.engine, 'UNLIGHTHOUSE_CLI_BUNDLED_LIGHTHOUSE');
    assert.equal(audit.sourceRevision, 'abc123');
    assert.equal(audit.lab.status, 'COMPLETE');
    assert.deepEqual(audit.lab.expectedRoutes, [`${origin}/`, `${origin}/app`]);
    assert.deepEqual(audit.lab.observedRoutes, audit.lab.expectedRoutes);
    assert.equal(audit.pages.length, 2);
    assert.equal(audit.lab.reports[0].observations[0].score, 0);
    assert.equal(audit.lab.reports[1].observations[0].score, 1);
    assert.equal(audit.pages[0].rawMetadata.description[0], 'Notes for field teams.');
    assert.equal(audit.pages[0].renderedMetadata, null);
    assert.equal(audit.pages[0].evidenceMode, 'RAW_HTML');
    assert.match(audit.pages[0].rawSha256, /^[a-f0-9]{64}$/);
    assert.equal(requests.includes('GET /unobserved'), false);
    assert(audit.artifacts.some(item => item.name === 'unlighthouse.config.mjs'));
    assert(audit.artifacts.some(item => item.name === 'unlighthouse.log'));
    assert(audit.artifacts.every(item => path.isAbsolute(item.path)));
    const saved = JSON.parse(await readFile(audit.artifacts.find(item => item.name === 'audit.json').path, 'utf8'));
    assert.equal(saved.runId, audit.runId);
  });
});

test('route cap means partial coverage but complete native reports; null remains null', async () => {
  await fixture(async ({ origin, outputDir }) => {
    const audit = await auditSite(origin, { outputDir, allowedLocalOrigin: origin, maxPages: 99, runCli: mockCli(origin, { routes: ['/', '/app', '/about'], nullScore: true }) });
    assert.equal(audit.limits.maxPages, 3);
    assert.equal(audit.status, 'PARTIAL');
    assert.equal(audit.limits.truncated, true);
    assert.equal(audit.lab.status, 'COMPLETE');
    assert.equal(audit.lab.reports[0].categories[0].score, null);
    assert.equal(audit.lab.reports[0].observations[0].score, null);
    assert.equal(audit.lab.reports[0].observations[0].scoreDisplayMode, 'notApplicable');
  });
});

test('missing native reports and runtime errors never become complete', async () => {
  await fixture(async ({ origin, outputDir }) => {
    const missing = await auditSite(origin, { outputDir, allowedLocalOrigin: origin, runCli: mockCli(origin, { omit: ['/app'] }) });
    assert.equal(missing.status, 'PARTIAL'); assert.equal(missing.lab.status, 'PARTIAL');
    assert(missing.errors.some(error => error.stage === 'COVERAGE'));
    const failed = await auditSite(origin, { outputDir, allowedLocalOrigin: origin, runCli: mockCli(origin, { runtimeError: { code: 'NO_FCP', message: 'No content' } }) });
    assert.equal(failed.status, 'FAILED'); assert.equal(failed.pages.length, 0);
    assert(failed.errors.some(error => error.stage === 'LIGHTHOUSE'));
  });
});

test('CLI/deadline failure persists failed evidence and never invokes a fallback crawler', async () => {
  await fixture(async ({ origin, outputDir, requests }) => {
    const audit = await auditSite(origin, { outputDir, allowedLocalOrigin: origin, runCli: async () => { throw new Error('Unlighthouse timedOut=true'); } });
    assert.equal(audit.status, 'FAILED'); assert.equal(audit.lab.status, 'FAILED'); assert.equal(audit.pages.length, 0);
    assert(audit.errors.some(error => /timedOut=true/.test(error.message)));
    assert.equal(requests.includes('GET /'), false);
    assert(audit.artifacts.some(item => item.name === 'audit.json'));
  });
});

test('HTTP503 and robots exclusion block runtime admission without fabricated pages', async () => {
  await fixture(async ({ origin, outputDir }) => {
    let ran = false; const runCli = async () => { ran = true; };
    const broken = await auditSite(`${origin}/broken`, { outputDir, allowedLocalOrigin: origin, runCli });
    assert.equal(broken.status, 'FAILED'); assert.match(broken.errors[0].message, /503/);
    const denied = await auditSite(`${origin}/private`, { outputDir, allowedLocalOrigin: origin, runCli });
    assert.equal(denied.status, 'FAILED'); assert.match(denied.errors[0].message, /robots/);
    assert.equal(ran, false);
  });
});

test('explicit output directory is required and private metadata redirects stay blocked', async () => {
  await assert.rejects(auditSite('https://example.com'), /absolute evidence directory/);
  await fixture(async ({ origin, outputDir }) => {
    const audit = await auditSite(`${origin}/redirect`, { outputDir, allowedLocalOrigin: origin, runCli: async () => { throw new Error('Must not run'); } });
    assert.equal(audit.status, 'FAILED'); assert.match(audit.errors[0].message, /non-public IP/);
    await assert.rejects(fetchText(`${origin}/huge`, { allowedLocalOrigin: origin, origin, maxBytes: 100 }), /byte limit/);
  });
  for (const address of ['127.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1']) assert.equal(isPublicAddress(address), false);
  assert.equal(isPublicAddress('8.8.8.8'), true);
});

test('metadata preserves duplicates and JSON syntax errors without executing source', () => {
  const html = '<title>x</title><meta name="description" content="one"><meta name="description" content="two"><meta property="og:site_name" content="Brand"><meta name="theme-color" content="#AABBCC"><script>globalThis.executed=true</script><script type="application/ld+json">invalid</script><body>Visible text</body>';
  const metadata = extractMetadata(html), page = inspectHtml(html, 'https://example.com');
  assert.deepEqual(metadata.description, ['one', 'two']); assert(metadata.jsonLd[0].parseError);
  assert.equal(globalThis.executed, undefined); assert.equal(page.text, 'Visible text');
  assert.equal(page.siteName, 'Brand'); assert.equal(page.themeColor, '#aabbcc');
});
