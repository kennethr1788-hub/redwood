import {digest, compare, urlOf} from './ledger.js';

/** A bounded, pure leaf. Imports and page inventories are assertions supplied by
 * the caller, not network observations. Persist input.overrides in the eventual
 * store owner; this module never writes files or treats text as instructions. */
export const TOPIC_MAP_LIMITS = Object.freeze({imports: 50, rows: 1000, pages: 200, clusters: 200, clusterSize: 50, overrides: 200, links: 1000, associations: 1000});
const sorted = xs => [...new Set(xs)].sort(compare);
const fail = message => { throw new Error(`Topic map: ${message}`); };
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`invalid ${name}`);
  return value;
}
function list(value, name, cap) {
  if (!Array.isArray(value) || value.length > cap) fail(`${name} exceeds limit ${cap} or is not an array`);
  return value;
}
function text(value, name, cap = 500) {
  if (typeof value !== 'string' || !value.trim() || value.length > cap) fail(`invalid ${name}`);
  return value;
}
// Canonicalize bounded JSON data without coercing decimal strings, null or zero.
function data(value, depth = 0, budget = {nodes: 0, characters: 0}) {
  budget.nodes++;
  if (budget.nodes > 100000) fail('JSON node budget exceeded');
  if (typeof value === 'string') budget.characters += value.length;
  if (budget.characters > 2_000_000) fail('JSON character budget exceeded');
  if (depth > 10) fail('data nesting exceeds limit');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') { if (value.length > 20000) fail('data text exceeds limit'); return value; }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return list(value, 'data array', 1000).map(v => data(v, depth + 1, budget));
  object(value, 'JSON data');
  const keys = Object.keys(value).sort(compare);
  if (keys.length > 100) fail('data object exceeds limit');
  return Object.fromEntries(keys.map(key => [text(key, 'data key', 200), data(value[key], depth + 1, budget)]));
}
function localeOf(locale = 'und') {
  try { return Intl.getCanonicalLocales(text(locale, 'locale', 80))[0]; }
  catch { fail('invalid locale'); }
}
export function normalizeQuery(query, locale = 'und') {
  const lower = text(query, 'query').normalize('NFKC').toLocaleLowerCase(localeOf(locale)).replace(/[’‘]/gu, "'");
  // Preserve accents, negation words, numbers, apostrophes, .NET, C++ and C#.
  // Hyphens/ordinary punctuation separate words; raw text remains in variants.
  const tokens = lower.match(/(?:[+-][\p{N}]+(?:\.[\p{N}]+)*|\.[\p{L}\p{M}]+|[\p{L}\p{N}\p{M}]+(?:[.'][\p{L}\p{N}\p{M}]+)*)(?:\+{1,2}|#)?/gu) ?? [];
  if (!tokens.length) fail('query contains no terms');
  return tokens.join(' ');
}
export function queryId(query, locale = 'und') {
  return `q_${digest(JSON.stringify([localeOf(locale), normalizeQuery(query, locale)]))}`;
}
function stem(token, locale, protectedTerms) {
  if (!locale.startsWith('en') || protectedTerms.has(token)) return token;
  if (/^[a-z]{3,}ies$/.test(token)) return `${token.slice(0, -3)}y`;
  if (/^[a-z]{3,}(ches|shes|xes|zes)$/.test(token)) return token.slice(0, -2);
  if (/^[a-z]{3,}s$/.test(token) && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  if (/^[a-z]{4,}ing$/.test(token)) return token.slice(0, -3).replace(/([b-df-hj-np-tv-z])\1$/, '$1');
  return token;
}
function terms(query, protectedTerms) {
  return sorted(query.normalized.split(' ').map(t => stem(t, query.locale, protectedTerms)));
}
function similarity(a, b) {
  const bs = new Set(b), common = a.filter(t => bs.has(t)).length;
  return common / (a.length + b.length - common);
}
export function lexicalSimilarity(a, b, locale = 'und') {
  locale = localeOf(locale);
  return similarity(terms({normalized: normalizeQuery(a, locale), locale}, new Set()), terms({normalized: normalizeQuery(b, locale), locale}, new Set()));
}
function pageUrl(value) {
  const url = urlOf(text(value, 'URL', 2000));
  if (!url) fail('URL must be absolute HTTP(S) without credentials');
  const result = new URL(url); result.hash = ''; return result.href;
}
function settingsOf(input = {}) {
  object(input, 'settings');
  for (const key of Object.keys(input)) if (!['maxClusters', 'maxClusterSize', 'maxLinks', 'threshold', 'brandTerms', 'proposalBaseUrl'].includes(key)) fail(`unknown setting ${key}`);
  const result = {};
  for (const [name, cap] of [['maxClusters', 200], ['maxClusterSize', 50], ['maxLinks', 1000]]) {
    const n = input[name] ?? cap;
    if (!Number.isInteger(n) || n < 1 || n > cap) fail(`invalid ${name}`);
    result[name] = n;
  }
  result.threshold = input.threshold ?? 0.7;
  if (!Number.isFinite(result.threshold) || result.threshold < 0.5 || result.threshold > 1) fail('invalid threshold');
  result.brandTerms = sorted(list(input.brandTerms ?? [], 'brandTerms', 50).map(t => normalizeQuery(t)));
  result.proposalBaseUrl = input.proposalBaseUrl === undefined ? null : pageUrl(input.proposalBaseUrl);
  return result;
}
function evidenceOf(imports) {
  const queries = new Map(), refs = new Map(), ids = new Set(), locations = new Map();
  let count = 0;
  for (const imp of list(imports, 'imports', 50)) {
    object(imp, 'EvidenceImport');
    if (imp.schemaVersion !== 1) fail('unsupported evidence schema');
    const importId = text(imp.importId, 'importId', 200);
    if (ids.has(importId)) fail('duplicate importId');
    ids.add(importId);
    text(imp.sourceKind, 'sourceKind', 200); text(imp.sourceName, 'sourceName');
    if (!/^[a-f0-9]{64}$/.test(imp.sourceFileSha256)) fail('invalid sourceFileSha256');
    text(imp.importedAt, 'importedAt', 80);
    object(imp.observedWindow, 'observedWindow'); list(imp.warnings, 'warnings', 100);
    const rows = list(imp.rows, 'rows', 1000), rowIds = new Set();
    count += rows.length; if (count > 1000) fail('total rows exceeds limit 1000');
    for (const row of rows) {
      object(row, 'EvidenceRow'); object(row.dimensions, 'dimensions'); object(row.metrics, 'metrics'); object(row.provenance, 'provenance');
      const rowId = text(row.rowId, 'rowId', 200);
      if (rowIds.has(rowId)) fail('duplicate rowId'); rowIds.add(rowId);
      if (!Number.isSafeInteger(row.provenance.sourceRow) || row.provenance.sourceRow < 1 || row.provenance.sourceFileSha256 !== imp.sourceFileSha256 || row.provenance.sourceKind !== imp.sourceKind) fail('invalid row provenance');
      const locale = localeOf(row.dimensions.locale ?? row.dimensions.language ?? 'und');
      const raw = text(row.dimensions.query, 'dimensions.query');
      const normalized = normalizeQuery(raw, locale), id = queryId(raw, locale);
      const query = queries.get(id) ?? {queryId: id, normalized, locale, variants: [], evidenceRefs: []};
      const ref = `ev_${digest(JSON.stringify([importId, rowId]))}`;
      // Same source-row aliases remain inspectable but cannot disagree in content.
      const location = JSON.stringify([imp.sourceFileSha256, row.provenance.sourceRow]);
      const signature = JSON.stringify(data({dimensions: row.dimensions, metrics: row.metrics, sourceKind: imp.sourceKind}));
      if (locations.has(location) && locations.get(location) !== signature) fail('conflicting source row');
      locations.set(location, signature);
      query.variants.push(raw); query.evidenceRefs.push(ref); queries.set(id, query);
      refs.set(ref, {evidenceRef: ref, importId, rowId, sourceName: imp.sourceName, sourceKind: imp.sourceKind,
        sourceFileSha256: imp.sourceFileSha256, sourceRow: row.provenance.sourceRow, importedAt: imp.importedAt,
        observedWindow: imp.observedWindow, geography: imp.geography ?? null, accountScope: imp.accountScope ?? null,
        dimensions: row.dimensions, metrics: row.metrics, warnings: imp.warnings});
    }
  }
  for (const q of queries.values()) { q.variants = sorted(q.variants); q.evidenceRefs = sorted(q.evidenceRefs); }
  return {queries: [...queries.values()].sort((a, b) => compare(a.queryId, b.queryId)), refs};
}
function pagesOf(input, queryMap) {
  const pages = new Map(), ids = new Set();
  for (const record of list(input, 'pages', 200)) {
    object(record, 'page');
    if (record.kind === 'PROPOSED' || (record.status !== undefined && !(Number.isInteger(record.status) && record.status >= 200 && record.status < 400))) fail('page must be a known existing record');
    const url = pageUrl(record.url), id = text(record.id ?? `page_${digest(url)}`, 'page id', 200);
    if (ids.has(id)) fail('duplicate page id'); ids.add(id);
    const locale = localeOf(record.locale ?? 'und');
    const qids = list(record.queryIds ?? [], 'page queryIds', 1000).map(id => {
      if (!queryMap.has(id)) fail('page references unknown query'); return id;
    });
    for (const query of list(record.queries ?? [], 'page queries', 100)) {
      const id = queryId(query, locale); if (queryMap.has(id)) qids.push(id);
    }
    const title = record.title === undefined ? '' : text(record.title, 'page title');
    const links = list(record.links ?? [], 'page links', 500).map(link => {
      const value = typeof link === 'string' ? link : link?.url ?? link?.href;
      const absolute = urlOf(value, url); if (!absolute) fail('invalid page link'); return pageUrl(absolute);
    });
    const page = pages.get(url) ?? {url, recordIds: [], titles: [], queryIds: [], links: [], locales: []};
    page.recordIds.push(id); if (title) page.titles.push(title); page.queryIds.push(...qids); page.links.push(...links); page.locales.push(locale);
    pages.set(url, page);
  }
  return [...pages.values()].sort((a, b) => compare(a.url, b.url)).map(p => ({...p, recordIds: sorted(p.recordIds), titles: sorted(p.titles), queryIds: sorted(p.queryIds), links: sorted(p.links), locales: sorted(p.locales)}));
}
const clusterId = queryIds => `tc_${digest(JSON.stringify(sorted(queryIds)))}`;
function group(queryIds, previous = {}) {
  return {queryIds: sorted(queryIds), label: previous.label ?? null, intent: previous.intent ?? 'UNREVIEWED', assignments: [...(previous.assignments ?? [])], removedUrls: [...(previous.removedUrls ?? [])]};
}
function mergedMetadata(touched) {
  const labels = sorted(touched.map(g => g.label).filter(v => v !== null));
  const intents = sorted(touched.map(g => g.intent).filter(v => v !== 'UNREVIEWED'));
  if (labels.length > 1 || intents.length > 1) fail('override metadata conflict; reconcile labels/intents before merging');
  const assignments = touched.flatMap(g => g.assignments), removedUrls = sorted(touched.flatMap(g => g.removedUrls));
  if (assignments.some(a => removedUrls.includes(a.url))) fail('override URL conflict; reconcile assignments/removals before merging');
  return {label: labels[0], intent: intents[0], assignments, removedUrls};
}
function replay(groups, overrides, queryMap, pages, settings) {
  const receipts = [], opIds = new Set();
  for (const op of list(overrides, 'overrides', 200)) {
    object(op, 'override'); const id = text(op.operationId, 'operationId', 200);
    if (opIds.has(id)) fail('duplicate operationId'); opIds.add(id);
    if (!['split', 'merge', 'rename', 'setIntent', 'assignUrl', 'removeUrl'].includes(op.type)) fail('unknown override type');
    const selected = list(op.queryIds, 'override queryIds', 1000);
    if (!selected.length || sorted(selected).length !== selected.length || selected.some(q => typeof q !== 'string')) fail('invalid override selection');
    const missing = selected.filter(q => !queryMap.has(q));
    if (missing.length) { receipts.push({operationId: id, status: 'NEEDS_RECONCILIATION', missingQueryIds: sorted(missing)}); continue; }
    const set = new Set(selected), touched = groups.filter(g => g.queryIds.some(q => set.has(q)));
    let replacement;
    if (op.type === 'split') {
      const parts = list(op.groups, 'split groups', settings.maxClusters);
      if (parts.length < 2) fail('split needs at least two groups');
      const all = parts.flatMap(part => list(part.queryIds, 'split queryIds', settings.maxClusterSize));
      if (all.length !== selected.length || sorted(all).length !== all.length || all.some(q => !set.has(q))) fail('split must exactly partition selected queries');
      replacement = parts.map(part => {
        if (!part.queryIds.length) fail('empty split group');
        const inherited = touched.filter(g => g.queryIds.some(q => part.queryIds.includes(q)));
        const g = group(part.queryIds, mergedMetadata(inherited));
        if (part.label !== undefined) g.label = text(part.label, 'split label');
        if (part.intent !== undefined) g.intent = text(part.intent, 'split intent', 200);
        return g;
      });
    } else {
      // Metadata merges with conflicts require explicit human resolution.
      const g = group(selected, mergedMetadata(touched));
      if (op.type === 'rename') g.label = text(op.label, 'override label');
      if (op.type === 'setIntent') g.intent = text(op.intent, 'override intent', 200);
      if (op.type === 'assignUrl' || op.type === 'removeUrl') {
        const url = pageUrl(op.url);
        g.assignments = g.assignments.filter(a => a.url !== url);
        g.removedUrls = g.removedUrls.filter(u => u !== url);
        if (op.type === 'removeUrl') g.removedUrls.push(url);
        else {
          if (!['existing', 'proposed'].includes(op.kind)) fail('assignment kind must be existing or proposed');
          const exists = pages.some(p => p.url === url);
          if ((op.kind === 'existing') !== exists) fail('URL assignment conflicts with existing inventory');
          g.assignments.push({url, kind: op.kind});
        }
      }
      replacement = [g];
    }
    const next = groups.flatMap(g => {
      const rest = g.queryIds.filter(q => !set.has(q)); return rest.length ? [group(rest, g)] : [];
    }).concat(replacement);
    if (next.length > settings.maxClusters || next.some(g => g.queryIds.length > settings.maxClusterSize)) fail('override exceeds cluster bounds');
    groups = next;
    receipts.push({operationId: id, status: 'APPLIED'});
  }
  return {groups, receipts};
}

/** input: { imports: EvidenceImport[], pages: known page/content records[],
 * overrides?: ordered JSON operations[], settings?: bounded lexical settings }.
 * Unknown evidence URLs remain unresolved; there is no network verification. */
export function buildTopicMap(input = {}) {
  input = data(object(input, 'input'));
  if (JSON.stringify(input).length > 2_000_000) fail('input exceeds 2 MB character limit');
  const settings = settingsOf(input.settings), {queries, refs} = evidenceOf(input.imports ?? []);
  const queryMap = new Map(queries.map(q => [q.queryId, q])), pages = pagesOf(input.pages ?? [], queryMap);
  const protectedTerms = new Set(settings.brandTerms.flatMap(b => b.split(' ')));
  const tokens = new Map(queries.map(q => [q.queryId, terms(q, protectedTerms)]));
  const brands = q => settings.brandTerms.filter(b => (` ${q.normalized} `).includes(` ${b} `)).join('|');
  const compatible = (a, b) => a.locale === b.locale && brands(a) === brands(b) && similarity(tokens.get(a.queryId), tokens.get(b.queryId)) >= settings.threshold;
  let groups = [], unclusteredQueryIds = [];
  for (const query of queries) {
    // Complete-link grouping avoids transitive single-word bridges/homonyms.
    const target = groups.find(g => g.queryIds.length < settings.maxClusterSize && g.queryIds.every(id => compatible(query, queryMap.get(id))));
    if (target) target.queryIds.push(query.queryId);
    else if (groups.length < settings.maxClusters) groups.push(group([query.queryId]));
    else unclusteredQueryIds.push(query.queryId);
  }
  const replayed = replay(groups, input.overrides ?? [], queryMap, pages, settings);
  groups = replayed.groups;
  const clustered = new Set(groups.flatMap(g => g.queryIds));
  unclusteredQueryIds = queries.filter(q => !clustered.has(q.queryId)).map(q => q.queryId);
  const associations = [], unresolvedEvidenceUrls = [];
  const associate = value => {
    if (associations.length >= TOPIC_MAP_LIMITS.associations) fail('association limit exceeded; narrow the input cohort');
    associations.push(value);
  };
  for (const query of queries) {
    for (const ref of query.evidenceRefs) {
      const evidence = refs.get(ref), supplied = evidence.dimensions.page ?? evidence.dimensions.url;
      if (supplied === undefined || supplied === null || supplied === '') continue;
      const url = pageUrl(supplied);
      if (pages.some(p => p.url === url)) associate({queryId: query.queryId, url, reason: 'SUPPLIED_EVIDENCE_URL', evidenceRef: ref});
      else unresolvedEvidenceUrls.push({queryId: query.queryId, url, evidenceRef: ref});
    }
    for (const page of pages) {
      if (page.queryIds.includes(query.queryId)) associate({queryId: query.queryId, url: page.url, reason: 'SUPPLIED_PAGE_MAPPING'});
      else if (page.locales.length === 1 && page.locales[0] === query.locale && page.titles.some(title => lexicalSimilarity(query.normalized, title, query.locale) >= settings.threshold)) associate({queryId: query.queryId, url: page.url, reason: 'LEXICAL_TITLE_REVIEW'});
    }
  }
  const occupied = new Set([...pages.map(p => p.url), ...groups.flatMap(g => g.assignments.map(a => a.url))]);
  const clusters = [], coverageGaps = [], queryCoverage = [];
  for (const g of groups.sort((a, b) => compare(clusterId(a.queryIds), clusterId(b.queryIds)))) {
    const ids = sorted(g.queryIds), id = clusterId(ids), evidenceRefs = sorted(ids.flatMap(q => queryMap.get(q).evidenceRefs));
    const selected = ids.map(q => queryMap.get(q));
    const label = g.label ?? selected.map(q => q.normalized).sort(compare)[0];
    const assignedExisting = g.assignments.filter(a => a.kind === 'existing').map(a => a.url);
    const matches = associations.filter(a => ids.includes(a.queryId) && !g.removedUrls.includes(a.url));
    const existingUrls = sorted([...matches.map(a => a.url), ...assignedExisting]);
    const proposedUrls = sorted(g.assignments.filter(a => a.kind === 'proposed').map(a => a.url));
    const uncovered = [];
    for (const q of ids) {
      const urls = sorted([...matches.filter(a => a.queryId === q).map(a => a.url), ...assignedExisting]);
      queryCoverage.push({queryId: q, existingUrls: urls, status: urls.length ? 'MAPPED_REQUIRES_REVIEW' : 'UNMAPPED'});
      if (!urls.length) uncovered.push(q);
    }
    if (uncovered.length) {
      if (settings.proposalBaseUrl && !proposedUrls.length) {
        const slug = normalizeQuery(label).replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 80).replace(/^-|-$/g, '') || 'topic';
        const base = new URL(settings.proposalBaseUrl); base.search = ''; base.hash = '';
        base.pathname = `${base.pathname.replace(/\/$/, '')}/${slug}`;
        let url = base.href;
        if (occupied.has(url)) { base.pathname += `-${id.slice(3)}`; url = base.href; }
        if (!occupied.has(url) && !g.removedUrls.includes(url)) { proposedUrls.push(url); occupied.add(url); }
      }
      coverageGaps.push({clusterId: id, queryIds: uncovered, proposedUrls: sorted(proposedUrls), reason: 'NO_MAPPED_EXISTING_PAGE', reviewRequired: true});
    }
    clusters.push({clusterId: id, label, queryIds: ids, intent: g.intent, existingUrls, proposedUrls: sorted(proposedUrls), evidenceRefs,
      priorityInputs: {observations: evidenceRefs.map(ref => refs.get(ref)), aggregation: 'NONE_OVERLAP_NOT_RECONCILED'},
      notes: ['LEXICAL_GROUP_NOT_DEMAND', 'MISSING_METRIC_IS_UNKNOWN', 'COVERAGE_AND_INTENT_REQUIRE_REVIEW', ...(ids.length >= settings.maxClusterSize ? ['CLUSTER_SIZE_BOUND_REACHED'] : [])]});
  }
  const links = [];
  let omittedLinks = 0;
  for (const cluster of clusters) for (const fromUrl of cluster.existingUrls) for (const toUrl of cluster.existingUrls) {
    const from = pages.find(p => p.url === fromUrl), to = pages.find(p => p.url === toUrl);
    if (!from || !to || fromUrl === toUrl || new URL(fromUrl).origin !== new URL(toUrl).origin || from.links.includes(toUrl)) continue;
    const item = {clusterId: cluster.clusterId, fromUrl, toUrl, fromPageIds: from.recordIds, toPageIds: to.recordIds, reason: 'SHARED_TOPIC_REVIEW_CONTEXT', reviewRequired: true};
    if (links.length < settings.maxLinks) links.push(item); else omittedLinks++;
  }
  return data({schemaVersion: 1, method: 'LEXICAL_V1', settings, queries, evidence: [...refs.values()].sort((a, b) => compare(a.evidenceRef, b.evidenceRef)), clusters, pages, queryCoverage: queryCoverage.sort((a, b) => compare(a.queryId, b.queryId)),
    coverageGaps, associations: associations.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b))), unresolvedEvidenceUrls,
    pageCollisions: pages.filter(p => p.recordIds.length > 1).map(p => ({url: p.url, pageIds: p.recordIds})),
    multiPageQueries: queryCoverage.filter(q => q.existingUrls.length > 1), internalLinkOpportunities: links,
    unclusteredQueryIds, omittedLinks, overrideReceipts: replayed.receipts,
    warnings: ['Supplied metrics are retained verbatim, never summed or converted to search demand.', 'A generated cluster or proposed URL is not real demand or an existing page.', 'Lexical matches and link opportunities require human relevance review; no ranking or visibility score.']});
}

/** Return serializable input with an appended operation. The caller owns saving
 * it; building/reopening replays it. Missing selectors are reported, not guessed. */
export function appendTopicOverride(input, operation) {
  const next = data({...object(input, 'input'), overrides: [...(input.overrides ?? []), operation]});
  buildTopicMap(next); return next;
}

/** Optional future score interface only. Explicit caller invocation; never used
 * by the default builder. No built-in embeddings, models or network dependency. */
export function semanticSimilarity(texts, callback) {
  const bounded = list(texts, 'semantic texts', 200).map(t => text(t, 'semantic text'));
  if (callback === undefined) return null;
  if (typeof callback !== 'function') fail('semanticSimilarity must be a function');
  const matrix = callback(Object.freeze([...bounded]));
  if (!Array.isArray(matrix) || matrix.length !== bounded.length || matrix.some(row => !Array.isArray(row) || row.length !== bounded.length || row.some(n => !Number.isFinite(n) || n < 0 || n > 1))) fail('semanticSimilarity must return a bounded NxN score matrix');
  return matrix.map(row => [...row]);
}
