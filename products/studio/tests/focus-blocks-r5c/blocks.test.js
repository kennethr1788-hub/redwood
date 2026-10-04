import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FOCUS_LIMITS, validateFocusBlocks as validate, validateRatioOverride,
  resolveFocusAtSourceTime as resolve, clipFocusBlocksToRanges as clip,
  clipFocusBlocksToRangeSet, proposeFocusBlocksFromEvents as propose,
} from '../../src/focus/blocks.js';
const block = (overrides = {}) => ({ id: 'a', sourceStartMs: 1000, sourceEndMs: 3000, target: { x: .5, y: .5 }, zoom: 1.35, easing: 'easeInOutCubic', enabled: true, cursorPolicy: 'preserve', ...overrides });
const rangeSet = (spans, duration = 10000) => ({ schemaVersion: 1, sourceDurationMs: duration, ranges: spans.map(([startMs, endMs], i) => ({ id: `r${i}`, startMs, endMs })) });
const viewport = (timeMs = 0, width = 1000, height = 1000) => ({ type: 'viewport', timeMs, width, height });
const click = (timeMs, x = 500, y = 500) => ({ type: 'click', timeMs, x, y });
const move = (timeMs, x = 500, y = 500) => ({ type: 'move', timeMs, x, y });
const scroll = timeMs => ({ type: 'scroll', timeMs, deltaY: 100 });
const options = { sourceDurationMs: 10000 };
const spans = values => values.map(b => [b.sourceStartMs, b.sourceEndMs]);
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

test('validates bounded fields and returns detached source-ordered data', () => {
  const input = freeze([block({ id: 'later', sourceStartMs: 4000, sourceEndMs: 5000 }), block()]);
  const output = validate(input, options);
  assert.deepEqual(output.map(b => b.id), ['a', 'later']);
  output[0].target.x = 0;
  assert.equal(input[1].target.x, .5);
});
for (const [name, patch] of [
  ['negative start', { sourceStartMs: -1 }], ['fractional start', { sourceStartMs: 1.5 }],
  ['empty interval', { sourceEndMs: 1000 }], ['reversed interval', { sourceEndMs: 999 }],
  ['past source', { sourceEndMs: 10001 }], ['nonfinite end', { sourceEndMs: Infinity }],
  ['left of source', { target: { x: -.1, y: .5 } }], ['right of source', { target: { x: 1.01, y: .5 } }],
  ['nonfinite target', { target: { x: NaN, y: .5 } }], ['partial target', { target: { x: .5 } }],
  ['low zoom', { zoom: .9 }], ['high zoom', { zoom: 2.01 }], ['missing zoom', { zoom: undefined }],
  ['easing injection', { easing: 'run()' }], ['invalid cursor', { cursorPolicy: 'erase-baked-pixels' }],
  ['truthy enabled', { enabled: 'true' }], ['unknown field', { execute: 'anything' }], ['empty id', { id: '' }],
]) test(`rejects ${name}`, () => assert.throws(() => validate([block(patch)], options)));

test('block count, sparse arrays, duplicate and oversized ids fail closed', () => {
  assert.throws(() => validate(new Array(1)));
  assert.throws(() => validate([block(), block()]));
  assert.throws(() => validate([block({ id: 'x'.repeat(129) })]));
  assert.throws(() => validate(Array.from({ length: 65 }, (_, i) => block({ id: `${i}`, enabled: false }))));
  assert.equal(validate(Array.from({ length: 64 }, (_, i) => block({ id: `${i}`, enabled: false }))).length, 64);
});

test('half-open boundaries: before, start, fractional interior, end, duration', () => {
  assert.equal(resolve([block()], 999, options), null);
  assert.equal(resolve([block()], 1000, options).id, 'a');
  assert.equal(resolve([block()], 2999.9, options).id, 'a');
  assert.equal(resolve([block()], 3000, options), null);
  assert.equal(resolve([block()], 10000, options), null);
  for (const t of [-1, NaN, Infinity, 10001]) assert.throws(() => resolve([block()], t, options));
});

