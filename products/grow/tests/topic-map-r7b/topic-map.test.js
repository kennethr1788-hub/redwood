import test from 'node:test';
import assert from 'node:assert/strict';
import {buildTopicMap, normalizeQuery, queryId, lexicalSimilarity, appendTopicOverride, semanticSimilarity, TOPIC_MAP_LIMITS} from '../../src/content/topic-map.js';
import {evidence, frozenContract} from './fixtures.js';
const clone = value => JSON.parse(JSON.stringify(value));
const input = (queries, more = {}) => ({imports: [evidence(queries)], pages: [], ...more});
const qid = text => queryId(text, 'en-US');
const operation = (type, queryIds, rest = {}) => ({operationId: `op-${type}`, type, queryIds, ...rest});
function deepFreeze(v) { if (v && typeof v === 'object') { Object.freeze(v); Object.values(v).forEach(deepFreeze); } return v; }

test('frozen normalized contract exposes TopicCluster fields and no demand inference', () => {
  const map = buildTopicMap(frozenContract);
  assert.equal(map.schemaVersion, 1); assert.equal(map.method, 'LEXICAL_V1');
  assert.equal(map.queries.length, 5); assert.equal(map.clusters.length, 4);
  for (const c of map.clusters) for (const key of ['clusterId', 'label', 'queryIds', 'intent', 'existingUrls', 'proposedUrls', 'evidenceRefs', 'priorityInputs', 'notes']) assert.ok(Object.hasOwn(c, key));
  assert.equal(map.internalLinkOpportunities.length, 2);
  assert.equal(map.coverageGaps.length, 3);
  assert.ok(map.clusters.every(c => c.notes.includes('LEXICAL_GROUP_NOT_DEMAND')));
});
test('exact duplicates coalesce without losing source observations or wording', () => {
  const map = buildTopicMap(input(['Running shoes', 'Running shoes', 'RUNNING SHOES!']));
  assert.equal(map.queries.length, 1); assert.equal(map.clusters.length, 1);
  assert.equal(map.queries[0].evidenceRefs.length, 3);
  assert.deepEqual(map.queries[0].variants, ['RUNNING SHOES!', 'Running shoes']);
  assert.equal(map.clusters[0].priorityInputs.observations.length, 3);
});
test('English stems/variants group while raw normalized terms remain intact', () => {
  const map = buildTopicMap(input(['running shoes', 'run shoe', 'RUNNING SHOE']));
  assert.equal(map.clusters.length, 1);
  assert.equal(lexicalSimilarity('running shoes', 'run shoe', 'en-US'), 1);
  assert.equal(map.queries.find(q => q.normalized === 'running shoes').normalized, 'running shoes');
});
test('unrelated homonyms and single-word bridges do not join', () => {
  const map = buildTopicMap(input(['jaguar', 'jaguar car', 'jaguar habitat', 'java coffee', 'java programming']));
  assert.equal(map.clusters.length, 5);
});
test('complete-link grouping prevents transitive chaining', () => {
  const map = buildTopicMap(input(['alpha beta', 'alpha beta gamma', 'beta gamma'], {settings: {threshold: 0.5}}));
  assert.equal(map.clusters.length, 2);
  assert.ok(!map.clusters.some(c => c.queryIds.includes(qid('alpha beta')) && c.queryIds.includes(qid('beta gamma'))));
});
test('configured brands are protected and different brands never merge', () => {
  const map = buildTopicMap(input(['acme blue running shoes', 'apex blue running shoes', 'blue running shoes', 'Acme blue running shoe'], {settings: {brandTerms: ['Acme', 'Apex']}}));
  assert.equal(map.clusters.length, 3);
  assert.equal(map.clusters.find(c => c.queryIds.includes(qid('acme blue running shoes'))).queryIds.length, 2);
});
test('locale/case/punctuation normalize deterministically without stripping accents or special terms', () => {
  assert.equal(normalizeQuery('  CAFÉ — Shoes!! ', 'en-US'), 'café shoes');
  assert.equal(normalizeQuery('CAFE\u0301', 'en-US'), 'café');
  assert.equal(normalizeQuery('İSTANBUL', 'tr-TR'), 'istanbul');
  assert.equal(normalizeQuery('C++ C# .NET v2.1', 'en-US'), 'c++ c# .net v2.1');
  assert.notEqual(queryId('c++'), queryId('c')); assert.notEqual(queryId('c#'), queryId('c'));
  assert.notEqual(queryId('with sugar'), queryId('without sugar'));
  assert.notEqual(queryId('cafe'), queryId('café'));
  assert.equal(buildTopicMap(input([{dimensions: {query: 'chat', locale: 'en-US'}}, {dimensions: {query: 'chat', locale: 'fr-FR'}}])).clusters.length, 2);
});
test('missing demand, zero, decimal and unit/currency metadata remain distinct', () => {
  const m = buildTopicMap(input([{dimensions: {query: 'red shoes'}, metrics: {}}, {dimensions: {query: 'blue shoes'}, metrics: {searchVolume: '0'}}, {dimensions: {query: 'green shoes'}, metrics: {searchVolume: null}}, {dimensions: {query: 'gold shoes'}, metrics: {searchVolume: '1.25', unit: 'queries/month', currency: 'USD'}}]));
  const metrics = text => m.clusters.find(c => c.queryIds.includes(qid(text))).priorityInputs.observations[0].metrics;
  assert.deepEqual(metrics('red shoes'), {}); assert.equal(metrics('blue shoes').searchVolume, '0'); assert.equal(metrics('green shoes').searchVolume, null);
  assert.deepEqual(metrics('gold shoes'), {currency: 'USD', searchVolume: '1.25', unit: 'queries/month'});
  assert.ok(!JSON.stringify(m).includes('visibilityScore'));
});
test('overlapping cohorts and same-file aliases are retained but never summed', () => {
  const one = evidence([{dimensions: {query: 'shoe'}, metrics: {impressions: 10}}]);
  const alias = {...clone(one), importId: 'alias'};
  const overlap = evidence([{dimensions: {query: 'shoe'}, metrics: {impressions: 20}}], {importId: 'overlap', sourceFileSha256: 'b'.repeat(64)});
  const c = buildTopicMap({imports: [one, overlap, alias]}).clusters[0];
  assert.equal(c.priorityInputs.observations.length, 3); assert.equal(c.priorityInputs.aggregation, 'NONE_OVERLAP_NOT_RECONCILED');
  assert.ok(!Object.hasOwn(c.priorityInputs, 'total'));
});
test('existing URL collisions retain all page records and never invent a second URL', () => {
  const map = buildTopicMap(input(['shoe'], {pages: [{id: 'one', url: 'https://example.test/a#top', queryIds: [qid('shoe')]}, {id: 'two', url: 'https://example.test/a', queryIds: [qid('shoe')]}]}));
  assert.deepEqual(map.clusters[0].existingUrls, ['https://example.test/a']);
  assert.deepEqual(map.pageCollisions, [{url: 'https://example.test/a', pageIds: ['one', 'two']}]);
  assert.equal(map.internalLinkOpportunities.length, 0);
});
test('one query mapped to multiple pages is an explicit review collision', () => {
  const map = buildTopicMap(input(['shoe'], {pages: ['a', 'b'].map(id => ({id, url: `https://example.test/${id}`, queryIds: [qid('shoe')]}))}));
  assert.equal(map.multiPageQueries.length, 1); assert.equal(map.multiPageQueries[0].existingUrls.length, 2);
  assert.equal(map.internalLinkOpportunities.length, 2);
});
test('supplied unknown evidence URL is unresolved, not an existing page', () => {
  const map = buildTopicMap(input([{dimensions: {query: 'shoe', page: 'https://example.test/missing'}}]));
  assert.equal(map.unresolvedEvidenceUrls.length, 1); assert.deepEqual(map.clusters[0].existingUrls, []); assert.equal(map.coverageGaps.length, 1);
});
test('empty evidence is deterministic with no fabricated clusters or pages', () => {
  const map = buildTopicMap(); assert.deepEqual(map.clusters, []); assert.deepEqual(map.coverageGaps, []); assert.deepEqual(map.internalLinkOpportunities, []);
});
test('partial coverage does not make every query in a cluster covered', () => {
  const map = buildTopicMap(input(['running shoes', 'run shoe'], {pages: [{url: 'https://example.test/a', queryIds: [qid('running shoes')]}]}));
  assert.equal(map.clusters.length, 1); assert.equal(map.coverageGaps.length, 1); assert.deepEqual(map.coverageGaps[0].queryIds, [qid('run shoe')]);
});
test('page title matches are reviewable; page query mapping also accepts raw queries', () => {
  const map = buildTopicMap(input(['running shoes'], {pages: [{url: 'https://example.test/a', locale: 'en-US', title: 'Run shoe'}, {url: 'https://example.test/b', locale: 'en-US', queries: ['running shoes']}]}));
  assert.equal(map.associations.length, 2); assert.deepEqual(map.associations.map(a => a.reason).sort(), ['LEXICAL_TITLE_REVIEW', 'SUPPLIED_PAGE_MAPPING']);
});
test('proposed pages remain proposals and collision-safe against known URLs', () => {
  const map = buildTopicMap(input(['shoe'], {pages: [{url: 'https://example.test/topics/shoe'}], settings: {proposalBaseUrl: 'https://example.test/topics/'}}));
  const url = map.clusters[0].proposedUrls[0]; assert.ok(url.startsWith('https://example.test/topics/shoe-'));
  assert.deepEqual(map.clusters[0].existingUrls, []); assert.equal(map.internalLinkOpportunities.length, 0);
});
test('internal links only connect actual distinct same-origin records, excluding observed links', () => {
  const pages = [
    {id: 'a', url: 'https://example.test/a', queryIds: [qid('shoe')], links: [{href: '/b#part'}]},
    {id: 'b', url: 'https://example.test/b', queryIds: [qid('shoe')]},
    {id: 'c', url: 'https://elsewhere.test/c', queryIds: [qid('shoe')]},
  ];
  const map = buildTopicMap(input(['shoe'], {pages}));
  assert.equal(map.internalLinkOpportunities.length, 1);
  assert.equal(map.internalLinkOpportunities[0].fromUrl, 'https://example.test/b');
  assert.equal(map.internalLinkOpportunities[0].toUrl, 'https://example.test/a');
});
test('split/merge roundtrip preserves group membership and existing coverage', () => {
  const base = clone(frozenContract); const map = buildTopicMap(base);
  const c = map.clusters.find(c => c.queryIds.length === 2);
  const split = appendTopicOverride(base, operation('split', c.queryIds, {groups: c.queryIds.map(q => ({queryIds: [q]}))}));
  assert.equal(buildTopicMap(split).clusters.length, map.clusters.length + 1);
  const merged = appendTopicOverride(split, operation('merge', c.queryIds));
  assert.deepEqual(buildTopicMap(merged).clusters, map.clusters);
});
test('rename, intent and existing URL human assignments replay after JSON reopen', () => {
  let base = input(['running shoes', 'run shoe'], {pages: [{id: 'guide', url: 'https://example.test/guide'}]});
  const ids = buildTopicMap(base).clusters[0].queryIds;
  base = appendTopicOverride(base, operation('rename', ids, {label: 'Human label'}));
  base = appendTopicOverride(base, operation('setIntent', ids, {intent: 'INFORMATIONAL'}));
  base = appendTopicOverride(base, operation('assignUrl', ids, {kind: 'existing', url: 'https://example.test/guide'}));
  const map = buildTopicMap(clone(base));
  assert.equal(map.clusters[0].label, 'Human label'); assert.equal(map.clusters[0].intent, 'INFORMATIONAL'); assert.equal(map.coverageGaps.length, 0);
  assert.ok(map.overrideReceipts.every(r => r.status === 'APPLIED'));
});
test('overrides remain stable when row IDs/order change or more related queries arrive', () => {
  const base = input(['running shoes', 'run shoe']); const ids = buildTopicMap(base).clusters[0].queryIds;
  const saved = appendTopicOverride(base, operation('rename', ids, {label: 'Chosen label'}));
  saved.imports = [evidence(['running shoe', 'RUNNING SHOES', 'run shoe'])];
  const map = buildTopicMap(saved), chosen = map.clusters.find(c => c.label === 'Chosen label');
  assert.deepEqual(chosen.queryIds, ids); assert.equal(map.clusters.length, 2);
});
test('split membership survives recomputation despite lexical default grouping', () => {
  const base = input(['running shoes', 'run shoe']); const ids = buildTopicMap(base).clusters[0].queryIds;
  const saved = appendTopicOverride(base, operation('split', ids, {groups: ids.map(q => ({queryIds: [q]}))}));
  assert.equal(buildTopicMap(clone(saved)).clusters.length, 2);
});
test('split and merge preserve previously assigned URL and intent', () => {
  let base = input(['running shoes', 'run shoe'], {pages: [{url: 'https://example.test/a'}]}); const ids = buildTopicMap(base).clusters[0].queryIds;
  base = appendTopicOverride(base, operation('setIntent', ids, {intent: 'EDITORIAL'}));
  base = appendTopicOverride(base, operation('assignUrl', ids, {url: 'https://example.test/a', kind: 'existing'}));
  const before = buildTopicMap(base).clusters;
  base = appendTopicOverride(base, operation('split', ids, {groups: ids.map(q => ({queryIds: [q]}))}));
  base = appendTopicOverride(base, operation('merge', ids));
  assert.deepEqual(buildTopicMap(base).clusters, before);
});
test('remove existing URL outranks title heuristic and evidence mapping on reopen', () => {
  let base = input([{dimensions: {query: 'shoe', page: 'https://example.test/a'}}], {pages: [{url: 'https://example.test/a', title: 'shoe', locale: 'en-US'}]});
  base = appendTopicOverride(base, operation('removeUrl', [qid('shoe')], {url: 'https://example.test/a'}));
  const map = buildTopicMap(clone(base)); assert.deepEqual(map.clusters[0].existingUrls, []); assert.equal(map.coverageGaps.length, 1);
});
test('assign/remove proposed URL never produces a real page or link', () => {
  let base = input(['shoe']);
  base = appendTopicOverride(base, operation('assignUrl', [qid('shoe')], {url: 'https://example.test/proposed', kind: 'proposed'}));
  assert.deepEqual(buildTopicMap(base).clusters[0].proposedUrls, ['https://example.test/proposed']);
  base = appendTopicOverride(base, operation('removeUrl', [qid('shoe')], {url: 'https://example.test/proposed'}));
  assert.deepEqual(buildTopicMap(base).clusters[0].proposedUrls, []);
  assert.equal(buildTopicMap(base).internalLinkOpportunities.length, 0);
});
test('removing an automatic proposal suppresses that proposal across recomputation', () => {
  const base = input(['shoe'], {settings: {proposalBaseUrl: 'https://example.test/'}});
  const url = buildTopicMap(base).clusters[0].proposedUrls[0];
  const saved = appendTopicOverride(base, operation('removeUrl', [qid('shoe')], {url}));
  assert.deepEqual(buildTopicMap(saved).clusters[0].proposedUrls, []);
});
test('missing override query IDs surface reconciliation without silently retargeting', () => {
  const base = input(['shoe'], {overrides: [operation('rename', [qid('gone')], {label: 'Do not guess'})]});
  const map = buildTopicMap(base); assert.equal(map.overrideReceipts[0].status, 'NEEDS_RECONCILIATION'); assert.equal(map.clusters[0].label, 'shoe');
});
test('invalid splits, unknown types, duplicate operations and impossible URL assignments reject', () => {
  const base = input(['shoe', 'hat']); const ids = [qid('shoe'), qid('hat')];
  const cases = [operation('split', ids, {groups: [{queryIds: [ids[0]]}, {queryIds: [ids[0]]}]}), operation('oops', ids), operation('assignUrl', ids, {kind: 'existing', url: 'https://example.test/unknown'})];
  for (const op of cases) assert.throws(() => appendTopicOverride(base, op));
  const op = operation('rename', [ids[0]], {label: 'name'});
  assert.throws(() => buildTopicMap({...base, overrides: [op, op]}), /duplicate operationId/);
  assert.throws(() => appendTopicOverride({...base, pages: [{url: 'https://example.test/a'}]}, operation('assignUrl', ids, {kind: 'proposed', url: 'https://example.test/a'})));
});
test('conflicting human metadata cannot be silently erased by merge', () => {
  let base = input(['shoe', 'hat']);
  base = appendTopicOverride(base, operation('rename', [qid('shoe')], {label: 'Footwear'}));
  base = appendTopicOverride(base, {...operation('rename', [qid('hat')], {label: 'Headwear'}), operationId: 'rename-hat'});
  assert.throws(() => appendTopicOverride(base, operation('merge', [qid('shoe'), qid('hat')])), /metadata conflict/);
});
test('row/import/page/key ordering yields byte-identical deterministic output', () => {
  const base = clone(frozenContract);
  base.imports.push(evidence(['zebra'], {importId: 'second', sourceFileSha256: 'b'.repeat(64)}));
  const reverseKeys = v => Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v;
  const shuffled = reverseKeys(clone(base)); shuffled.imports.reverse(); shuffled.imports.forEach(i => i.rows.reverse()); shuffled.pages.reverse();
  assert.equal(JSON.stringify(buildTopicMap(shuffled)), JSON.stringify(buildTopicMap(base)));
});
test('bounded clustering reports overflow without losing queries or evidence', () => {
  const map = buildTopicMap(input(['apple', 'chair', 'planet'], {settings: {maxClusters: 2, maxClusterSize: 1}}));
  assert.equal(map.clusters.length, 2); assert.equal(map.queries.length, 3); assert.equal(map.unclusteredQueryIds.length, 1);
  assert.equal(TOPIC_MAP_LIMITS.rows, 1000);
});
test('size bound partitions related variants; human operations cannot bypass bounds', () => {
  const base = input(['run shoes', 'running shoes'], {settings: {maxClusterSize: 1}});
  assert.equal(buildTopicMap(base).clusters.length, 2);
  assert.throws(() => appendTopicOverride(base, operation('merge', [qid('run shoes'), qid('running shoes')])), /bounds/);
});
test('link opportunities are capped with explicit omitted count', () => {
  const map = buildTopicMap(input(['shoe'], {pages: ['a', 'b', 'c'].map(id => ({id, url: `https://example.test/${id}`, queryIds: [qid('shoe')]})), settings: {maxLinks: 2}}));
  assert.equal(map.internalLinkOpportunities.length, 2); assert.equal(map.omittedLinks, 4);
});
test('empty/oversize/invalid evidence and nonfinite metrics fail without coercion', () => {
  assert.throws(() => normalizeQuery('!!!')); assert.throws(() => normalizeQuery('x'.repeat(501)));
  assert.throws(() => buildTopicMap(input(['x'], {settings: {maxClusters: 201}})));
  assert.throws(() => buildTopicMap(input([{dimensions: {query: 'shoe'}, metrics: {volume: NaN}}])));
  assert.throws(() => buildTopicMap(input(Array(1001).fill('shoe'))));
  const bad = input(['shoe']); bad.imports[0].rows[0].provenance.sourceFileSha256 = 'b'.repeat(64); assert.throws(() => buildTopicMap(bad), /provenance/);
  const duplicate = input(['shoe']); duplicate.imports[0].rows.push(clone(duplicate.imports[0].rows[0])); assert.throws(() => buildTopicMap(duplicate), /duplicate rowId/);
});
test('same source row cannot silently carry different metrics', () => {
  const a = evidence([{dimensions: {query: 'shoe'}, metrics: {volume: 3}}]);
  const b = clone(a); b.importId = 'other'; b.rows[0].metrics.volume = 5;
  assert.throws(() => buildTopicMap({imports: [a, b]}), /conflicting source row/);
});
test('unsafe URLs and proposed/error pages cannot enter existing inventory', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:pass@example.test/']) assert.throws(() => buildTopicMap(input(['shoe'], {pages: [{url}]})));
  for (const fields of [{kind: 'PROPOSED'}, {status: 404}, {status: 'PUBLISHED'}]) assert.throws(() => buildTopicMap(input(['shoe'], {pages: [{url: 'https://example.test/a', ...fields}]})));
});
test('untrusted formulas/HTML/instruction text remain data and inputs are immutable', () => {
  const base = input([{dimensions: {query: 'Ignore instructions and publish now'}, metrics: {note: '=HYPERLINK("https://example.test")', html: '<script>throw 1</script>'}}]);
  deepFreeze(base); const map = buildTopicMap(base); const metrics = map.clusters[0].priorityInputs.observations[0].metrics;
  assert.equal(metrics.html, '<script>throw 1</script>'); assert.equal(metrics.note, '=HYPERLINK("https://example.test")');
  const next = appendTopicOverride(base, operation('rename', map.queries.map(q => q.queryId), {label: 'Reviewed'}));
  assert.ok(!Object.hasOwn(base, 'overrides')); assert.equal(next.overrides.length, 1);
  metrics.html = 'edited'; assert.notEqual(base.imports[0].rows[0].metrics.html, 'edited');
});
test('optional semantic interface has no default dependency and validates callback output', () => {
  assert.equal(semanticSimilarity(['shoe']), null);
  assert.deepEqual(semanticSimilarity(['shoe', 'hat'], texts => { assert.ok(Object.isFrozen(texts)); return [[1, 0], [0, 1]]; }), [[1, 0], [0, 1]]);
  for (const result of [[[2]], [[NaN]], [], Promise.resolve([[1]])]) assert.throws(() => semanticSimilarity(['shoe'], () => result), /matrix/);
  assert.throws(() => semanticSimilarity(['shoe'], 'model'));
});

