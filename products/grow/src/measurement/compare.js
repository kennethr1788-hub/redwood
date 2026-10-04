import { createHash } from 'node:crypto';

// Pure, offline leaf. All inputs are bounded JSON data; no accounts, writes or execution.
const UNITS = { paidSpendCents: 'cents', revenueCents: 'cents', impressions: 'count', clicks: 'count', conversions: 'count' };
const TRUTH = [
  'PLANNED != ACTUAL; proposal != spend.',
  'Observed association is not causation; unequal creative delivery is not a randomized experiment.',
  'Platform attribution is not business truth. Imported evidence is not independently verified.',
  'Unspent envelope and under-planned paid spend are not profit.',
  'No predictive ROAS is calculated. Missing values are not zero.'
];
const fail = message => { throw new TypeError(message); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (v, k) => Object.hasOwn(v, k);
function text(v, name, max = 256) {
  if (typeof v !== 'string' || !v.trim() || v.length > max) fail(`${name}: nonempty text required (max ${max})`);
  return v;
}
function copy(value) {
  let nodes = 0, characters = 0;
  function visit(v, depth) {
    if (++nodes > 50000 || depth > 24) fail('JSON input exceeds structural bounds');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') { characters += v.length; if (v.length > 100000 || characters > 2000000) fail('JSON text exceeds bounds'); return v; }
    if (typeof v === 'number') { if (!Number.isFinite(v)) fail('Nonfinite JSON number'); return v; }
    if (Array.isArray(v)) return v.map(x => visit(x, depth + 1));
    if (!object(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail('Plain JSON data required');
    const result = {};
    for (const key of Object.keys(v)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('Unsafe data key');
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!own(descriptor, 'value')) fail('JSON accessors are not supported');
      result[key] = visit(descriptor.value, depth + 1);
    }
    return result;
  }
  return visit(value, 0);
}
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (object(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const hash = v => createHash('sha256').update(stable(v)).digest('hex');
const same = (a, b) => stable(a) === stable(b);
function cents(v, name, negative = false) {
  if (!Number.isSafeInteger(v) || (!negative && v < 0)) fail(`${name}: safe integer cents required`);
  return v;
}
function safe(n) { const result = Number(n); if (!Number.isSafeInteger(result)) fail('Money aggregate exceeds safe integer cents'); return result; }
function decimal(v, negative = false, integral = false) {
  // Decimal strings preserve imported fractions. No exponential notation or floating money.
  if (typeof v === 'number' && (!Number.isFinite(v) || Math.abs(v) > Number.MAX_SAFE_INTEGER)) fail('Invalid numeric value');
  if (!['string', 'number'].includes(typeof v) || !/^-?\d{1,16}(?:\.\d{1,12})?$/.test(String(v))) fail('Use a bounded decimal value');
  let s = String(v), sign = 1n;
  if (s.startsWith('-')) { sign = -1n; s = s.slice(1); }
  const [whole, fraction = ''] = s.split('.');
  const n = sign * BigInt(whole + fraction), d = 10n ** BigInt(fraction.length);
  if ((!negative && n < 0n) || (integral && n % d !== 0n)) fail('Metric sign or integer constraint violated');
  return { n, d };
}
function gcd(a, b) { a = a < 0n ? -a : a; while (b) [a, b] = [b, a % b]; return a; }
function fraction(n, d) { if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); return { n: n / g, d: d / g }; }
const add = (a, b) => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
function decimalString(r) {
  const sign = r.n < 0n ? '-' : '', n = r.n < 0n ? -r.n : r.n;
  let remainder = n % r.d, digits = '';
  while (remainder) { remainder *= 10n; digits += remainder / r.d; remainder %= r.d; }
  return sign + n / r.d + (digits ? '.' + digits : '');
}
function windowValue(v) {
  if (!object(v)) fail('window required');
  for (const k of ['start', 'end', 'timezone']) text(v[k], `window.${k}`);
  // Deliberately strict: caller normalizes dates to half-open UTC instants, with reporting zone retained.
  for (const k of ['start', 'end']) {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v[k]) || !Number.isFinite(Date.parse(v[k])) || new Date(v[k]).toISOString() !== v[k]) fail('window requires valid canonical UTC instants');
  }
  try { new Intl.DateTimeFormat('en', { timeZone: v.timezone }); } catch { fail('Invalid reporting timezone'); }
  if (v.start >= v.end) fail('window must have positive duration');
  return v;
}
function cohortValue(v) {
  if (!object(v) || !Object.keys(v).length) fail('Explicit cohort metadata required');
  // The caller supplies provider/report/account/filter/attribution identity; unknown is not comparable.
  for (const k of ['id', 'source', 'account', 'report', 'attribution']) text(v[k], `cohort.${k}`);
  return v;
}
function definitionsValue(v) {
  if (!object(v) || !own(v, 'paidSpendCents') || Object.keys(v).length > 5) fail('Metric definitions including paidSpendCents required');
  const keys = new Set();
  for (const [metric, def] of Object.entries(v)) {
    if (!own(UNITS, metric) || !object(def) || def.unit !== UNITS[metric]) fail('Unknown metric or wrong unit');
    text(def.sourceKey, 'sourceKey'); text(def.meaning, 'metric meaning', 1000);
    if (keys.has(def.sourceKey)) fail('Ambiguous metric mapping'); keys.add(def.sourceKey);
    if (typeof def.allowNegative !== 'boolean') fail('Explicit metric sign policy required');
    if (['clicks', 'impressions'].includes(metric) && def.allowNegative) fail('Clicks/impressions cannot be negative');
  }
  return v;
}
function metricValue(v, metric, def) {
  if (v === null) return null;
  if (UNITS[metric] === 'cents') return cents(v, metric, def.allowNegative);
  return decimalString(decimal(v, def.allowNegative, metric !== 'conversions'));
}
function metricsValue(values, definitions, mapped) {
  if (!object(values)) fail('Metric values required');
  const allowed = Object.entries(definitions).map(([k, d]) => mapped ? d.sourceKey : k);
  if (Object.keys(values).some(k => !allowed.includes(k))) fail('Unmapped metric value');
  return Object.fromEntries(Object.entries(definitions).map(([metric, def]) => {
    const key = mapped ? def.sourceKey : metric;
    return [metric, !own(values, key) ? null : metricValue(values[key], metric, def)];
  }));
}
const semanticDefinition = def => Object.fromEntries(Object.entries(def).filter(([k]) => k !== 'sourceKey'));

/** Wrap the unmodified R5 plan with explicit identity/reporting context. No ID derives from plan contents. */
export function createCampaignSnapshot(plan, context) {
  plan = copy(plan); context = copy(context);
  if (!object(plan) || !object(context)) fail('Plan and context required');
  text(context.campaignId, 'campaignId'); text(plan.revision, 'plan.revision');
  const b = plan.budget;
  if (!object(b)) fail('R5 budget required');
  for (const k of ['totalCents', 'paidCents', 'primaryCents', 'retargetingCents', 'reserveCents']) cents(b[k], k);
  if (BigInt(b.primaryCents) + BigInt(b.retargetingCents) !== BigInt(b.paidCents) || BigInt(b.paidCents) + BigInt(b.reserveCents) !== BigInt(b.totalCents)) fail('Plan budget does not reconcile');
  if (!/^[A-Z]{3}$/.test(b.currency) || plan.input?.currency !== b.currency) fail('Explicit consistent plan currency required');
  const metricDefinitions = definitionsValue(context.metricDefinitions);
  if (context.planned && own(context.planned, 'paidSpendCents') && context.planned.paidSpendCents !== b.paidCents) fail('Planned paid spend must match historical budget');
  const planned = metricsValue({ ...(context.planned || {}), paidSpendCents: b.paidCents }, metricDefinitions, false);
  const creativeRevisions = context.creativeRevisions || {};
  if (!object(creativeRevisions) || Object.keys(creativeRevisions).length > 100) fail('Invalid creative revisions');
  for (const [id, revision] of Object.entries(creativeRevisions)) { text(id, 'creativeId'); text(revision, 'creativeRevision'); }
  const snapshot = { schemaVersion: 1, campaignId: context.campaignId, planRevision: plan.revision, plan,
    currency: b.currency, window: windowValue(context.window), cohort: cohortValue(context.cohort),
    metricDefinitions, planned, creativeRevisions };
  return freeze({ ...snapshot, snapshotId: hash(snapshot) });
}

/** Map source-named values into the contract, retaining immutable original values and source IDs. */
export function createCampaignObservation(input) {
  const o = copy(input);
  if (!object(o)) fail('Observation required');
  for (const k of ['observationId', 'campaignId', 'planRevision']) text(o[k], k);
  if (!Array.isArray(o.sourceImportIds) || !o.sourceImportIds.length || o.sourceImportIds.length > 100) fail('Source import IDs required');
  o.sourceImportIds.forEach(id => text(id, 'sourceImportId'));
  if (new Set(o.sourceImportIds).size !== o.sourceImportIds.length) fail('Duplicate source import ID');
  if (!['COMPLETE', 'PARTIAL'].includes(o.coverage)) fail('Explicit COMPLETE/PARTIAL coverage required');
  if (!['CAMPAIGN', 'CREATIVE'].includes(o.grain)) fail('Explicit CAMPAIGN/CREATIVE grain required');
  if (o.grain === 'CREATIVE') { text(o.creativeId, 'creativeId'); text(o.creativeRevision, 'creativeRevision'); }
  else if (own(o, 'creativeId') || own(o, 'creativeRevision')) fail('Campaign totals cannot claim one creative revision');
  if (o.currency != null && !/^[A-Z]{3}$/.test(o.currency)) fail('Invalid currency');
  if (!Array.isArray(o.caveats) || o.caveats.length > 100) fail('Caveats array required');
  o.caveats.forEach(c => text(c, 'caveat', 2000));
  const definitions = definitionsValue(o.metricDefinitions);
  const rawActual = own(o, 'rawActual') ? o.rawActual : o.actual;
  const actual = metricsValue(rawActual, definitions, true);
  if (own(o, 'rawActual') && !same(o.actual, actual)) fail('Normalized observation differs from retained source values');
  return freeze({ ...o, window: windowValue(o.window), cohort: cohortValue(o.cohort),
    planned: metricsValue(o.planned, definitions, false), rawActual, actual });
}

function ratios(actual) {
  const ratio = (a, b, unit) => {
    if (actual[a] == null || actual[b] == null) return { available: false, reason: 'MISSING_VALUE', unit };
    const x = decimal(actual[a], true), y = decimal(actual[b], true);
    if (y.n <= 0n) return { available: false, reason: y.n === 0n ? 'ZERO_DENOMINATOR' : 'NEGATIVE_DENOMINATOR', unit };
    const r = fraction(x.n * y.d, x.d * y.n);
    return { available: true, numerator: String(r.n), denominator: String(r.d), unit, label: 'OBSERVED_RATIO_NOT_FORECAST' };
  };
  return { clickThroughRate: ratio('clicks', 'impressions', 'clicks/impression'),
    conversionRate: ratio('conversions', 'clicks', 'conversions/click'),
    costPerConversionCents: ratio('paidSpendCents', 'conversions', 'cents/conversion'),
    observedRevenueToSpend: ratio('revenueCents', 'paidSpendCents', 'reported revenue/paid spend') };
}

/** Compare only this frozen historical revision. Incompatibility suppresses ALL combined arithmetic. */
export function compareCampaign(snapshot, inputs, options = {}) {
  snapshot = copy(snapshot); options = copy(options);
  const expected = createCampaignSnapshot(snapshot.plan, snapshot);
  if (!same(snapshot, expected)) fail('Snapshot content/identity mismatch');
  if (!Array.isArray(inputs) || inputs.length > 1000) fail('At most 1000 observations supported');
  // Normalized observations are checked again against their retained source values.
  const observations = copy(inputs).map(input => createCampaignObservation(input));
  const reasons = [], caveats = [...TRUTH];
  const ids = new Set();
  if (!observations.length) reasons.push('NO_OBSERVATIONS');
  for (const o of observations) {
    const reason = code => reasons.push(`${code}:${o.observationId}`);
    if (ids.has(o.observationId)) reason('DUPLICATE_OBSERVATION_ID'); ids.add(o.observationId);
    if (o.campaignId !== snapshot.campaignId) reason('CAMPAIGN_MISMATCH');
    if (o.planRevision !== snapshot.planRevision) reason('PLAN_REVISION_MISMATCH');
    if (o.currency !== snapshot.currency) reason('CURRENCY_MISMATCH_OR_MISSING');
    if (!same(o.window, snapshot.window)) reason('WINDOW_MISMATCH');
    if (!same(o.cohort, snapshot.cohort)) reason('COHORT_MISMATCH');
    if (o.coverage !== 'COMPLETE') reason('PARTIAL_COVERAGE');
    if (!same(o.planned, snapshot.planned)) reason('PLANNED_BASELINE_MISMATCH');
    if (!same(Object.fromEntries(Object.entries(o.metricDefinitions).map(([k, d]) => [k, semanticDefinition(d)])),
      Object.fromEntries(Object.entries(snapshot.metricDefinitions).map(([k, d]) => [k, semanticDefinition(d)])))) reason('METRIC_DEFINITION_MISMATCH');
    if (o.grain === 'CREATIVE' && snapshot.creativeRevisions[o.creativeId] !== o.creativeRevision) reason('STALE_OR_UNKNOWN_CREATIVE_REVISION');
    caveats.push(...o.caveats);
  }
  // Equal campaign/window/cohort records cannot be added twice, even with renamed imports/IDs.
  // Distinct creative IDs are the only admitted disjoint partition in this leaf.
  for (let i = 0; i < observations.length; i++) for (let j = i + 1; j < observations.length; j++) {
    const a = observations[i], b = observations[j];
    const overlapping = a.window.start < b.window.end && b.window.start < a.window.end;
    const sameGrain = a.grain === 'CAMPAIGN' || b.grain === 'CAMPAIGN' || a.creativeId === b.creativeId;
    if (overlapping && sameGrain) reasons.push(`OVERLAPPING_OBSERVATIONS:${a.observationId}:${b.observationId}`);
  }
  if (observations.length && observations.every(o => o.grain === 'CREATIVE') &&
      !same([...new Set(observations.map(o => o.creativeId))].sort(), Object.keys(snapshot.creativeRevisions).sort())) reasons.push('INCOMPLETE_CREATIVE_COVERAGE');
  const result = { comparable: reasons.length === 0, incomparableReasons: [...new Set(reasons)], campaignId: snapshot.campaignId,
    planRevision: snapshot.planRevision, snapshotId: snapshot.snapshotId, deltas: {}, derivedMetrics: {}, observations,
    caveats: [...new Set(caveats)], outcome: 'INCONCLUSIVE' };
  if (!result.comparable) {
    if (options.adjustment != null) result.caveats.push('Adjustment withheld: evidence is incomparable.');
    return freeze(result);
  }
  const actual = Object.fromEntries(Object.keys(snapshot.metricDefinitions).map(metric => {
    if (observations.some(o => o.actual[metric] === null)) return [metric, null];
    const sum = observations.reduce((total, o) => add(total, decimal(o.actual[metric], true)), { n: 0n, d: 1n });
    return [metric, UNITS[metric] === 'cents' ? safe(sum.n / sum.d) : decimalString(sum)];
  }));
  result.actual = actual;
  result.deltas.metrics = Object.fromEntries(Object.keys(actual).map(metric => {
    if (actual[metric] === null || snapshot.planned[metric] === null) return [metric, null];
    const a = decimal(actual[metric], true), p = decimal(snapshot.planned[metric], true);
    const d = add(a, { n: -p.n, d: p.d });
    return [metric, UNITS[metric] === 'cents' ? safe(d.n / d.d) : decimalString(d)];
  }));
  const b = snapshot.plan.budget, spent = actual.paidSpendCents;
  result.deltas.budget = spent === null ? { available: false, reason: 'MISSING_PAID_SPEND' } : {
    available: true, currency: snapshot.currency, originalEnvelopeCents: b.totalCents,
    plannedPaidCents: b.paidCents, plannedReserveCents: b.reserveCents, observedPaidSpendCents: spent,
    paidSpendDeltaCents: safe(BigInt(spent) - BigInt(b.paidCents)),
    underPlannedPaidCents: safe(BigInt(b.paidCents) - BigInt(spent)),
    unspentEnvelopeCents: safe(BigInt(b.totalCents) - BigInt(spent))
  };
  result.derivedMetrics = ratios(actual);
  result.creativeMetrics = observations.filter(o => o.grain === 'CREATIVE').map(o => ({ creativeId: o.creativeId,
    creativeRevision: o.creativeRevision, observationId: o.observationId, actual: o.actual, derivedMetrics: ratios(o.actual) }));
  result.caveats.push('Budget remainder is relative to supplied paid-spend coverage only; other costs are not measured. Planned reserve is not proof of cash held.');
  if (Object.values(actual).some(v => v === null)) result.caveats.push('MISSING_METRICS: at least one partition lacks a metric; no partial sum substituted.');
  if (Object.values(actual).some(v => v !== null && decimal(v, true).n < 0n)) result.caveats.push('NEGATIVE_NET_VALUES: declared metric permits credits/refunds/reversals; review their meaning.');
  if (options.adjustment != null) {
    const a = options.adjustment;
    if (!object(a)) fail('Adjustment must be a review proposal');
    text(a.explanation, 'adjustment explanation', 2000);
    for (const k of ['primaryCents', 'retargetingCents', 'reserveCents']) cents(a[k], `remaining ${k}`);
    if (spent === null || spent < 0) fail('Adjustment needs known nonnegative observed spend');
    const remainder = BigInt(b.totalCents) - BigInt(spent);
    if (BigInt(a.primaryCents) + BigInt(a.retargetingCents) + BigInt(a.reserveCents) !== remainder || a.reserveCents < b.reserveCents) fail('Adjustment must reconcile remaining envelope and preserve planned reserve');
    const proposal = { campaignId: snapshot.campaignId, basedOnPlanRevision: snapshot.planRevision, snapshotId: snapshot.snapshotId,
      sourceObservationIds: observations.map(o => o.observationId), observationDigest: hash(observations), explanation: a.explanation,
      remainingAllocation: { primaryCents: a.primaryCents, retargetingCents: a.retargetingCents, reserveCents: a.reserveCents },
      constraints: { currency: snapshot.currency, originalEnvelopeCents: b.totalCents, observedPaidSpendCents: spent,
        remainingEnvelopeCents: safe(remainder), minimumReserveCents: b.reserveCents, execution: 'NONE', prediction: 'NONE',
        eligibility: 'NOT_VERIFIED_REQUIRES_REVIEW' },
      requiresReview: true, status: 'PROPOSED' };
    result.proposedAdjustment = { proposalId: hash(proposal), ...proposal };
  }
  return freeze(result);
}