test('one-millisecond manual block is legal and preserves exact endpoints', () => {
  const tiny = block({ sourceEndMs: 1001 });
  assert.equal(resolve([tiny], 1000).id, 'a');
  assert.equal(resolve([tiny], 1001), null);
});

test('overlap refuses by default including nested overlap; adjacency is legal', () => {
  const pair = [block(), block({ id: 'b', sourceStartMs: 2000, sourceEndMs: 2500 })];
  assert.throws(() => validate(pair), /overlap/);
  assert.throws(() => resolve(pair, 0), /overlap/);
  assert.equal(validate([block(), block({ id: 'b', sourceStartMs: 3000, sourceEndMs: 4000 })]).length, 2);
});

test('explicit latest-start selection and ties do not depend on array order', () => {
  const values = [block(), block({ id: 'z', sourceStartMs: 2000, sourceEndMs: 2500 }), block({ id: 'b', sourceStartMs: 2000, sourceEndMs: 2600 })];
  const config = { overlapPolicy: 'latest-start' };
  assert.equal(resolve(values, 2100, config).id, 'b');
  assert.equal(resolve([...values].reverse(), 2100, config).id, 'b');
  assert.equal(resolve(values, 2600, config).id, 'a');
  assert.throws(() => validate(values, { overlapPolicy: 'blend' }));
});

test('disabled blocks never resolve or conflict, but invalid disabled data still refuses', () => {
  const values = [block(), block({ id: 'b', enabled: false })];
  assert.equal(validate(values).length, 2);
  assert.equal(resolve(values, 2000).id, 'a');
  assert.equal(resolve([block({ enabled: false })], 2000), null);
  assert.throws(() => validate([block({ enabled: false, zoom: 50 })]));
});

test('portrait override applies only to requested ratio without mutating base', () => {
  const value = freeze(block({ ratioOverrides: { '9:16': { target: { x: 0, y: 1 }, zoom: 1, cursorPolicy: 'raw' } } }));
  assert.equal(resolve([value], 1500).target.x, .5);
  assert.equal(resolve([value], 1500, { ratio: '16:9' }).zoom, 1.35);
  const portrait = resolve([value], 1500, { ratio: '9:16' });
  assert.deepEqual(portrait.target, { x: 0, y: 1 });
  assert.equal(portrait.zoom, 1);
  assert.equal(portrait.cursorPolicy, 'raw');
  portrait.target.x = .3;
  assert.equal(value.ratioOverrides['9:16'].target.x, 0);
});

test('ratio override refuses invalid shape, ratio, zoom, timing and executable fields', () => {
  for (const value of [{}, null, [], { zoom: 3 }, { sourceStartMs: 0 }, { target: { x: 1.1, y: 0 } }, { filter: 'exec' }]) assert.throws(() => validateRatioOverride(value));
  assert.throws(() => validate([block({ ratioOverrides: { portrait: { zoom: 1 } } })]));
  assert.throws(() => resolve([block()], 1500, { ratio: '1:1' }));
  assert.deepEqual(validateRatioOverride({ zoom: 2, easing: 'linear' }), { zoom: 2, easing: 'linear' });
});

test('all cursor intents remain explicit data, with no pixel-removal action', () => {
  for (const cursorPolicy of ['preserve', 'on', 'off', 'smooth', 'raw']) assert.equal(resolve([block({ cursorPolicy })], 1500).cursorPolicy, cursorPolicy);
});

