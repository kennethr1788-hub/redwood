import {randomUUID} from 'node:crypto';
import {digest, findingId, httpUrl} from './html-evidence.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const score = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
function document(input) {
  const raw = Buffer.isBuffer(input) ? input : Buffer.from(typeof input === 'string' ? input : JSON.stringify(input) || 'null');
  if (raw.length > 10_000_000) throw new Error('Report exceeds the 10 MB import limit.');
  return {raw, data: JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw)), hash: digest(raw), hashBasis: typeof input === 'string' || Buffer.isBuffer(input) ? 'EXACT_INPUT_BYTES' : 'JSON_SERIALIZATION'};
}
function auditState(audit, runtimeError) {
  if (runtimeError || audit.scoreDisplayMode === 'error' || audit.errorMessage) return 'ERROR';
  if (audit.scoreDisplayMode === 'notApplicable') return 'NOT_APPLICABLE';
  if (audit.scoreDisplayMode === 'manual') return 'MANUAL';
  if (audit.scoreDisplayMode === 'informative') return 'INFORMATIVE';
  if (score(audit.score) === null) return 'UNKNOWN';
  return audit.score === 1 ? 'PASS' : 'FAIL';
}

/** Native LHR ingestion only: no runner, report authenticity or current-state claim. */
export function importLighthouseReport(input, {artifactPath = null, runId = randomUUID()} = {}) {
  const doc = document(input); const report = doc.data;
  if (!object(report) || typeof report.lighthouseVersion !== 'string' || !httpUrl(report.finalDisplayedUrl || report.finalUrl) || !object(report.categories) || !object(report.audits)) {
    throw new Error('Expected a Lighthouse JSON report with lighthouseVersion, final URL, categories and audits.');
  }
  if (Object.keys(report.audits).length > 1000 || Object.keys(report.categories).length > 30) throw new Error('Report exceeds the audit/category import limit.');
  const url = httpUrl(report.finalDisplayedUrl || report.finalUrl);
  const requestedUrl = httpUrl(report.requestedUrl || report.finalUrl || report.finalDisplayedUrl);
  if (!requestedUrl) throw new Error('Lighthouse requestedUrl must be HTTP(S) without credentials.');
  const runtimeError = report.runtimeError ?? null;
  const evidenceHash = doc.hash;
  const evidenceId = `lhr-${digest(JSON.stringify([runId, artifactPath, evidenceHash]))}`;
  const observations = Object.entries(report.audits).map(([id, audit]) => {
    if (!object(audit)) throw new Error(`Malformed Lighthouse audit: ${id}`);
    return {...audit, id, score: score(audit.score), scoreDisplayMode: audit.scoreDisplayMode || 'unknown', state: auditState(audit, runtimeError), evidenceRef: {id: evidenceId, hash: evidenceHash, artifactPath, pointer: `/audits/${id.replaceAll('~', '~0').replaceAll('/', '~1')}`}};
  });
  const categories = Object.entries(report.categories).map(([id, category]) => {
    if (!object(category)) throw new Error(`Malformed Lighthouse category: ${id}`);
    return {...category, id, score: score(category.score)};
  });
  const completeness = runtimeError ? 'FAILED' : observations.some(item => ['ERROR', 'UNKNOWN'].includes(item.state)) || !observations.length || !report.requestedUrl || !Number.isFinite(Date.parse(report.fetchTime)) ? 'PARTIAL' : 'COMPLETE';
  return {
    status: 'IMPORTED', completeness, evidenceClass: 'LAB', runId, url, requestedUrl,
    finalUrl: report.finalUrl ?? null, finalDisplayedUrl: report.finalDisplayedUrl ?? null,
    createdAt: new Date().toISOString(), observedAt: typeof report.fetchTime === 'string' ? report.fetchTime : null,
    lighthouseVersion: report.lighthouseVersion, runtimeError, runWarnings: report.runWarnings ?? [], categories, observations,
    evidenceId, evidenceHash, hashBasis: doc.hashBasis, artifactPath, rawReport: report,
    findings: observations.filter(item => item.state === 'FAIL').map(item => ({id: findingId(`lighthouse:${item.id}`, requestedUrl), rule: `lighthouse:${item.id}`, severity: 'warning', url: requestedUrl, message: item.title || item.id, evidence: item.description || item.id, evidenceRef: item.evidenceRef, state: 'OPEN', recommendation: 'Review the native audit details; re-run the same audit after changing the source.'})),
    provenance: 'USER_SUPPLIED_REPORT',
    limitation: 'Imported lab evidence only; authenticity and current site state are unverified. Not field data or answer-engine visibility.',
  };
}

