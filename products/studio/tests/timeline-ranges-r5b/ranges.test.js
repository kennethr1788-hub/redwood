import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RANGES, validateRangeSet, retainedDurationMs, sourceToOutputMs,
  outputToSourceMs, mapSourceIntervalToOutput, clipSourceIntervalToRanges,
  removeSourceInterval, restoreSourceInterval, sourceEventIncluded, normalizeRangeSet,
} from "../../src/timeline/ranges.js";

const make = (duration, spans) => ({ schemaVersion: 1, sourceDurationMs: duration,
  ranges: spans.map(([startMs, endMs], i) => ({ id: `caller-${i}`, startMs, endMs })) });
const geometry = (set) => set.ranges.map((r) => [r.startMs, r.endMs]);
const full = () => make(12000, [[0, 12000]]);
const cut = () => make(12000, [[0, 4000], [7000, 12000]]);
const bits = (set) => Array.from({ length: set.sourceDurationMs }, (_, time) =>
  set.ranges.some((r) => r.startMs <= time && time < r.endMs));
function fromBits(values) {
  const spans = [];
  for (let i = 0; i < values.length;) {
    if (!values[i]) { i++; continue; }
    const start = i;
    while (values[i]) i++;
    spans.push([start, i]);
  }
  return make(values.length, spans);
}
function frozen(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

test("current trim is a one-range RangeSet with source-relative mapping", () => {
  const trim = make(12000, [[1250, 9750]]);
  assert.equal(retainedDurationMs(trim), 8500);
  assert.equal(sourceToOutputMs(trim, 1250), 0);
  assert.equal(sourceToOutputMs(trim, 9749), 8499);
  assert.equal(outputToSourceMs(trim, 0), 1250);
  assert.equal(outputToSourceMs(trim, 8499), 9749);
  assert.equal(sourceToOutputMs(trim, 9750), null);
});

test("canonical 4s + 5s example and both directions", () => {
  assert.equal(retainedDurationMs(cut()), 9000);
  assert.equal(sourceToOutputMs(cut(), 8000), 5000);
  assert.equal(outputToSourceMs(cut(), 5000), 8000);
  for (const time of [4000, 4001, 5500, 6999]) {
    assert.equal(sourceToOutputMs(cut(), time), null);
    assert.equal(sourceEventIncluded(cut(), time), false);
  }
});

test("half-open events and output splices never snap into removed media", () => {
  for (const [time, mapped] of [[0, 0], [3999, 3999], [4000, null],
    [6999, null], [7000, 4000], [11999, 8999], [12000, null]]) {
    assert.equal(sourceToOutputMs(cut(), time), mapped);
    assert.equal(sourceEventIncluded(cut(), time), mapped !== null);
  }
  assert.equal(outputToSourceMs(cut(), 3999), 3999);
  assert.equal(outputToSourceMs(cut(), 4000), 7000);
  assert.equal(outputToSourceMs(cut(), 9000), null);
});

test("interval map preserves source fragments and both clocks across cuts", () => {
  assert.deepEqual(mapSourceIntervalToOutput(cut(), 3000, 8000), [
    { rangeId: "caller-0", sourceStartMs: 3000, sourceEndMs: 4000, outputStartMs: 3000, outputEndMs: 4000 },
    { rangeId: "caller-1", sourceStartMs: 7000, sourceEndMs: 8000, outputStartMs: 4000, outputEndMs: 5000 },
  ]);
  assert.deepEqual(clipSourceIntervalToRanges(cut(), 3000, 8000), [
    { rangeId: "caller-0", startMs: 3000, endMs: 4000 },
    { rangeId: "caller-1", startMs: 7000, endMs: 8000 },
  ]);
  assert.deepEqual(mapSourceIntervalToOutput(cut(), 4000, 7000), []);
  assert.deepEqual(clipSourceIntervalToRanges(cut(), 4000, 7000), []);
  assert.equal(mapSourceIntervalToOutput(cut(), 0, 4000).length, 1);
  assert.equal(mapSourceIntervalToOutput(cut(), 7000, 12000).length, 1);
});

test("start, end and multiple middle removals retain exact source order", () => {
  let set = removeSourceInterval(full(), 0, 1000);
  set = removeSourceInterval(set, 11000, 12000);
  set = removeSourceInterval(set, 3000, 5000);
  set = removeSourceInterval(set, 7000, 8000);
  assert.deepEqual(geometry(set), [[1000, 3000], [5000, 7000], [8000, 11000]]);
  assert.equal(retainedDurationMs(set), 7000);
  assert.deepEqual(geometry(removeSourceInterval(set, 2000, 9000)), [[1000, 2000], [9000, 11000]]);
  assert.deepEqual(removeSourceInterval(set, 3000, 5000), set);
});

test("restore unions source content, preserves disjoint ranges and is idempotent", () => {
  let set = restoreSourceInterval(cut(), 5000, 6000);
  assert.deepEqual(geometry(set), [[0, 4000], [5000, 6000], [7000, 12000]]);
  assert.deepEqual(restoreSourceInterval(set, 5100, 5900), set);
  set = restoreSourceInterval(set, 4000, 7000);
  assert.deepEqual(geometry(set), [[0, 12000]]);
  assert.equal(retainedDurationMs(set), 12000);
  assert.deepEqual(geometry(restoreSourceInterval(make(12, [[4, 8]]), 0, 2)), [[0, 2], [4, 8]]);
  assert.deepEqual(geometry(restoreSourceInterval(make(12, [[4, 8]]), 10, 12)), [[4, 8], [10, 12]]);
  assert.deepEqual(geometry(restoreSourceInterval(make(12, [[4, 8]]), 0, 6)), [[0, 8]]);
  assert.deepEqual(geometry(restoreSourceInterval(make(12, [[4, 8]]), 6, 12)), [[4, 12]]);
});

test("adjacency is valid and coalescing is explicit, idempotent and timing-neutral", () => {
  const set = make(12, [[0, 4], [4, 7], [9, 12]]);
  assert.equal(validateRangeSet(set).ranges.length, 3);
  assert.equal(mapSourceIntervalToOutput(set, 0, 7).length, 2);
  const normalized = normalizeRangeSet(set);
  assert.deepEqual(geometry(normalized), [[0, 7], [9, 12]]);
  assert.deepEqual(normalizeRangeSet(normalized), normalized);
  assert.equal(normalized.ranges[1].id, set.ranges[2].id);
  for (let i = 0; i <= 12; i++)
    assert.equal(sourceToOutputMs(normalized, i), sourceToOutputMs(set, i));
});

test("all-content removal and empty RangeSets are refused atomically", () => {
  const input = frozen(cut());
  for (const bounds of [[0, 12000], [0, 11999]]) {
    if (bounds[1] === 12000) assert.throws(() => removeSourceInterval(input, ...bounds), /all-content/);
    else assert.equal(retainedDurationMs(removeSourceInterval(input, ...bounds)), 1);
  }
  assert.throws(() => removeSourceInterval(make(10, [[2, 8]]), 1, 9), /all-content/);
  assert.deepEqual(input, cut());
  assert.throws(() => validateRangeSet(make(10, [])), /all-content/);
});

const invalidSets = [
  ["null", null], ["array", []], ["missing fields", {}],
  ["wrong schema", { ...full(), schemaVersion: 2 }],
  ["unknown set field", { ...full(), speed: 2 }],
  ["zero duration", make(0, [[0, 1]])],
  ["negative duration", make(-1, [[0, 1]])],
  ["fractional duration", make(1.5, [[0, 1]])],
  ["unsafe duration", make(Number.MAX_SAFE_INTEGER + 1, [[0, 1]])],
  ["NaN duration", make(NaN, [[0, 1]])],
  ["infinite duration", make(Infinity, [[0, 1]])],
  ["overlap", make(12, [[0, 8], [7, 12]])],
  ["order", make(12, [[7, 12], [0, 4]])],
  ["negative start", make(12, [[-1, 4]])],
  ["past source", make(12, [[0, 13]])],
  ["zero interval", make(12, [[4, 4]])],
  ["reverse interval", make(12, [[8, 4]])],
  ["fractional endpoint", make(12, [[0.1, 4]])],
  ["numeric string", make(12, [["0", 4]])],
  ["blank ID", { ...full(), ranges: [{ id: " ", startMs: 0, endMs: 10 }] }],
  ["long ID", { ...full(), ranges: [{ id: "x".repeat(129), startMs: 0, endMs: 10 }] }],
  ["duplicate IDs", { ...full(), ranges: [{ id: "x", startMs: 0, endMs: 1 }, { id: "x", startMs: 1, endMs: 2 }] }],
  ["unknown range field", { ...full(), ranges: [{ id: "x", startMs: 0, endMs: 1, rate: 2 }] }],
  ["sparse ranges", { ...full(), ranges: new Array(1) }],
];
for (const [label, set] of invalidSets) test(`reject invalid RangeSet: ${label}`, () => {
  for (const operation of [validateRangeSet, retainedDurationMs, normalizeRangeSet,
    (s) => sourceToOutputMs(s, 0), (s) => outputToSourceMs(s, 0),
    (s) => mapSourceIntervalToOutput(s, 0, 1), (s) => clipSourceIntervalToRanges(s, 0, 1),
    (s) => removeSourceInterval(s, 0, 1), (s) => restoreSourceInterval(s, 0, 1),
    (s) => sourceEventIncluded(s, 0)]) assert.throws(() => operation(set), RangeError);
});

test("all time entrypoints reject invalid milliseconds and bounds", () => {
  for (const time of [-1, 12001, 0.5, NaN, Infinity, "1", null, undefined, 1n]) {
    assert.throws(() => sourceToOutputMs(full(), time), RangeError);
    assert.throws(() => sourceEventIncluded(full(), time), RangeError);
    assert.throws(() => outputToSourceMs(full(), time), RangeError);
  }
  assert.throws(() => outputToSourceMs(cut(), 9001), RangeError);
  for (const fn of [mapSourceIntervalToOutput, clipSourceIntervalToRanges,
    removeSourceInterval, restoreSourceInterval]) {
    for (const bounds of [[0, 0], [2, 1], [-1, 2], [0, 12001], [0.5, 2], [0, NaN], [0, "2"]])
      assert.throws(() => fn(full(), ...bounds), RangeError);
  }
});

test("range cap is enforced on inputs and edit results, with no partial mutation", () => {
  const set = frozen(make(1026, Array.from({ length: MAX_RANGES }, (_, i) => [4 * i, 4 * i + 3])));
  assert.equal(validateRangeSet(set).ranges.length, MAX_RANGES);
  assert.throws(() => validateRangeSet(make(1028,
    Array.from({ length: MAX_RANGES + 1 }, (_, i) => [4 * i, 4 * i + 3]))), RangeError);
  assert.throws(() => removeSourceInterval(set, 1, 2), RangeError);
  assert.throws(() => restoreSourceInterval(set, 1024, 1025), RangeError);
  assert.equal(restoreSourceInterval(set, 3, 4).ranges.length, MAX_RANGES - 1);
  assert.equal(set.ranges.length, MAX_RANGES);
});

test("all APIs are pure and return detached objects; frozen inputs work", () => {
  const set = frozen(cut());
  const copy = validateRangeSet(set);
  copy.ranges[0].startMs = 1;
  assert.equal(set.ranges[0].startMs, 0);
  const removed = removeSourceInterval(set, 4000, 7000);
  removed.ranges[0].id = "changed";
  assert.equal(set.ranges[0].id, "caller-0");
  const restored = restoreSourceInterval(set, 0, 1000);
  restored.ranges[0].endMs = 1;
  normalizeRangeSet(set);
  mapSourceIntervalToOutput(set, 0, 12000);
  assert.deepEqual(set, cut());
});

test("generated IDs are deterministic and avoid caller ID collisions", () => {
  const set = make(12, [[0, 4], [7, 12]]);
  set.ranges[1].id = "range-0-2";
  const result = removeSourceInterval(set, 2, 3);
  assert.equal(result.ranges[0].id, "range-0-2-1");
  assert.equal(result.ranges[2].id, "range-0-2");
  assert.deepEqual(removeSourceInterval(set, 2, 3), result);
  assert.deepEqual(restoreSourceInterval(set, 5, 6), restoreSourceInterval(set, 5, 6));
});

test("safe-integer extremes do not overflow intermediate duration or mapping math", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const set = make(max, [[0, max - 3], [max - 2, max]]);
  assert.equal(retainedDurationMs(set), max - 1);
  assert.equal(sourceToOutputMs(set, max - 1), max - 2);
  assert.equal(outputToSourceMs(set, max - 2), max - 1);
  assert.equal(mapSourceIntervalToOutput(set, max - 2, max)[0].outputEndMs, max - 1);
  assert.deepEqual(geometry(restoreSourceInterval(set, max - 3, max - 2)), [[0, max]]);
});

