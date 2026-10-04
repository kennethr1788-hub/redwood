import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import robotsParser from 'robots-parser';
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runUnlighthouse } from './runner.js';
import ipaddr from 'ipaddr.js';
import { importLighthouseReport } from './lighthouse-report.js';
import {inspectHtml, findingsForPage, findingId} from './html-evidence.js';
export {importLighthouseReport, inspectHtml, findingsForPage};

const USER_AGENT = 'LaunchForgeGrow/1.0';
const LIMITS = { maxPages: 3, maxBytes: 1_000_000, timeoutMs: 10_000, maxRedirects: 3, maxLinksPerPage: 100, maxTextChars: 16_000 };
const host = (url) => url.hostname.replace(/^\[|\]$/g, '');

export function isPublicAddress(address) {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
    return parsed.range() === 'unicast';
  } catch { return false; }
}

function parseUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) URLs without embedded credentials are supported.');
  url.hash = '';
  return url;
}

async function resolveTarget(url, allowedLocalOrigin) {
  const hostname = host(url);
  const localFixture = allowedLocalOrigin === url.origin && ['127.0.0.1', '::1', 'localhost'].includes(hostname);
  if (localFixture) return [{ address: hostname === 'localhost' ? '127.0.0.1' : hostname, family: hostname === '::1' ? 6 : 4 }];
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new Error('Private/local destinations are blocked.');
  const addresses = await Promise.race([
    lookup(hostname, { all: true }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('DNS lookup timed out.')), 5000); timer.unref(); }),
  ]);
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('Private or non-public IP destinations are blocked.');
  return addresses;
}

/** Bounded request with pinned validated DNS; redirects are always revalidated. */
export async function fetchText(value, { allowedLocalOrigin, origin, method = 'GET', followRedirects = true, ...limits } = {}, redirects = 0) {
  const settings = { ...LIMITS, ...limits };
  const url = parseUrl(value);
  if (origin && url.origin !== origin) throw new Error('Cross-origin redirect/resource blocked.');
  const addresses = await resolveTarget(url, allowedLocalOrigin);
  const result = await new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain,application/xml,text/xml', 'Accept-Encoding': 'identity' },
      lookup: (_hostname, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
    }, (response) => {
      const chunks = []; let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > settings.maxBytes) {
          reject(new Error(`Response exceeds ${settings.maxBytes} byte limit.`));
          response.destroy();
          request.destroy();
        }
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ url: url.href, status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), bytes }));
    });
    const timer = setTimeout(() => { reject(new Error('Request timed out.')); request.destroy(); }, settings.timeoutMs);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
    request.end();
  });
  if (followRedirects && [301, 302, 303, 307, 308].includes(result.status)) {
    if (!result.headers.location || redirects >= settings.maxRedirects) throw new Error('Redirect limit exceeded or Location missing.');
    return fetchText(new URL(result.headers.location, url).href, { ...settings, allowedLocalOrigin, origin, method, followRedirects }, redirects + 1);
  }
  if (method !== 'HEAD' && result.headers['content-encoding'] && result.headers['content-encoding'] !== 'identity') throw new Error('Unexpected compressed response; audit did not decode it.');
  return result;
}

/** Find the public entry origin without reading page bodies before its robots policy. */
async function resolveEntry(start, options, evidence) {
  let current = start;
  for (let hop = 0; ; hop++) {
    const response = await fetchText(current.href, { ...options, method: 'HEAD', followRedirects: false });
    evidence.headStatus = response.status;
    if (![301, 302, 303, 307, 308].includes(response.status)) return current;
    if (!response.headers.location || hop >= options.maxRedirects) throw new Error('Entry redirect limit exceeded or Location missing.');
    const next = parseUrl(new URL(response.headers.location, current));
    evidence.redirects.push({ from: current.href, to: next.href, status: response.status, method: 'HEAD' });
    // fetchText resolves, validates and pins every next address before connecting.
    current = next;
  }
}

function absolute(value, base) { try { return parseUrl(new URL(value, base)).href; } catch { return null; } }