/** Join expanded CI routes to native reports by requestedUrl, never filename or aggregate score. */
export function importUnlighthouseRun({ciReport, reports, origin, expectedUrls, truncated, config = null, sourceRevision = null, runId = randomUUID(), exitCode = null}) {
  const base = httpUrl(origin);
  if (!base || !Array.isArray(reports) || reports.length > 100 || !Array.isArray(expectedUrls) || expectedUrls.length > 200) throw new Error('Supply an HTTP(S) origin, bounded native reports and the expected URL inventory.');
  const normalize = value => {
    const url = httpUrl(value, base);
    if (!url || new URL(url).origin !== new URL(base).origin) throw new Error('Report inventory must use same-origin HTTP(S) URLs.');
    return url;
  };
  const expected = [...new Set(expectedUrls.map(normalize))];
  if (expected.length !== expectedUrls.length || !expected.length) throw new Error('Expected URL inventory must be nonempty and unique.');
  const ci = document(ciReport);
  if (!object(ci.data) || !Array.isArray(ci.data.routes) || ci.data.routes.length > 100) throw new Error('Expected Unlighthouse jsonExpanded ci-result.json routes.');
  const errors = []; const pages = []; const byUrl = new Map(); const artifacts = new Set();
  const routes = ci.data.routes.map(route => normalize(route.path));
  if (new Set(routes).size !== routes.length) errors.push('DUPLICATE_CI_ROUTES');
  for (const entry of reports) {
    try {
      if (!object(entry)) throw new Error('Native report entry must be an object.');
      if (typeof entry.path !== 'string' || !entry.path.trim()) throw new Error('Native artifact path is required.');
      if (artifacts.has(entry.path)) errors.push(`DUPLICATE_ARTIFACT:${entry.path}`);
      artifacts.add(entry.path);
      const page = importLighthouseReport(entry.report, {artifactPath: entry.path, runId});
      normalize(page.requestedUrl); normalize(page.url);
      pages.push(page);
      if (byUrl.has(page.requestedUrl)) errors.push(`DUPLICATE_REPORT:${page.requestedUrl}`);
      else byUrl.set(page.requestedUrl, page);
    } catch (error) { errors.push(`INVALID_REPORT:${entry?.path || 'unknown'}:${error.message}`); }
  }
  const missing = expected.filter(url => !byUrl.has(url));
  const unexpected = [...byUrl.keys()].filter(url => !expected.includes(url));
  for (const url of missing) errors.push(`MISSING_REPORT:${url}`);
  for (const url of unexpected) errors.push(`UNEXPECTED_REPORT:${url}`);
  for (const url of new Set([...routes, ...byUrl.keys(), ...expected])) {
    if (!routes.includes(url) || !byUrl.has(url) || !expected.includes(url)) errors.push(`CI_REPORT_INVENTORY_MISMATCH:${url}`);
  }
  if (truncated !== false) errors.push(truncated === true ? 'ROUTE_LIMIT_OR_TRUNCATED' : 'TRUNCATION_UNKNOWN');
  if (exitCode !== null && exitCode !== 0) errors.push(`CLI_EXIT:${exitCode}`);
  for (const page of pages) if (page.completeness !== 'COMPLETE') errors.push(`${page.completeness}_REPORT:${page.requestedUrl}`);
  const usable = pages.filter(page => page.completeness !== 'FAILED' && expected.includes(page.requestedUrl));
  return {
    status: !usable.length ? 'FAILED' : errors.length ? 'PARTIAL' : 'COMPLETE', evidenceClass: 'LAB', provenance: 'USER_SUPPLIED_UNLIGHTHOUSE_RUN',
    runId, origin: new URL(base).origin, createdAt: new Date().toISOString(), config, sourceRevision, exitCode,
    coverage: {expectedUrls: expected, observedUrls: [...byUrl.keys()], expectedCount: expected.length, observedCount: byUrl.size, missing, unexpected, truncated: truncated ?? null},
    ci: {evidenceHash: ci.hash, hashBasis: ci.hashBasis, rawReport: ci.data}, pages, findings: usable.flatMap(page => page.findings), errors,
    claimBoundary: 'Imported native lab reports. COMPLETE is declared-inventory coverage only. No current deployment or fixed claim. Recheck requires fresh uncached reports, not a summary score.',
  };
}

/** A lab finding can pass only in a fresh, successful native observation of that exact audit. */
export function compareLighthouseReports(before, after, auditId) {
  const previous = before.observations.find(item => item.id === auditId);
  const current = after.observations.find(item => item.id === auditId);
  const samePage = before.requestedUrl === after.requestedUrl && before.url === after.url;
  const fresh = Number.isFinite(Date.parse(after.observedAt)) && Date.parse(after.observedAt) > Date.parse(before.observedAt) && before.evidenceHash !== after.evidenceHash;
  const comparable = object(before.rawReport.configSettings) && object(after.rawReport.configSettings) && samePage && fresh && !before.runtimeError && !after.runtimeError && before.lighthouseVersion === after.lighthouseVersion && JSON.stringify(before.rawReport.configSettings) === JSON.stringify(after.rawReport.configSettings);
  return {auditId, findingId: findingId(`lighthouse:${auditId}`, before.requestedUrl), state: comparable && previous?.state === 'FAIL' && current?.state === 'PASS' ? 'RECHECK_PASSED' : comparable && current?.state === 'FAIL' ? 'STILL_OPEN' : 'UNVERIFIED', beforeEvidence: previous?.evidenceRef ?? null, afterEvidence: current?.evidenceRef ?? null, scope: 'SUPPLIED_LAB_REPORTS_ONLY', deployedVerification: 'NOT_ESTABLISHED'};
}