test("1000 repeated remove/restore cycles have zero millisecond drift", () => {
  let set = full();
  let once;
  for (let i = 0; i < 1000; i++) {
    set = removeSourceInterval(set, 1333, 2777);
    set = removeSourceInterval(set, 5333, 7777);
    once ??= set;
    assert.deepEqual(set, once);
    assert.equal(retainedDurationMs(set), 8112);
    assert.equal(sourceToOutputMs(set, 8000), 4112);
    set = restoreSourceInterval(set, 5333, 7777);
    set = restoreSourceInterval(set, 1333, 2777);
    assert.deepEqual(geometry(set), [[0, 12000]]);
    assert.equal(retainedDurationMs(set), 12000);
  }
});

test("exhaustive small-domain bitset oracle: mapping, clipping, subtraction and union", () => {
  // Independent oracle stores inclusion per millisecond, not range arithmetic.
  // 255 nonempty timelines x 36 possible nonempty source intervals = 9180 cases.
  const duration = 8;
  for (let mask = 1; mask < 2 ** duration; mask++) {
    const expected = Array.from({ length: duration }, (_, i) => Boolean(mask & (1 << i)));
    const set = frozen(fromBits(expected));
    const sourceTimes = expected.flatMap((keep, i) => keep ? [i] : []);
    assert.equal(retainedDurationMs(set), sourceTimes.length);
    for (let source = 0; source <= duration; source++) {
      const index = sourceTimes.indexOf(source);
      assert.equal(sourceToOutputMs(set, source), index < 0 ? null : index);
      assert.equal(sourceEventIncluded(set, source), index >= 0);
    }
    for (let output = 0; output <= sourceTimes.length; output++)
      assert.equal(outputToSourceMs(set, output), sourceTimes[output] ?? null);
    for (let start = 0; start < duration; start++) for (let end = start + 1; end <= duration; end++) {
      const restored = expected.map((keep, i) => keep || (i >= start && i < end));
      const removed = expected.map((keep, i) => keep && !(i >= start && i < end));
      assert.deepEqual(bits(restoreSourceInterval(set, start, end)), restored);
      if (removed.some(Boolean)) assert.deepEqual(bits(removeSourceInterval(set, start, end)), removed);
      else assert.throws(() => removeSourceInterval(set, start, end), RangeError);
      const expectedSources = sourceTimes.filter((i) => i >= start && i < end);
      const mapped = mapSourceIntervalToOutput(set, start, end);
      assert.deepEqual(mapped.flatMap((f) => Array.from({ length: f.sourceEndMs - f.sourceStartMs },
        (_, i) => f.sourceStartMs + i)), expectedSources);
      assert.deepEqual(mapped.flatMap((f) => Array.from({ length: f.outputEndMs - f.outputStartMs },
        (_, i) => f.outputStartMs + i)), expectedSources.map((i) => sourceTimes.indexOf(i)));
      assert.deepEqual(clipSourceIntervalToRanges(set, start, end), mapped.map((f) =>
        ({ rangeId: f.rangeId, startMs: f.sourceStartMs, endMs: f.sourceEndMs })));
    }
  }
});

