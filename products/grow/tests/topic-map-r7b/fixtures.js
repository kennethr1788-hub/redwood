// Frozen normalized EvidenceImport fixtures; no dependency on the R7A importer.
export function evidence(queries, extra = {}) {
  const hash = extra.sourceFileSha256 ?? 'a'.repeat(64);
  const sourceKind = extra.sourceKind ?? 'GENERIC_QUERY';
  return {schemaVersion: 1, importId: 'import-1', sourceName: 'Synthetic query fixture', sourceFileSha256: hash,
    sourceKind, importedAt: '2026-10-03T12:00:00-07:00', observedWindow: {start: '2026-09-01', end: '2026-09-30', timezone: 'America/Los_Angeles'}, warnings: [],
    rows: queries.map((item, i) => ({rowId: `row-${i + 1}`, dimensions: typeof item === 'string' ? {query: item, locale: 'en-US'} : {locale: 'en-US', ...item.dimensions},
      metrics: typeof item === 'string' ? {} : item.metrics ?? {}, provenance: {sourceRow: i + 2, sourceFileSha256: hash, sourceKind}})), ...extra};
}
export const frozenContract = Object.freeze({
  imports: [evidence([
    {dimensions: {query: 'Running shoes', page: 'https://example.test/shoes'}, metrics: {impressions: '120.50', clicks: 0}},
    {dimensions: {query: 'run shoe', page: 'https://example.test/training'}, metrics: {}},
    {dimensions: {query: 'Jaguar habitat'}, metrics: {}},
    {dimensions: {query: 'Jaguar repair'}, metrics: {searchVolume: null}},
    {dimensions: {query: 'C++ course'}, metrics: {searchVolume: '0', unit: 'queries/month', currency: null}},
  ])],
  pages: [{id: 'shoes', url: 'https://example.test/shoes', title: 'Running shoes', locale: 'en-US'},
    {id: 'training', url: 'https://example.test/training', title: 'Run shoe', locale: 'en-US'}],
  settings: {proposalBaseUrl: 'https://example.test/topics/'},
});
