import {createHash} from 'node:crypto';
import {parse} from 'csv-parse/sync';

export const LIMITS = Object.freeze({bytes: 8 * 1024 * 1024, rows: 10000, columns: 64, cellBytes: 32768, rowBytes: 131072, cells: 250000, warnings: 1000});
const sha = value => createHash('sha256').update(value).digest('hex');
const own = (o, k) => Object.hasOwn(o, k);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export class EvidenceImportError extends Error {
  constructor(code) { super(code); this.name = 'EvidenceImportError'; this.code = code; }
}
const fail = code => { throw new EvidenceImportError(code); };
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(label);
  return value;
}
function text(value, label, max = 256) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(label);
  return value;
}
function keys(value, allowed) { for (const k of Object.keys(value)) if (!allowed.includes(k)) fail('UNKNOWN_OPTION'); }
function name(value) { text(value, 'INVALID_MAPPING_NAME', 80); if (forbidden.has(value)) fail('UNSAFE_MAPPING_NAME'); return value; }
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) fail('INVALID_DATE');
  return value;
}
function metadata(input) {
  const m = object(input, 'METADATA_REQUIRED');
  keys(m, ['importId','sourceName','importedAt','observedWindow','geography','accountScope','cohort','currency','reportNote']);
  const result = {sourceName: text(m.sourceName, 'SOURCE_NAME_REQUIRED', 512), importedAt: text(m.importedAt, 'IMPORTED_AT_REQUIRED', 40), observedWindow: {}};
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(m.importedAt) || !Number.isFinite(Date.parse(m.importedAt))) fail('INVALID_IMPORTED_AT');
  date(m.importedAt.slice(0,10));
  if (m.importId !== undefined) result.importId = text(m.importId, 'INVALID_IMPORT_ID');
  if (m.observedWindow !== undefined) {
    const w = object(m.observedWindow, 'INVALID_WINDOW'); keys(w, ['start','end','timezone']);
    for (const k of ['start','end']) if (w[k] !== undefined) result.observedWindow[k] = date(w[k]);
    if (w.start && w.end && w.start > w.end) fail('REVERSED_WINDOW');
    if (w.timezone !== undefined) {
      text(w.timezone, 'INVALID_TIMEZONE', 100);
      try { new Intl.DateTimeFormat('en', {timeZone: w.timezone}); } catch { fail('INVALID_TIMEZONE'); }
      result.observedWindow.timezone = w.timezone;
    }
  }
  for (const k of ['geography','accountScope','reportNote']) if (m[k] !== undefined) result[k] = text(m[k], 'INVALID_METADATA', k === 'reportNote' ? 2000 : 256);
  if (m.currency !== undefined) { if (!/^[A-Z]{3}$/u.test(m.currency)) fail('INVALID_CURRENCY'); result.currency = m.currency; }
  if (m.cohort !== undefined) {
    object(m.cohort, 'INVALID_COHORT'); if (Object.keys(m.cohort).length > 32) fail('COHORT_LIMIT');
    result.cohort = Object.fromEntries(Object.keys(m.cohort).sort().map(k => [name(k), text(m.cohort[k], 'INVALID_COHORT', 512)]));
  }
  return result;
}
function bounds(input = {}) {
  object(input, 'INVALID_LIMITS'); keys(input, Object.keys(LIMITS));
  const out = {...LIMITS};
  for (const [k,v] of Object.entries(input)) { if (!Number.isSafeInteger(v) || v < 1 || v > LIMITS[k]) fail('INVALID_LIMITS'); out[k] = v; }
  return out;
}
function source(input, limits) {
  if (typeof input !== 'string' && !(input instanceof Uint8Array)) fail('EXPECTED_UTF8_BYTES_OR_TEXT');
  if ((typeof input === 'string' ? Buffer.byteLength(input) : input.byteLength) > limits.bytes) fail('FILE_LIMIT');
  if (typeof input === 'string' && !input.isWellFormed()) fail('INVALID_UTF8');
  const bytes = Buffer.from(input);
  let decoded; try { decoded = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); } catch { fail('INVALID_UTF8'); }
  if (decoded.includes('\u0000')) fail('NUL_UNSUPPORTED');
  return {hash: sha(bytes), decoded};
}
function warningSink(max) {
  const warnings = []; let omitted = 0;
  return {add(code, detail = {}) { if (warnings.length < max) warnings.push({code, ...detail}); else omitted++; },
    done() { return omitted ? [...warnings, {code: 'WARNINGS_TRUNCATED', omitted}] : warnings; }};
}
function csvRows(decoded, delimiter, limits) {
  const rows = []; let cells = 0; let nextLine = 1; let priorBytes = 0;
  try {
    parse(decoded, {bom: true, delimiter, record_delimiter: ['\r\n','\n','\r'], relax_column_count: true,
      max_record_size: limits.rowBytes, info: true,
      cast(value, context) {
        if (context.index >= limits.columns) fail('COLUMN_LIMIT');
        if (Buffer.byteLength(value) > limits.cellBytes) fail('CELL_SIZE_LIMIT');
        return value;
      },
      on_record({record, info}) {
        if (info.records > limits.rows + 1) fail('ROW_COUNT_LIMIT');
        if (record.length > limits.columns) fail('COLUMN_LIMIT');
        if ((cells += record.length) > limits.cells) fail('CELL_COUNT_LIMIT');
        if (info.bytes - priorBytes > limits.rowBytes) fail('ROW_SIZE_LIMIT');
        priorBytes = info.bytes;
        if (record.some(c => Buffer.byteLength(c) > limits.cellBytes)) fail('CELL_SIZE_LIMIT');
        // csv-parse counts CR and LF separately inside quotes; derive physical lines from decoded cells.
        const sourceLineEnd = nextLine + record.reduce((n,c)=>n + (c.match(/\r\n|\n|\r/gu)?.length ?? 0), 0);
        rows.push({cells: record, sourceRow: info.records, sourceLineEnd});
        nextLine = sourceLineEnd + 1;
        return null;
      }});
  } catch (e) { if (e instanceof EvidenceImportError) throw e; fail(e.code === 'CSV_MAX_RECORD_SIZE' ? 'ROW_SIZE_LIMIT' : 'MALFORMED_CSV'); }
  return rows;
}
function decimal(raw, spec, add, sourceRow) {
  const metric = {raw, value: null, status: 'MISSING', unit: spec.unit ?? null, currency: spec.currency ?? null, sourceColumn: spec.column};
  if (raw === null || raw.trim() === '') return metric;
  let value = raw.trim();
  if (spec.unit === 'percent' && value.endsWith('%')) value = value.slice(0,-1);
  if (spec.decimalSeparator === ',') {
    if (value.includes('.')) value = 'INVALID';
    value = value.replace(',', '.');
  }
  const valid = /^[+-]?\d+(?:\.\d+)?$/u.test(value) && value.replace(/[^0-9]/gu,'').length <= 80
    && !(spec.integer && value.includes('.')) && !(spec.nonnegative && value.startsWith('-'));
  if (!valid) { metric.status = 'INVALID'; add('INVALID_METRIC', {sourceRow, column: spec.column}); return metric; }
  metric.value = value; metric.status = 'PRESENT'; return metric;
}
const GSC_METRICS = Object.freeze({Clicks: {name:'clicks', unit:'count', integer:true, nonnegative:true}, Impressions: {name:'impressions', unit:'count', integer:true, nonnegative:true}, CTR: {name:'ctr', unit:'percent', nonnegative:true}, Position: {name:'position', unit:'position', nonnegative:true}});
function mappings(headers, options, kind, currency) {
  if (kind === 'GSC_CSV') {
    const query = headers.includes('Top queries') ? 'Top queries' : headers.includes('Query') ? 'Query' : null;
    if (!query || (headers.includes('Top queries') && headers.includes('Query')) || !headers.includes('Clicks') || !headers.includes('Impressions')) fail('GSC_REQUIRED_HEADERS');
    return {queryColumn: query, dimensions: {}, metrics: Object.fromEntries(Object.entries(GSC_METRICS).map(([column,s]) => [s.name, {...s, column, decimalSeparator:'.'}]))};
  }
  const mapping = object(options.mapping, 'MAPPING_REQUIRED'); keys(mapping, ['queryColumn','dimensions','metrics']);
  const queryColumn = text(mapping.queryColumn, 'QUERY_COLUMN_REQUIRED');
  if (!headers.includes(queryColumn)) fail('MAPPED_COLUMN_MISSING');
  const result = {queryColumn, dimensions: {}, metrics: {}};
  for (const type of ['dimensions','metrics']) {
    if (mapping[type] === undefined) continue;
    object(mapping[type], 'INVALID_MAPPING'); if (Object.keys(mapping[type]).length > 63) fail('MAPPING_LIMIT');
    for (const [key, v] of Object.entries(mapping[type])) {
      name(key); if (type === 'dimensions' && key === 'query') fail('RESERVED_QUERY_DIMENSION');
      if (type === 'dimensions') result.dimensions[key] = text(v, 'INVALID_COLUMN');
      else {
        object(v, 'INVALID_METRIC_MAPPING'); keys(v, ['column','unit','currency','decimalSeparator']);
        const spec = {column: text(v.column, 'INVALID_COLUMN'), decimalSeparator: v.decimalSeparator ?? '.'};
        if (!['.',','].includes(spec.decimalSeparator)) fail('INVALID_DECIMAL_SEPARATOR');
        if (v.unit !== undefined) spec.unit = text(v.unit, 'INVALID_UNIT', 80);
        if (v.currency !== undefined && (typeof v.currency !== 'string' || !/^[A-Z]{3}$/u.test(v.currency))) fail('INVALID_CURRENCY');
        if (v.currency !== undefined || currency !== undefined) spec.currency = v.currency ?? currency;
        result.metrics[key] = spec;
      }
      if (!headers.includes(type === 'dimensions' ? result.dimensions[key] : result.metrics[key].column)) fail('MAPPED_COLUMN_MISSING');
    }
  }
  const columns = [queryColumn, ...Object.values(result.dimensions), ...Object.values(result.metrics).map(s=>s.column)];
  if (new Set(columns).size !== columns.length) fail('DUPLICATE_COLUMN_MAPPING');
  return result;
}
/** Stable JSON, never an HTML fragment or spreadsheet export. Input is a generated import. */
export function serializeEvidenceImport(value) {
  const sorted = v => Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k=>[k, sorted(v[k])])) : v;
  return JSON.stringify(sorted(value)) + '\n';
}
function build(input, options, sourceKind) {
  object(options, 'OPTIONS_REQUIRED'); keys(options, ['metadata','mapping','delimiter','limits']);
  if (sourceKind !== 'QUERY_CSV' && options.mapping !== undefined) fail('MAPPING_UNSUPPORTED');
  if (sourceKind === 'QUERY_LIST' && options.delimiter !== undefined) fail('DELIMITER_UNSUPPORTED');
  const limits = bounds(options.limits), meta = metadata(options.metadata), raw = source(input, limits);
  const sink = warningSink(limits.warnings), add = sink.add;
  const result = {schemaVersion:1, ...meta, sourceKind, sourceFileSha256:raw.hash, rows:[], warnings:[]};
  if (!meta.observedWindow.start || !meta.observedWindow.end || !meta.observedWindow.timezone || !meta.accountScope || !meta.cohort || !Object.keys(meta.cohort).length) add('INCOMPLETE_COMPARISON_METADATA');
  if (sourceKind === 'GSC_CSV') add('GSC_EXPORT_LOSS', {detail:'Exported zeros may represent unavailable values; hidden queries and chart totals cannot be reconstructed.'});
  let records, headers, mapping;
  if (sourceKind === 'QUERY_LIST') {
    headers = ['query']; mapping = {queryColumn:'query', dimensions:{}, metrics:{}};
    records = [];
    const content = raw.decoded.replace(/^\uFEFF/u,'');
    const lines = /([^\r\n]*)(?:\r\n|\r|\n|$)/gu;
    for (const match of content.matchAll(lines)) {
      if (!match[0]) break;
      if (records.length >= limits.rows) fail('ROW_COUNT_LIMIT');
      records.push({cells:[match[1]], sourceRow:records.length + 1, sourceLineEnd:records.length + 1});
    }
    if (records.length > limits.rows) fail('ROW_COUNT_LIMIT');
    if (records.length > limits.cells) fail('CELL_COUNT_LIMIT');
    for (const r of records) { if (Buffer.byteLength(r.cells[0]) > limits.rowBytes) fail('ROW_SIZE_LIMIT'); if (Buffer.byteLength(r.cells[0]) > limits.cellBytes) fail('CELL_SIZE_LIMIT'); }
  } else {
    const delimiter = options.delimiter ?? ','; if (![',',';','\t'].includes(delimiter)) fail('INVALID_DELIMITER');
    const all = csvRows(raw.decoded, delimiter, limits);
    if (!all.length) fail('EMPTY_INPUT');
    headers = all.shift().cells;
    if (headers.some(h => !h.trim())) fail('BLANK_HEADER');
    if (new Set(headers.map(h=>h.trim().toLowerCase())).size !== headers.length) fail('DUPLICATE_HEADER');
    mapping = mappings(headers, options, sourceKind, meta.currency);
    records = all;
  }
  result.mapping = mapping; result.headers = headers;
  result.importId ??= `import-${sha(serializeEvidenceImport({sourceKind, sourceFileSha256:raw.hash, metadata:meta, mapping}))}`;
  const knownColumns = new Set([mapping.queryColumn, ...Object.values(mapping.dimensions), ...Object.values(mapping.metrics).map(s=>s.column)]);
  for (const column of headers) if (!knownColumns.has(column)) add('UNMAPPED_COLUMN_PRESERVED', {column});
  const seen = new Map(); let blankRows = 0;
  for (const r of records) {
    if (r.cells.length === 1 && !r.cells[0].trim()) { blankRows++; add('BLANK_ROW_SKIPPED', {sourceRow:r.sourceRow}); continue; }
    if (r.cells.length !== headers.length) fail('COLUMN_COUNT_MISMATCH');
    const get = column => { const index = headers.indexOf(column); return index < 0 ? null : r.cells[index]; };
    const dimensions = {query:get(mapping.queryColumn)};
    if (!dimensions.query.trim()) add('MISSING_QUERY', {sourceRow:r.sourceRow});
    for (const [key,column] of Object.entries(mapping.dimensions)) dimensions[key] = get(column);
    const metrics = Object.fromEntries(Object.entries(mapping.metrics).map(([key,spec])=>[key, decimal(get(spec.column), spec, add, r.sourceRow)]));
    for (let i = 0; i < r.cells.length; i++) if ((/^\s*[=+@-]/u.test(r.cells[i]) || r.cells[i].includes('<'))) add('ACTIVE_TEXT_AS_DATA', {sourceRow:r.sourceRow, column:headers[i]});
    const row = {rowId:`${result.importId}:row:${r.sourceRow}`, dimensions, metrics,
      provenance:{sourceRow:r.sourceRow, sourceLineEnd:r.sourceLineEnd, sourceFileSha256:raw.hash, sourceKind, cells:r.cells}};
    const key = sha(serializeEvidenceImport({dimensions, metrics}));
    if (seen.has(key)) add('DUPLICATE_ROW', {sourceRow:r.sourceRow, firstSourceRow:seen.get(key)}); else seen.set(key, r.sourceRow);
    result.rows.push(row);
  }
  if (!result.rows.length) fail('NO_DATA_ROWS');
  result.receipt = {inputBytes: typeof input === 'string' ? Buffer.byteLength(input) : input.byteLength, sourceDataRecords:records.length, acceptedRows:result.rows.length, blankRows};
  result.warnings = sink.done();
  return result;
}
export const importGscCsv = (input, options) => build(input, options, 'GSC_CSV');
export const importQueryCsv = (input, options) => build(input, options, 'QUERY_CSV');
export const importQueryList = (input, options) => build(input, options, 'QUERY_LIST');