test("maximum range count has exact round trips at every splice and no drift", () => {
  const set = make(120000, Array.from({ length: MAX_RANGES }, (_, i) => [i * 400 + 33, i * 400 + 334]));
  assert.equal(retainedDurationMs(set), MAX_RANGES * 301);
  for (let i = 0; i < MAX_RANGES; i++) {
    for (const delta of [0, 1, 300]) {
      const source = i * 400 + 33 + delta;
      const output = i * 301 + delta;
      assert.equal(sourceToOutputMs(set, source), output);
      assert.equal(outputToSourceMs(set, output), source);
    }
    assert.equal(sourceToOutputMs(set, i * 400 + 334), null);
    const joined = restoreSourceInterval(set, i * 400 + 334, i * 400 + 335);
    const back = removeSourceInterval(joined, i * 400 + 334, i * 400 + 335);
    assert.deepEqual(geometry(back), geometry(set));
    assert.equal(retainedDurationMs(back), MAX_RANGES * 301);
  }
});

test("mixed deterministic edit history agrees with an independent bitset after each edit", () => {
  let state = 314159;
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0);
  let expected = Array(128).fill(true);
  let set = fromBits(expected);
  for (let i = 0; i < 2000; i++) {
    const a = next() % 128, b = next() % 128;
    const start = Math.min(a, b), end = Math.max(a, b) + 1;
    const restore = (next() & 1) === 0;
    const candidate = expected.map((keep, time) => time >= start && time < end ? restore : keep);
    if (!candidate.some(Boolean)) {
      assert.throws(() => removeSourceInterval(set, start, end), RangeError);
      continue;
    }
    set = (restore ? restoreSourceInterval : removeSourceInterval)(set, start, end);
    expected = candidate;
    assert.deepEqual(bits(set), expected);
    const retained = expected.flatMap((keep, time) => keep ? [time] : []);
    assert.equal(retainedDurationMs(set), retained.length);
    for (let output = 0; output < retained.length; output++) {
      assert.equal(outputToSourceMs(set, output), retained[output]);
      assert.equal(sourceToOutputMs(set, retained[output]), output);
    }
  }
});