export function extractMetadata(html) {
  const $ = cheerio.load(html);
  return {
    title: $('title').first().text(),
    description: $('meta[name="description"]').map((_, el) => $(el).attr('content') || '').get(),
    canonical: $('link[rel="canonical"]').map((_, el) => $(el).attr('href') || '').get(),
    og: $('meta[property^="og:"]').map((_, el) => ({ property: $(el).attr('property'), content: $(el).attr('content') || '' })).get(),
    robots: $('meta[name="robots"]').map((_, el) => $(el).attr('content') || '').get(),
    jsonLd: $('script[type="application/ld+json"]').map((index, el) => {
      const raw = $(el).text();
      try { return { index, raw, parsed: JSON.parse(raw), parseError: null }; }
      catch (error) { return { index, raw, parsed: null, parseError: error.message }; }
    }).get(),
  };
}
const sha = value => createHash('sha256').update(value).digest('hex');
async function readJson(file) {
  if ((await stat(file)).size > 25_000_000) throw new Error('Native report exceeds 25 MB ingestion limit.');
  const raw = await readFile(file, 'utf8'); return { raw, data: JSON.parse(raw) };
}

export async function auditSite(value, options = {}) {
  if (!options.outputDir || !path.isAbsolute(options.outputDir)) throw new Error('Audit outputDir must be an absolute evidence directory.');
  const runId = randomUUID(), runDir = path.join(options.outputDir, `run-${runId}`), nativeDir = path.join(runDir, 'native');
  await mkdir(nativeDir, { recursive: true });
  const limits = { ...LIMITS, maxPages: Math.min(3, Math.max(1, Math.floor(Number(options.maxPages)) || 3)), deadlineMs: 180000, killGraceMs: 5000, maxConcurrency: 1, samples: 1, truncated: false };
  const result = {
    status: 'FAILED', url: String(value), requestedUrl: String(value), finalUrl: null, redirects: [], createdAt: new Date().toISOString(),
    runId, engine: 'UNLIGHTHOUSE_CLI_BUNDLED_LIGHTHOUSE', sourceRevision: options.sourceRevision || 'UNKNOWN',
    coverage: {omitted: [], partialReasons: []}, pages: [], findings: [], resources: {}, errors: [], limits, evidenceClass: 'CRAWLER', artifacts: [],
    lab: { status: 'FAILED', reports: [], expectedRoutes: [], observedRoutes: [], expectedRouteCount: 0, observedRouteCount: 0, runWarnings: [] },
    claimBoundary: 'Native Lighthouse lab observations and HTML/optional rendered DOM evidence only. No field performance, answer-engine visibility, ranking, Search Console or referral measurement is claimed. Trusted-target local tool: Unlighthouse browser egress is not sandboxed; arbitrary-site security qualification is not established.',
  };
  const add = (rule, severity, url, message, evidence, recommendation) => result.findings.push({ id: findingId(rule, url), state: 'OPEN', rule, severity, url, message, evidence, recommendation });
  const artifact = file => { if (!result.artifacts.some(item => item.path === file)) result.artifacts.push({ name: path.relative(runDir, file), path: file }); };
  let cliFailed = false, browser, context;
  try {
    const requested = parseUrl(value); result.requestedUrl = requested.href;
    const start = await resolveEntry(requested, { ...limits, allowedLocalOrigin: options.allowedLocalOrigin }, result);
    result.url = start.href; result.finalUrl = start.href;
    if (result.headStatus >= 400 && ![405, 501].includes(result.headStatus)) throw new Error(`Entry returned HTTP ${result.headStatus}; audit not started.`);
    const requestOptions = { ...limits, allowedLocalOrigin: options.allowedLocalOrigin, origin: start.origin, followRedirects: false };
    const robotsUrl = new URL('/robots.txt', start).href;
    const response = await fetchText(robotsUrl, requestOptions);
    const robots = response.status === 200 ? robotsParser(robotsUrl, response.body) : null;
    result.resources.robots = { url: robotsUrl, status: response.status, body: response.body.slice(0, 20000), sitemapUrls: robots?.getSitemaps() || [], evidenceHash: sha(response.body) };
    if (response.status === 401 || response.status === 403 || response.status >= 500) throw new Error(`Robots unavailable (HTTP ${response.status}); audit not started.`);
    if (response.status !== 200) add('robots-missing', 'info', robotsUrl, 'No robots.txt observed.', `HTTP ${response.status}`, 'Review crawler directives.');
    if (robots?.isAllowed(start.href, USER_AGENT) === false) throw new Error('Entry URL disallowed by robots.txt; audit not started.');
    const declared = robots?.getSitemaps().find(url => { try { return new URL(url).origin === start.origin; } catch { return false; } });
    const sitemapUrl = declared || new URL('/sitemap.xml', start).href;
    try {
      const sitemap = await fetchText(sitemapUrl, requestOptions);
      const $ = cheerio.load(sitemap.body, { xmlMode: true });
      result.resources.sitemap = { url: sitemapUrl, status: sitemap.status, urls: sitemap.status === 200 ? $('url > loc').map((_, el) => $(el).text()).get().slice(0, 100) : [], kind: $('sitemapindex').length ? 'index-not-expanded' : 'urlset', discoveryOwner: 'UNLIGHTHOUSE' };
      result.resources.sitemap.evidenceHash = sha(sitemap.body);
      if ($('sitemapindex').length) result.coverage.partialReasons.push('SITEMAP_INDEX_NOT_EXPANDED');
      if (sitemap.status !== 200) result.coverage.partialReasons.push('SITEMAP_UNAVAILABLE');
      if (sitemap.status === 200 && (!$('urlset, sitemapindex').length || $('url').toArray().some(el => !$(el).children('loc').text().trim()))) {
        result.coverage.partialReasons.push('SITEMAP_UNREADABLE');
        add('sitemap-unreadable', 'warning', sitemapUrl, 'Sitemap inventory is unreadable.', 'No usable urlset/index or a URL entry lacks loc.', 'Review the source sitemap.');
      }
      if ((robots?.getSitemaps() || []).length > 1) result.coverage.partialReasons.push('ADDITIONAL_SITEMAPS_NOT_INSPECTED');
      if (sitemap.status !== 200) add('sitemap-missing', 'warning', sitemapUrl, 'Sitemap not retrieved.', `HTTP ${sitemap.status}`, 'Publish an XML sitemap and reference it from robots.txt.');
    } catch (error) { result.errors.push({ url: sitemapUrl, message: error.message }); }
    const { chromium } = await import('playwright');
    const executablePath = chromium.executablePath();
    const config = {
      site: start.href, cache: false,
      scanner: { maxRoutes: limits.maxPages, samples: 1, dynamicSampling: false, ignoreI18nPages: false, crawler: true, sitemap: true, robotsTxt: true, skipJavascript: false, device: 'desktop', throttle: false },
      puppeteerOptions: { executablePath, headless: true },
      puppeteerClusterOptions: { maxConcurrency: 1, timeout: 60000, retryLimit: 0 },
      lighthouseOptions: { onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'] },
      ci: { reporter: 'jsonExpanded', buildStatic: false },
    };
    const configPath = path.join(runDir, 'unlighthouse.config.mjs'), logPath = path.join(runDir, 'unlighthouse.log');
    await writeFile(configPath, `export default ${JSON.stringify(config, null, 2)};\n`);
    await writeFile(logPath, ''); artifact(configPath); artifact(logPath);
    try { await (options.runCli || runUnlighthouse)({ config, configPath, outputDir: nativeDir, logPath, executablePath, deadlineMs: limits.deadlineMs, killGraceMs: limits.killGraceMs }); }
    catch (error) { cliFailed = true; result.errors.push({ stage: 'UNLIGHTHOUSE', message: error.message }); }
    let ci;
    try {
      const ciFile = path.join(nativeDir, 'ci-result.json'); ci = (await readJson(ciFile)).data; artifact(ciFile);
      if (!Array.isArray(ci.routes) || !ci.routes.length) throw new Error('Expanded CI report has no observed routes.');
      for (const route of ci.routes) {
        if (typeof route.path !== 'string') throw new Error('CI route is missing its path.');
        const url = parseUrl(new URL(route.path, start));
        if (url.origin !== start.origin) throw new Error('CI route escaped the admitted origin.');
        result.lab.expectedRoutes.push(url.href);
      }
      result.lab.expectedRoutes = [...new Set(result.lab.expectedRoutes)];
      if (result.lab.expectedRoutes.length > limits.maxPages) { result.errors.push({ stage: 'COVERAGE', message: 'CLI exceeded its configured route cap.' }); cliFailed = true; }
    } catch (error) { result.errors.push({ stage: 'CI_REPORT', message: error.message }); }
    const files = await readdir(nativeDir, { recursive: true });
    for (const relative of files.filter(file => /(^|\/)lighthouse\.json$/.test(file))) artifact(path.join(nativeDir, relative));
    for (const relative of files.filter(file => /(^|\/)lighthouse\.json$/.test(file)).slice(0, 4)) {
      try {
        const file = path.join(nativeDir, relative), { raw, data: lhr } = await readJson(file);
        const requestedUrl = parseUrl(lhr.requestedUrl).href, finalUrl = parseUrl(lhr.finalDisplayedUrl || lhr.finalUrl).href;
        if (new URL(requestedUrl).origin !== start.origin || new URL(finalUrl).origin !== start.origin) throw new Error('Native report URL escaped admitted origin.');
        if (!lhr.lighthouseVersion || !lhr.categories || !lhr.audits) throw new Error('Native report is incomplete.');
        const imported = importLighthouseReport(raw, {artifactPath: file, runId});
        const report = {
          configSettings: lhr.configSettings || null, evidenceId: imported.evidenceId,
          url: finalUrl, requestedUrl, finalUrl, fetchTime: lhr.fetchTime || null, version: lhr.lighthouseVersion,
          categories: imported.categories, observations: imported.observations,
          artifact: file, sha256: sha(raw), runtimeError: lhr.runtimeError || null, runWarnings: Array.isArray(lhr.runWarnings) ? lhr.runWarnings : [],
        };
        result.findings.push(...imported.findings);
        result.lab.reports.push(report); result.lab.observedRoutes.push(requestedUrl); result.lab.runWarnings.push(...report.runWarnings.map(String));
        if (report.runtimeError) result.errors.push({ url: requestedUrl, stage: 'LIGHTHOUSE', message: JSON.stringify(report.runtimeError) });
      } catch (error) { result.errors.push({ stage: 'NATIVE_REPORT', artifact: relative, message: error.message }); }
    }
    result.lab.reports.sort((a, b) => result.lab.expectedRoutes.indexOf(a.requestedUrl) - result.lab.expectedRoutes.indexOf(b.requestedUrl));
    result.lab.observedRoutes = result.lab.reports.map(report => report.requestedUrl);
    result.lab.expectedRouteCount = result.lab.expectedRoutes.length;
    result.lab.observedRouteCount = result.lab.observedRoutes.length;
    if (!result.lab.observedRouteCount || result.lab.expectedRoutes.some(url => !result.lab.observedRoutes.includes(url)) || result.lab.observedRoutes.some(url => !result.lab.expectedRoutes.includes(url)) || new Set(result.lab.observedRoutes).size !== result.lab.observedRouteCount) result.errors.push({ stage: 'COVERAGE', message: 'Native report coverage does not exactly match the CLI route inventory.' });
    // Cap reached is a coverage limit, not evidence that the whole site was scanned.
    if (result.lab.expectedRouteCount >= limits.maxPages) {
      limits.truncated = true; result.lab.runWarnings.push(`Route cap ${limits.maxPages} reached; additional coverage is unknown.`);
    }
    if (options.renderDom === true && result.lab.reports.length && !cliFailed) {
      if (options.readinessSelector !== undefined && (typeof options.readinessSelector !== 'string' || options.readinessSelector.length > 500)) throw new Error('readinessSelector must be a string up to 500 characters.');
      browser = await chromium.launch({ headless: true });
      context = await browser.newContext({ serviceWorkers: 'block' });
      await context.route('**/*', route => { try { return new URL(route.request().url()).origin === start.origin ? route.continue() : route.abort(); } catch { return route.abort(); } });
    }
    for (const report of result.lab.reports.slice(0, limits.maxPages)) {
      if (report.runtimeError || !result.lab.expectedRoutes.includes(report.requestedUrl) || cliFailed) continue;
      try {
        if (robots?.isAllowed(report.finalUrl, USER_AGENT) === false) throw new Error('Observed route is disallowed by robots.txt; extraction skipped.');
        const raw = await fetchText(report.finalUrl, requestOptions);
        if (raw.status !== 200 || !/text\/html|application\/xhtml\+xml/i.test(raw.headers['content-type'] || '')) throw new Error(`Observed route HTML unavailable (HTTP ${raw.status}).`);
        const page = inspectHtml(raw.body, report.finalUrl, raw.status, {runId, requestedUrl: report.requestedUrl, xRobotsTag: raw.headers['x-robots-tag']});
        const rawEvidence = {...page};
        Object.assign(page, { rawMetadata: extractMetadata(raw.body), renderedMetadata: null, rawSha256: sha(raw.body), renderedSha256: null, xRobotsTag: raw.headers['x-robots-tag'] || null, robotsAllowed: true, evidenceMode: 'RAW_HTML' });
        const stem = sha(report.finalUrl).slice(0, 16), rawFile = path.join(runDir, `${stem}-raw.html`);
        await writeFile(rawFile, raw.body); page.rawArtifact = rawFile;
        if (context) {
          const tab = await context.newPage();
          try {
            await tab.goto(report.finalUrl, { waitUntil: 'load', timeout: 15000 });
            if (options.readinessSelector) await tab.waitForSelector(options.readinessSelector, { state: 'attached', timeout: 5000 });
            const html = await tab.content();
            if (Buffer.byteLength(html) > limits.maxBytes) throw new Error('Rendered DOM exceeds extraction limit.');
            Object.assign(page, inspectHtml(html, report.finalUrl, raw.status, {runId, requestedUrl: report.requestedUrl, xRobotsTag: raw.headers['x-robots-tag'], evidenceKind: 'RENDERED_DOM'}), { renderedMetadata: extractMetadata(html), renderedSha256: sha(html), evidenceMode: 'RENDERED_DOM' });
            const file = path.join(runDir, `${stem}-rendered.html`); await writeFile(file, html); page.renderedArtifact = file;
          } catch (error) { result.errors.push({ url: report.finalUrl, stage: 'RENDERED_DOM', message: error.message }); }
          finally { await tab.close(); }
        }
        page.rawEvidence = rawEvidence;
        result.pages.push(page); result.findings.push(...findingsForPage(page));
      } catch (error) { result.errors.push({ url: report.finalUrl, stage: 'METADATA', message: error.message }); }
    }
    // Inventory comparison never fetches another route: Unlighthouse still owns discovery.
    const known = new Set([...(result.resources.sitemap?.urls || []), ...result.pages.flatMap(page => page.links)].map(value => absolute(value, start)).filter(url => url && new URL(url).origin === start.origin && robots?.isAllowed(url, USER_AGENT) !== false));
    result.coverage.omitted = [...known].filter(url => !result.lab.observedRoutes.includes(url));
    if (limits.truncated) result.coverage.partialReasons.push('PAGE_LIMIT');
    if (result.coverage.omitted.length) result.coverage.partialReasons.push('KNOWN_ROUTES_OMITTED');
    if (result.pages.some(page => page.linksTruncated)) result.coverage.partialReasons.push('LINK_INVENTORY_LIMIT');
    const incomplete = result.errors.length || limits.truncated || result.coverage.partialReasons.length;
    const labErrors = result.errors.some(error => ['UNLIGHTHOUSE', 'CI_REPORT', 'NATIVE_REPORT', 'COVERAGE', 'LIGHTHOUSE'].includes(error.stage));
    result.lab.status = cliFailed || !result.lab.reports.length ? 'FAILED' : labErrors ? 'PARTIAL' : 'COMPLETE';
    result.status = cliFailed || !result.pages.length ? 'FAILED' : incomplete ? 'PARTIAL' : 'COMPLETE';
  } catch (error) { result.errors.push({ url: result.url, message: error.message }); }
  finally { await context?.close().catch(() => {}); await browser?.close().catch(() => {}); }
  const summaryPath = path.join(runDir, 'audit.json'); artifact(summaryPath);
  await writeFile(summaryPath, JSON.stringify(result, null, 2) + '\n');
  return result;
}