test('clipping splits around removed ranges, preserves source clock and settings', () => {
  const values = freeze([block({ sourceStartMs: 1000, sourceEndMs: 9000, ratioOverrides: { '9:16': { zoom: 1 } } })]);
  const ranges = freeze(rangeSet([[0, 2000], [4000, 7000], [8500, 10000]]));
  const output = clip(values, ranges);
  assert.deepEqual(spans(output), [[1000, 2000], [4000, 7000], [8500, 9000]]);
  assert.equal(new Set(output.map(b => b.id)).size, 3);
  assert.equal(resolve(output, 3000, options), null);
  assert.equal(resolve(output, 4000, options).sourceStartMs, 4000);
  output[0].ratioOverrides['9:16'].zoom = 2;
  assert.equal(output[1].ratioOverrides['9:16'].zoom, 1);
  assert.equal(values[0].ratioOverrides['9:16'].zoom, 1);
  assert.equal(clipFocusBlocksToRangeSet, clip);
});

test('removed blocks vanish; touching boundaries do not create zero-length fragments', () => {
  assert.deepEqual(clip([block()], rangeSet([[0, 1000], [3000, 10000]])), []);
  assert.deepEqual(spans(clip([block()], rangeSet([[1000, 2000], [2000, 3000]]))), [[1000, 2000], [2000, 3000]]);
});

test('clipping is deterministic and idempotent and avoids adversarial id collisions', () => {
  const values = [block(), block({ id: 'focus-clip-0-1000-1500', sourceStartMs: 4000, sourceEndMs: 5000 })];
  const ranges = rangeSet([[0, 1500], [2000, 10000]]);
  const output = clip(values, ranges);
  assert.equal(new Set(output.map(b => b.id)).size, output.length);
  assert.deepEqual(clip(values, ranges), output);
  assert.deepEqual(clip(output, ranges), output);
});

test('clip preserves disabled blocks but refuses enabled overlap and priority options', () => {
  const values = [block(), block({ id: 'b', enabled: false })];
  assert.equal(clip(values, rangeSet([[0, 10000]]))[1].enabled, false);
  assert.throws(() => clip([block(), block({ id: 'b' })], rangeSet([[0, 10000]])), /overlap/);
  assert.throws(() => clip([block(), block({ id: 'b' })], rangeSet([[0, 10000]]), { overlapPolicy: 'latest-start' }), /unknown field/);
});

test('malformed ranges and fragmentation overflow refuse without truncation', () => {
  for (const ranges of [[], [[3, 3]], [[300, 400], [0, 200]], [[0, 400], [300, 500]], [[-1, 10]], [[0, 10001]], [[.5, 100]]]) assert.throws(() => clip([], rangeSet(ranges)));
  assert.throws(() => clip([], { ...rangeSet([[0, 10000]]), schemaVersion: 2 }));
  assert.throws(() => clip([], { ...rangeSet([[0, 10000]]), ranges: new Array(2) }));
  const ranges = rangeSet(Array.from({ length: 65 }, (_, i) => [i * 100, i * 100 + 50]));
  assert.throws(() => clip([block({ sourceStartMs: 0, sourceEndMs: 10000 })], ranges), /limit/);
});