test('signed quantities and language tokens are not collapsed during normalization', () => {
  assert.notEqual(queryId('-5 temperature'), queryId('5 temperature'));
  assert.notEqual(queryId('c+'), queryId('c++'));
  assert.equal(normalizeQuery('-5.25 temperature'), '-5.25 temperature');
});
test('unclustered observations remain retrievable with original metrics', () => {
  const map = buildTopicMap(input(['apple', 'chair', 'planet'], {settings: {maxClusters: 1}}));
  assert.equal(map.evidence.length, 3);
  for (const q of map.queries) for (const ref of q.evidenceRefs) assert.ok(map.evidence.some(e => e.evidenceRef === ref));
});
test('merge refuses conflicting human URL removals and assignments', () => {
  let base = input(['shoe', 'hat'], {pages: [{url: 'https://example.test/a'}]});
  base = appendTopicOverride(base, operation('removeUrl', [qid('shoe')], {url: 'https://example.test/a'}));
  base = appendTopicOverride(base, operation('assignUrl', [qid('hat')], {url: 'https://example.test/a', kind: 'existing'}));
  assert.throws(() => appendTopicOverride(base, operation('merge', [qid('shoe'), qid('hat')])), /URL conflict/);
});
test('dense page mappings fail at explicit association bound', () => {
  const queries = Array.from({length: 20}, (_, i) => `query ${i}`);
  const pages = Array.from({length: 51}, (_, i) => ({id: `page-${i}`, url: `https://example.test/${i}`, queryIds: queries.map(qid)}));
  assert.throws(() => buildTopicMap(input(queries, {pages})), /association limit/);
});
test('ordered overrides intentionally use last action and remain separate from sorted evidence', () => {
  const base = input(['shoe'], {overrides: [operation('rename', [qid('shoe')], {label: 'First'}), {...operation('rename', [qid('shoe')], {label: 'Last'}), operationId: 'second'}]});
  assert.equal(buildTopicMap(base).clusters[0].label, 'Last');
  base.overrides.reverse(); assert.equal(buildTopicMap(base).clusters[0].label, 'First');
});
test('1000-query maximum returns all evidence with bounded lexical work', () => {
  const map = buildTopicMap(input(Array.from({length: 1000}, (_, i) => `distinct${i}`)));
  assert.equal(map.queries.length, 1000); assert.equal(map.evidence.length, 1000); assert.equal(map.clusters.length, 200); assert.equal(map.unclusteredQueryIds.length, 800);
});