/** Inclusive date windows. Unknown scope/timezone must never be treated as disjoint. No aggregation is performed. */
export function detectImportConflicts(candidate, existing) {
  if (!Array.isArray(existing) || existing.length > 1000) fail('INVALID_IMPORT_HISTORY');
  const receipt = value => {
    object(value, 'INVALID_IMPORT_RECEIPT');
    if (value.schemaVersion !== 1 || !['GSC_CSV','QUERY_CSV','QUERY_LIST'].includes(value.sourceKind) || !/^[a-f0-9]{64}$/u.test(value.sourceFileSha256)) fail('INVALID_IMPORT_RECEIPT');
    text(value.importId, 'INVALID_IMPORT_ID');
    const m = metadata({sourceName:value.sourceName, importedAt:value.importedAt, observedWindow:value.observedWindow,
      ...(value.accountScope === undefined ? {} : {accountScope:value.accountScope}), ...(value.cohort === undefined ? {} : {cohort:value.cohort})});
    return m;
  };
  const c = receipt(candidate), conflicts = [];
  if (candidate.warnings?.some(w => ['DUPLICATE_ROW','WARNINGS_TRUNCATED'].includes(w.code))) {
    conflicts.push({importId:candidate.importId, requiresReview:true, code:'ROW_WARNINGS_REQUIRE_REVIEW'});
  }
  for (const prior of existing) {
    const p = receipt(prior), detail = {importId:prior.importId, requiresReview:true};
    if (candidate.sourceFileSha256 === prior.sourceFileSha256) { conflicts.push({...detail, code:'DUPLICATE_FILE_HASH'}); continue; }
    if (candidate.importId === prior.importId) { conflicts.push({...detail, code:'IMPORT_ID_COLLISION'}); continue; }
    // Distinct providers or filters can still contain the same observations. Require review.
    const cw = c.observedWindow, pw = p.observedWindow;
    const complete = [cw.start,cw.end,cw.timezone,pw.start,pw.end,pw.timezone].every(Boolean);
    if (!complete || cw.timezone !== pw.timezone) { conflicts.push({...detail, code:'UNKNOWN_WINDOW_COMPARABILITY'}); continue; }
    if (cw.end < pw.start || pw.end < cw.start) continue;
    const sameScope = candidate.sourceKind === prior.sourceKind && c.accountScope && c.accountScope === p.accountScope
      && c.cohort && Object.keys(c.cohort).length && serializeEvidenceImport(c.cohort) === serializeEvidenceImport(p.cohort)
      && candidate.geography === prior.geography;
    conflicts.push({...detail, code:sameScope ? 'OVERLAPPING_WINDOW' : 'POTENTIAL_COHORT_OVERLAP'});
  }
  return {canCombine:conflicts.length === 0, requiresReview:conflicts.length > 0, conflicts};
}
export function assertNoImportConflicts(candidate, existing) {
  const result = detectImportConflicts(candidate, existing);
  if (!result.canCombine) fail('IMPORT_CONFLICT_REQUIRES_REVIEW');
  return result;
}