test('far-left/right clicks normalize exactly and remain independent proposals', () => {
  const p = propose([viewport(), click(1000, 0, 0), click(4000, 1000, 1000)], options);
  assert.deepEqual(p.map(p => p.block.target), [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  assert.deepEqual(spans(p.map(p => p.block)), [[1000, 2500], [4000, 5500]]);
  assert.ok(p.every(p => p.reviewRequired && p.reason === 'CLICK_CLUSTER'));
});

test('rapid repeated and dense duplicate clicks form one bounded anchored proposal', () => {
  const p = propose([viewport(), ...Array.from({ length: 9000 }, () => click(1000)), click(1100, 510), click(1300, 520)], options);
  assert.equal(p.length, 1);
  assert.equal(p[0].evidence.clickCount, 3);
  assert.deepEqual(p[0].evidence.eventIndices, [1, 9001, 9002]);
  assert.deepEqual(p[0].block.target, { x: .5, y: .5 });
  assert.equal(p[0].block.sourceEndMs, 2800);
});

test('cluster radius stays anchored, preventing chained slow target drift', () => {
  const p = propose([viewport(), click(1000, 0), click(1100, 70), click(1200, 140)], options);
  assert.equal(p.length, 1); // short first group refused; last point holds
  assert.equal(p[0].block.target.x, .14);
});

test('scroll/menu bursts and drag-away moves suppress misleading brief focus', () => {
  assert.deepEqual(propose([viewport(), click(1000), scroll(1100), move(1200, 700)], options), []);
  assert.deepEqual(propose([viewport(), click(1000), move(1200, 700)], options), []);
  const p = propose([viewport(), click(1000, 0), click(1100, 500), click(1200, 1000)], options);
  assert.equal(p.length, 1);
  assert.equal(p[0].block.target.x, 1);
  const held = propose([viewport(), click(1000), scroll(1800), click(3000)], options);
  assert.deepEqual(spans(held.map(p => p.block)), [[1000, 1800], [3000, 4500]]);
});

test('no metadata, moves only, missing coordinates, and clicks before viewport yield no evidence', () => {
  for (const events of [[], [click(1000)], [viewport(), move(1000)], [click(1000), viewport(2000)], [viewport(), { type: 'click', timeMs: 1000 }]]) assert.deepEqual(propose(events, options), []);
  assert.deepEqual(propose(undefined, options), []);
  assert.deepEqual(propose([viewport(), click(1000, -1), click(2000, 1001)], options), []);
});

test('viewport resize ends old focus and normalizes the next click from new evidence', () => {
  const p = propose([viewport(), click(1000), viewport(2000, 500, 200), click(2500, 500, 200)], options);
  assert.deepEqual(spans(p.map(p => p.block)), [[1000, 2000], [2500, 4000]]);
  assert.deepEqual(p[1].block.target, { x: 1, y: 1 });
  assert.equal(p[1].evidence.viewportEventIndex, 2);
});

test('minimum dwell is inclusive at 500ms; source end is excluded', () => {
  assert.equal(propose([viewport(), click(9500)], options).length, 1);
  assert.deepEqual(propose([viewport(), click(9501)], options), []);
  assert.deepEqual(propose([viewport(), click(10000)], options), []);
});

test('proposals exclude removed clicks and stop at retained boundaries', () => {
  const config = { rangeSet: rangeSet([[0, 2000], [4000, 7000], [8000, 10000]]) };
  const p = propose([viewport(), click(1000), click(2000), click(3000), click(4000), click(6800), click(7000), click(8000)], config);
  assert.deepEqual(spans(p.map(p => p.block)), [[1000, 2000], [4000, 5500], [8000, 9500]]);
  assert.deepEqual(p.map(p => p.evidence.eventIndices), [[1], [4], [7]]);
  assert.throws(() => propose([], { ...config, sourceDurationMs: 9999 }), /mismatch/);
});

test('adjacent range edges reset cluster state without crossing source boundaries', () => {
  const p = propose([viewport(), click(1000), click(1800), click(2000)], { rangeSet: rangeSet([[0, 2000], [2000, 10000]]) });
  assert.deepEqual(spans(p.map(p => p.block)), [[1000, 1800], [2000, 3500]]);
});

test('input immutability, repeated output and unordered timestamps are deterministic', () => {
  const events = freeze([click(4000, 0), viewport(), click(1000), click(1100)]);
  const first = propose(events, options);
  assert.deepEqual(propose(events, options), first);
  assert.deepEqual(spans(first.map(p => p.block)), [[1000, 2600], [4000, 5500]]);
  first[0].evidence.eventIndices.push(999);
  assert.equal(propose(events, options)[0].evidence.eventIndices.length, 2);
});

test('malformed telemetry and unbounded proposal output fail closed', () => {
  for (const events of [null, new Array(1), [{ type: 'click', timeMs: NaN }], [viewport(0, 0)], [click(10001)], [{ ...click(1000), x: Infinity }], [{ type: 'scroll', timeMs: 0 }], [{ type: 'execute', timeMs: 0 }], [{ ...click(1000), command: 'ignored?' }], Array.from({ length: FOCUS_LIMITS.events + 1 }, () => viewport())]) assert.throws(() => propose(events, options));
  assert.throws(() => propose([], { sourceDurationMs: 120001 }));
  assert.throws(() => propose([viewport(), ...Array.from({ length: 65 }, (_, i) => click(i * 1800))], { sourceDurationMs: 120000 }), /limit/);
});

test('long repeated activity cannot create a focus block longer than four seconds', () => {
  const p = propose([viewport(), ...Array.from({ length: 80 }, (_, i) => click(i * 100))], options);
  assert.equal(p.length, 2);
  assert.ok(p.every(p => p.block.sourceEndMs - p.block.sourceStartMs <= 4000));
});

test('exhaustive small timeline agrees with independent set-membership clipping oracle', () => {
  for (let start = 0; start < 12; start++) for (let end = start + 1; end <= 12; end++) {
    const input = block({ sourceStartMs: start, sourceEndMs: end });
    const ranges = rangeSet([[0, 3], [5, 8], [10, 12]], 12);
    const result = clip([input], ranges);
    for (let t = 0; t <= 12; t += .5) {
      const expected = t >= start && t < end && ranges.ranges.some(r => t >= r.startMs && t < r.endMs);
      assert.equal(resolve(result, t, { sourceDurationMs: 12 }) !== null, expected);
    }
  }
});

test('replays recorded R3 capture snapshots and observed clicks without invented targets', () => {
  const fixture = JSON.parse(readFileSync(new URL('./recorded-capture.json', import.meta.url)));
  const p = propose(fixture.events, { sourceDurationMs: fixture.sourceDurationMs });
  assert.ok(p.length > 0);
  for (const proposal of p) {
    const event = fixture.events[proposal.evidence.eventIndices[0]];
    const vp = fixture.events[proposal.evidence.viewportEventIndex];
    assert.equal(event.type, 'click');
    assert.deepEqual(proposal.block.target, { x: event.x / vp.width, y: event.y / vp.height });
    assert.ok(proposal.reviewRequired);
  }
  assert.deepEqual(propose(fixture.events, { sourceDurationMs: fixture.sourceDurationMs }), p);
});

test('equal-time telemetry preserves recorded order; a later viewport cannot backfill a click', () => {
  assert.deepEqual(propose([click(1000), viewport(1000)], options), []);
  assert.equal(propose([viewport(1000), click(1000)], options).length, 1);
});

test('recorded fixture hash and observation values match admitted capture evidence', async () => {
  const { createHash } = await import('node:crypto');
  const fixture = JSON.parse(readFileSync(new URL('./recorded-capture.json', import.meta.url)));
  const raw = readFileSync(new URL('../integration-r3/evidence/capture-evidence.json', import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'), fixture.provenance.sha256);
  const original = JSON.parse(raw);
  for (const event of fixture.events) {
    if (event.type === 'viewport') {
      assert.ok(original.timing.actions.some(a => a.startedMs === event.timeMs && a.before.viewport.width === event.width && a.before.viewport.height === event.height));
    } else {
      assert.ok(original.timing.observations.some(o => Object.keys(event).every(key => o[key] === event[key])));
    }
  }
});


test('clipping refuses the original-start priority erasure counterexample', () => {
  const values = [block({ id: 'a', sourceStartMs: 1000, sourceEndMs: 9000 }), block({ id: 'b', sourceStartMs: 2000, sourceEndMs: 8000 })];
  assert.equal(resolve(values, 5000, { overlapPolicy: 'latest-start' }).id, 'b');
  assert.throws(() => clip(values, rangeSet([[4000, 7000]])), /overlap/);
});

test('explicit null bounds/policy/ranges refuse instead of silently defaulting', () => {
  assert.throws(() => validate([], { sourceDurationMs: null }));
  assert.throws(() => validate([], { overlapPolicy: null }));
  assert.throws(() => propose([], { sourceDurationMs: null }));
  for (const rangeSet of [null, false, 0]) assert.throws(() => propose([], { ...options, rangeSet }));
});
