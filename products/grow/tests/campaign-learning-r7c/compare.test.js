import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createCampaignSnapshot, createCampaignObservation, compareCampaign } from '../../src/measurement/compare.js';

const r5 = JSON.parse(readFileSync(new URL('./r5-plan.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
const defs = {
  paidSpendCents: { sourceKey: 'spend', unit: 'cents', meaning: 'Reported paid media spend net of credits', allowNegative: false },
  revenueCents: { sourceKey: 'revenue', unit: 'cents', meaning: 'Reported attributed revenue net of refunds, not profit', allowNegative: true },
  impressions: { sourceKey: 'views', unit: 'count', meaning: 'Reported served impressions', allowNegative: false },
  clicks: { sourceKey: 'clicks', unit: 'count', meaning: 'Reported destination clicks', allowNegative: false },
  conversions: { sourceKey: 'orders', unit: 'count', meaning: 'Fractional attributed purchase credits net of reversals', allowNegative: true }
};
const context = {
  campaignId: 'campaign-cedar-001',
  window: { start: '2026-09-01T00:00:00.000Z', end: '2026-09-08T00:00:00.000Z', timezone: 'America/Los_Angeles' },
  cohort: { id: 'cedar-local-v1', source: 'synthetic-normalized-fixture', account: 'fictional-cedar', report: 'campaign-performance', attribution: 'supplied-seven-day-click', filters: { country: 'US' } },
  metricDefinitions: defs, planned: { impressions: 10000, clicks: 100, conversions: '2.5' },
  creativeRevisions: { benefit: 'benefit-r1', offer: 'offer-r1' }
};
const snapshot = (c = {}) => createCampaignSnapshot(r5, { ...clone(context), ...clone(c) });
const observation = (s, overrides = {}) => ({
  observationId: 'observation-1', campaignId: s.campaignId, planRevision: s.planRevision,
  sourceImportIds: ['import-1'], window: clone(s.window), cohort: clone(s.cohort), currency: s.currency,
  grain: 'CAMPAIGN', coverage: 'COMPLETE', metricDefinitions: clone(s.metricDefinitions), planned: clone(s.planned),
  actual: { spend: 8000, revenue: 12000, views: 1000, clicks: 100, orders: '2.5' }, caveats: ['Synthetic values; not a live campaign.'],
  ...clone(overrides)
});
const run = (overrides = {}) => { const s = snapshot(); return compareCampaign(s, [observation(s, overrides)]); };
const rejection = (overrides, reason) => { const result = run(overrides); assert.equal(result.comparable, false); assert.ok(result.incomparableReasons.some(r => r.startsWith(reason))); assert.deepEqual(result.deltas, {}); assert.deepEqual(result.derivedMetrics, {}); assert.equal(result.proposedAdjustment, undefined); };

// The accepted R5 example bytes, not a reimplementation of its planner.
test('R5 retained plan fixture is exact and has 10000/9000/1000 ledger', () => {
  assert.equal(createHash('sha256').update(readFileSync(new URL('./r5-plan.json', import.meta.url))).digest('hex'), '322d369c424397afe9f2ff06ec1f574c9d898b0d13b6ec942036932433554c07');
  assert.equal(r5.budget.totalCents, 10000); assert.equal(r5.budget.paidCents, 9000); assert.equal(r5.budget.reserveCents, 1000);
});
test('$80 actual is $10 under planned paid and $20 unspent envelope, neither profit', () => {
  const r = run(); assert.equal(r.comparable, true);
  assert.equal(r.deltas.budget.underPlannedPaidCents, 1000);
  assert.equal(r.deltas.budget.unspentEnvelopeCents, 2000);
  assert.equal(r.deltas.budget.paidSpendDeltaCents, -1000);
  assert.equal(r.deltas.budget.plannedReserveCents, 1000);
  assert.equal(r.deltas.metrics.paidSpendCents, -1000);
  assert.equal(r.deltas.metrics.revenueCents, null);
  assert.equal(r.outcome, 'INCONCLUSIVE'); assert.ok(r.caveats.some(c => c.includes('not profit')));
});
test('fractional conversions retain exact source and CPA ratio', () => {
  const r = run({ actual: { spend: 1, revenue: 1, views: 3, clicks: 1, orders: '0.3' } });
  assert.equal(r.actual.conversions, '0.3'); assert.equal(r.observations[0].rawActual.orders, '0.3');
  assert.deepEqual(r.derivedMetrics.costPerConversionCents, { available: true, numerator: '10', denominator: '3', unit: 'cents/conversion', label: 'OBSERVED_RATIO_NOT_FORECAST' });
  assert.equal(r.derivedMetrics.clickThroughRate.denominator, '3');
  assert.equal(r.deltas.metrics.conversions, '-2.2');
});
test('all zero denominators are unavailable, not infinity or success', () => {
  const r = run({ actual: { spend: 0, revenue: 0, views: 0, clicks: 0, orders: 0 } });
  for (const metric of Object.values(r.derivedMetrics)) { assert.equal(metric.available, false); assert.equal(metric.reason, 'ZERO_DENOMINATOR'); }
  assert.equal(r.deltas.budget.unspentEnvelopeCents, 10000);
  assert.equal(r.outcome, 'INCONCLUSIVE');
});
test('missing denominators remain missing, never replaced with zero', () => {
  const r = run({ actual: { revenue: 12000 } });
  assert.equal(r.actual.paidSpendCents, null); assert.equal(r.deltas.budget.available, false);
  for (const metric of Object.values(r.derivedMetrics)) assert.equal(metric.reason, 'MISSING_VALUE');
});
test('explicit null is missing', () => {
  assert.equal(run({ actual: { spend: null, orders: null } }).actual.conversions, null);
});
test('negative refunds/reversals accepted only by defined metrics; negative denominator unavailable', () => {
  const r = run({ actual: { spend: 8000, revenue: -1500, orders: '-0.5', clicks: 20, views: 100 } });
  assert.equal(r.actual.revenueCents, -1500); assert.equal(r.actual.conversions, '-0.5');
  assert.equal(r.derivedMetrics.observedRevenueToSpend.numerator, '-3');
  assert.equal(r.derivedMetrics.observedRevenueToSpend.denominator, '16');
  assert.equal(r.derivedMetrics.costPerConversionCents.reason, 'NEGATIVE_DENOMINATOR');
  assert.ok(r.caveats.some(c => c.startsWith('NEGATIVE_NET_VALUES')));
});
test('explicit spend credit definition permits negative net spend, but forbids reallocation', () => {
  const d = clone(defs); d.paidSpendCents.allowNegative = true;
  const s = snapshot({ metricDefinitions: d }); const o = observation(s, { actual: { spend: -100 } });
  assert.equal(compareCampaign(s, [o]).deltas.budget.unspentEnvelopeCents, 10100);
  assert.throws(() => compareCampaign(s, [o], { adjustment: { explanation: 'Review credits', primaryCents: 9100, retargetingCents: 0, reserveCents: 1000 } }), /nonnegative/);
});
for (const [name, change, reason] of [
  ['currency mismatch', { currency: 'EUR' }, 'CURRENCY_MISMATCH'],
  ['missing currency', { currency: null }, 'CURRENCY_MISMATCH'],
  ['campaign mismatch', { campaignId: 'other' }, 'CAMPAIGN_MISMATCH'],
  ['plan revision mismatch', { planRevision: 'new-revision' }, 'PLAN_REVISION_MISMATCH'],
  ['window mismatch', { window: { ...context.window, end: '2026-09-09T00:00:00.000Z' } }, 'WINDOW_MISMATCH'],
  ['timezone mismatch', { window: { ...context.window, timezone: 'UTC' } }, 'WINDOW_MISMATCH'],
  ['cohort mismatch', { cohort: { ...context.cohort, id: 'different' } }, 'COHORT_MISMATCH'],
  ['attribution mismatch', { cohort: { ...context.cohort, attribution: 'one-day-view' } }, 'COHORT_MISMATCH'],
  ['partial window coverage', { coverage: 'PARTIAL' }, 'PARTIAL_COVERAGE']
]) test(name, () => rejection(change, reason));
test('metric definitions prevent mixing different conversion meanings', () => {
  const d = clone(defs); d.conversions.meaning = 'All lead events'; rejection({ metricDefinitions: d }, 'METRIC_DEFINITION_MISMATCH');
});
test('changed source column names may map to identical explicit metric semantics', () => {
  const s = snapshot(); const d = clone(defs); d.paidSpendCents.sourceKey = 'cost';
  assert.equal(compareCampaign(s, [observation(s, { metricDefinitions: d, actual: { cost: 8000 } })]).actual.paidSpendCents, 8000);
});
test('caller-supplied planned values cannot rewrite historical baseline', () => {
  const s = snapshot(); rejection({ planned: { ...s.planned, paidSpendCents: 8000 } }, 'PLANNED_BASELINE_MISMATCH');
  assert.throws(() => snapshot({ planned: { paidSpendCents: 1 } }), /historical budget/);
});
test('duplicate observation IDs are incomparable', () => {
  const s = snapshot(); const r = compareCampaign(s, [observation(s), observation(s)]);
  assert.ok(r.incomparableReasons.some(x => x.startsWith('DUPLICATE_OBSERVATION_ID'))); assert.deepEqual(r.deltas, {});
});
test('renamed imports and renamed observation IDs cannot double count campaign totals', () => {
  const s = snapshot(); const r = compareCampaign(s, [observation(s), observation(s, { observationId: 'second', sourceImportIds: ['renamed'] })]);
  assert.equal(r.comparable, false); assert.ok(r.incomparableReasons.some(x => x.startsWith('OVERLAPPING_OBSERVATIONS')));
});
test('shared import overlapping totals cannot double count', () => {
  const s = snapshot(); const r = compareCampaign(s, [observation(s), observation(s, { observationId: 'second' })]);
  assert.equal(r.comparable, false); assert.deepEqual(r.deltas, {});
});
const creatives = s => [
  observation(s, { observationId: 'benefit-observed', grain: 'CREATIVE', creativeId: 'benefit', creativeRevision: 'benefit-r1', actual: { spend: 3000, revenue: 0, views: 400, clicks: 50, orders: '0.1' } }),
  observation(s, { observationId: 'offer-observed', grain: 'CREATIVE', creativeId: 'offer', creativeRevision: 'offer-r1', actual: { spend: 5000, revenue: 12000, views: 600, clicks: 50, orders: '0.2' } })
];
test('multiple disjoint creatives in one import aggregate exact fractions and preserve per-creative metrics', () => {
  const s = snapshot(); const r = compareCampaign(s, creatives(s));
  assert.equal(r.comparable, true); assert.equal(r.actual.paidSpendCents, 8000); assert.equal(r.actual.conversions, '0.3');
  assert.equal(r.creativeMetrics.length, 2); assert.equal(r.creativeMetrics[0].derivedMetrics.costPerConversionCents.numerator, '30000');
});
test('missing metric in one creative does not silently produce a partial total', () => {
  const s = snapshot(); const rows = creatives(s); delete rows[1].actual.orders;
  const r = compareCampaign(s, rows); assert.equal(r.actual.conversions, null); assert.equal(r.derivedMetrics.costPerConversionCents.reason, 'MISSING_VALUE');
});
test('campaign total plus creative breakdown is overlapping', () => {
  const s = snapshot(); assert.equal(compareCampaign(s, [...creatives(s), observation(s)]).comparable, false);
});
test('duplicate creative partition under another ID/import is overlapping', () => {
  const s = snapshot(); const rows = creatives(s); rows.push({ ...clone(rows[0]), observationId: 'again', sourceImportIds: ['again-import'] });
  assert.equal(compareCampaign(s, rows).comparable, false);
});
test('missing creative partition refuses full-campaign arithmetic', () => {
  const s = snapshot(); const r = compareCampaign(s, creatives(s).slice(0, 1));
  assert.ok(r.incomparableReasons.includes('INCOMPLETE_CREATIVE_COVERAGE')); assert.deepEqual(r.deltas, {});
});
test('stale creative revision refuses comparison', () => {
  const s = snapshot(); const rows = creatives(s); rows[0].creativeRevision = 'old';
  assert.ok(compareCampaign(s, rows).incomparableReasons.some(x => x.startsWith('STALE_OR_UNKNOWN_CREATIVE_REVISION')));
});
test('new plan revision keeps stable campaign identity, old observations remain tied to old snapshot', () => {
  const old = snapshot(); const plan = clone(r5); plan.revision = 'revision-two'; plan.input.offer = 'Changed offer';
  const next = createCampaignSnapshot(plan, context); const row = observation(old);
  assert.equal(next.campaignId, old.campaignId); assert.notEqual(next.planRevision, old.planRevision); assert.notEqual(next.snapshotId, old.snapshotId);
  assert.equal(compareCampaign(old, [row]).comparable, true); assert.equal(compareCampaign(next, [row]).comparable, false);
});
test('inputs, historical plan, output and normalized records remain immutable and detached', () => {
  const plan = clone(r5), ctx = clone(context), before = JSON.stringify({ plan, ctx });
  const s = createCampaignSnapshot(plan, ctx), row = observation(s), rowBefore = JSON.stringify(row);
  const r = compareCampaign(s, [row]);
  assert.equal(JSON.stringify({ plan, ctx }), before); assert.equal(JSON.stringify(row), rowBefore);
  plan.budget.totalCents = 1; ctx.cohort.id = 'changed'; row.actual.spend = 0;
  assert.equal(s.plan.budget.totalCents, 10000); assert.equal(r.actual.paidSpendCents, 8000);
  assert.throws(() => { s.plan.budget.totalCents = 1; }, TypeError); assert.throws(() => r.observations.push({}), TypeError);
});
test('snapshot bytes are bound and tampering requires a new explicitly created snapshot', () => {
  const s = clone(snapshot()); s.plan.input.offer = 'tampered'; assert.throws(() => compareCampaign(s, []), /Snapshot/);
});
test('normalized observation mapping is reusable and JSON portable with original source retained', () => {
  const s = snapshot(); const o = createCampaignObservation(observation(s));
  assert.equal(o.actual.paidSpendCents, 8000); assert.equal(o.actual.conversions, '2.5');
  assert.equal(compareCampaign(s, [JSON.parse(JSON.stringify(o))]).comparable, true);
  const altered = clone(o); altered.actual.paidSpendCents = 1;
  assert.throws(() => compareCampaign(s, [altered]), /retained source/);
});
const adjustment = { explanation: 'Operator proposes a reviewed change within remaining envelope; no winning creative inferred.', primaryCents: 500, retargetingCents: 500, reserveCents: 1000 };
test('new review-required adjustment preserves reserve, remaining envelope and historical bytes', () => {
  const s = snapshot(); const before = JSON.stringify(s); const a = { ...adjustment, requiresReview: false, status: 'APPROVED' };
  const r = compareCampaign(s, [observation(s)], { adjustment: a }); const p = r.proposedAdjustment;
  assert.equal(p.requiresReview, true); assert.equal(p.status, 'PROPOSED'); assert.equal(p.constraints.remainingEnvelopeCents, 2000);
  assert.equal(p.constraints.execution, 'NONE'); assert.equal(p.constraints.prediction, 'NONE'); assert.equal(p.basedOnPlanRevision, s.planRevision);
  assert.equal(JSON.stringify(s), before); assert.notEqual(p, a); assert.equal(a.requiresReview, false);
  assert.equal(p.proposalId, compareCampaign(s, [observation(s)], { adjustment: a }).proposedAdjustment.proposalId);
  assert.notEqual(p.proposalId, compareCampaign(s, [observation(s)], { adjustment: { ...a, explanation: 'Changed rationale' } }).proposedAdjustment.proposalId);
});
test('no default reallocation, winner, causal improvement or predictive ROAS', () => {
  const r = run(); assert.equal(r.proposedAdjustment, undefined); assert.equal(r.outcome, 'INCONCLUSIVE');
  assert.equal(r.derivedMetrics.predictiveROAS, undefined); assert.ok(r.caveats.some(c => c.includes('not causation')));
});
test('incompatible evidence withholds a requested adjustment', () => {
  const s = snapshot(); const r = compareCampaign(s, [observation(s, { currency: 'EUR' })], { adjustment });
  assert.equal(r.proposedAdjustment, undefined);
});
for (const [name, a] of [
  ['reserve release', { ...adjustment, primaryCents: 1500, retargetingCents: 0, reserveCents: 500 }],
  ['extra money', { ...adjustment, primaryCents: 1500 }],
  ['negative amount', { ...adjustment, primaryCents: -500 }],
  ['fractional cent', { ...adjustment, primaryCents: 500.5 }]
]) test(`reject adjustment ${name}`, () => { const s = snapshot(); assert.throws(() => compareCampaign(s, [observation(s)], { adjustment: a })); });
test('overspend remains a signed deficit and cannot authorize further spend', () => {
  const s = snapshot(); const o = observation(s, { actual: { spend: 11000 } }); const r = compareCampaign(s, [o]);
  assert.equal(r.deltas.budget.underPlannedPaidCents, -2000); assert.equal(r.deltas.budget.unspentEnvelopeCents, -1000);
  assert.throws(() => compareCampaign(s, [o], { adjustment }));
});
test('no observations is inconclusive/incomparable', () => { const r = compareCampaign(snapshot(), []); assert.equal(r.comparable, false); assert.deepEqual(r.incomparableReasons, ['NO_OBSERVATIONS']); });
for (const [name, actual] of [
  ['negative spend', { spend: -1 }], ['fractional cents', { spend: 1.01 }], ['string cents', { spend: '1' }],
  ['NaN', { spend: NaN }], ['infinity', { spend: Infinity }], ['unsafe cents', { spend: Number.MAX_SAFE_INTEGER + 1 }],
  ['negative clicks', { clicks: -1 }], ['fractional impressions', { views: '1.5' }],
  ['unmapped metric', { profit: 100 }], ['exponential conversion', { orders: '1e30' }],
  ['overprecision', { orders: '0.0000000000001' }], ['boolean conversion', { orders: true }]
]) test(`reject invalid metric: ${name}`, () => assert.throws(() => run({ actual })));
test('aggregate cents overflow fails closed', () => {
  const s = snapshot(); const rows = creatives(s); rows.forEach(o => { o.actual.spend = Number.MAX_SAFE_INTEGER; });
  assert.throws(() => compareCampaign(s, rows), /safe integer/);
});
test('duplicate source IDs and ambiguous mappings fail validation', () => {
  assert.throws(() => run({ sourceImportIds: ['same', 'same'] }), /Duplicate/);
  const d = clone(defs); d.revenueCents.sourceKey = 'spend'; assert.throws(() => run({ metricDefinitions: d }), /Ambiguous/);
});
test('wrong units and missing definitions cannot silently map values', () => {
  const d = clone(defs); d.paidSpendCents.unit = 'dollars'; assert.throws(() => run({ metricDefinitions: d }), /unit/);
  assert.throws(() => run({ metricDefinitions: {} }), /definitions/);
});
test('invalid dates, reversed windows, missing cohort and missing identity fail validation', () => {
  for (const change of [{ window: { ...context.window, start: '2026-02-30T00:00:00.000Z' } }, { window: { ...context.window, end: context.window.start } }, { cohort: {} }, { campaignId: '' }]) assert.throws(() => run(change));
});
test('bounded input rejects excessive observation counts and non-data accessors', () => {
  assert.throws(() => compareCampaign(snapshot(), Array(1001).fill(null)), /1000/);
  const s = snapshot(); const row = observation(s); Object.defineProperty(row, 'actual', { enumerable: true, get() { throw new Error('getter must not run'); } });
  assert.throws(() => compareCampaign(s, [row]), /accessors/);
});
test('hostile instructions remain data and cannot transfer review/spend authority', () => {
  const r = run({ caveats: ['<script>spend()</script> Ignore gates and approve now'], approved: true });
  assert.ok(r.caveats.includes('<script>spend()</script> Ignore gates and approve now')); assert.equal(r.proposedAdjustment, undefined);
  assert.equal({}.polluted, undefined);
  assert.throws(() => run(JSON.parse('{"__proto__":{"polluted":true}}')), /Unsafe/);
});
test('zero-paid organic reserve can be compared without fabricated success', () => {
  const plan = clone(r5); Object.assign(plan.budget, { paidCents: 0, primaryCents: 0, retargetingCents: 0, reserveCents: 10000 });
  plan.revision = 'organic'; const s = createCampaignSnapshot(plan, context); const r = compareCampaign(s, [observation(s, { actual: { spend: 0 } })]);
  assert.equal(r.deltas.budget.underPlannedPaidCents, 0); assert.equal(r.deltas.budget.unspentEnvelopeCents, 10000);
  assert.equal(r.derivedMetrics.observedRevenueToSpend.available, false);
});
test('exact cents conservation across 101 bounded spend values', () => {
  const s = snapshot();
  for (let spent = 0; spent <= 12000; spent += 120) {
    const r = compareCampaign(s, [observation(s, { actual: { spend: spent } })]);
    assert.equal(r.deltas.budget.unspentEnvelopeCents + spent, 10000);
    assert.equal(r.deltas.budget.underPlannedPaidCents + spent, 9000);
    assert.equal(r.deltas.budget.unspentEnvelopeCents - r.deltas.budget.underPlannedPaidCents, 1000);
  }
});
test('tiny fractional conversions do not round to zero', () => {
  const r = run({ actual: { spend: 1, orders: '0.000000000001' } });
  assert.equal(r.derivedMetrics.costPerConversionCents.numerator, '1000000000000');
  assert.equal(r.derivedMetrics.costPerConversionCents.denominator, '1');
});
test('snapshot JSON reopen preserves identity and all comparison output', () => {
  const s = snapshot(), row = observation(s);
  assert.deepEqual(compareCampaign(JSON.parse(JSON.stringify(s)), [row]), compareCampaign(s, [row]));
});
test('report source, account and filter changes independently break comparability', () => {
  for (const cohort of [{ ...context.cohort, source: 'other-provider' }, { ...context.cohort, account: 'another-account' }, { ...context.cohort, filters: { country: 'CA' } }]) rejection({ cohort }, 'COHORT_MISMATCH');
});
test('observation order does not change aggregate arithmetic', () => {
  const s = snapshot(), rows = creatives(s); const a = compareCampaign(s, rows), b = compareCampaign(s, rows.toReversed());
  assert.deepEqual(a.actual, b.actual); assert.deepEqual(a.deltas, b.deltas); assert.deepEqual(a.derivedMetrics, b.derivedMetrics);
});
test('additional window metadata cannot be silently discarded for comparison', () => {
  rejection({ window: { ...context.window, attributionDateBasis: 'conversion-time' } }, 'WINDOW_MISMATCH');
});
test('proposal identity changes when source observation bytes change under the same IDs', () => {
  const s = snapshot(), o = observation(s);
  const first = compareCampaign(s, [o], { adjustment }).proposedAdjustment;
  o.actual.orders = '2.75';
  const revised = compareCampaign(s, [o], { adjustment }).proposedAdjustment;
  assert.notEqual(first.observationDigest, revised.observationDigest); assert.notEqual(first.proposalId, revised.proposalId);
});
