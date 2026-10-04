/**
 * Pure, single-source, speed-1 timing. Every interval is half-open [start,end).
 * Milliseconds are safe integers: no rounding, frame quantization or media I/O.
 * Invalid input throws RangeError. Validation returns a detached canonical copy.
 * Points at the final endpoint or in a removed span return null; out-of-domain
 * points throw. At a splice, output time belongs to the following retained span.
 */
export const MAX_RANGES = 256;
export const MAX_RANGE_ID_LENGTH = 128;

function fail(message) {
  throw new RangeError(message);
}

function shape(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key)))
    fail(`${label} must contain exactly ${keys.join(", ")}`);
}

function point(value, duration, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > duration)
    fail(`${label} must be safe integer milliseconds within 0..${duration}`);
}

function interval(startMs, endMs, duration) {
  point(startMs, duration, "startMs");
  point(endMs, duration, "endMs");
  if (endMs <= startMs) fail("Interval must have positive duration");
}

/** Validate without sorting, repairing overlaps, coalescing or mutating input. */
export function validateRangeSet(value) {
  shape(value, ["schemaVersion", "sourceDurationMs", "ranges"], "RangeSet");
  if (value.schemaVersion !== 1) fail("Unsupported RangeSet schemaVersion");
  const { sourceDurationMs, ranges } = value;
  if (!Number.isSafeInteger(sourceDurationMs) || sourceDurationMs <= 0)
    fail("sourceDurationMs must be a positive safe integer");
  if (!Array.isArray(ranges) || ranges.length < 1 || ranges.length > MAX_RANGES)
    fail(`RangeSet must retain 1..${MAX_RANGES} ranges (all-content removal refused)`);
  const ids = new Set();
  let previousEnd = 0;
  const copy = [];
  for (const range of ranges) {
    shape(range, ["id", "startMs", "endMs"], "Range");
    const { id, startMs, endMs } = range;
    if (typeof id !== "string" || !id.trim() || id.length > MAX_RANGE_ID_LENGTH || ids.has(id))
      fail("Range IDs must be nonblank, unique strings of at most 128 characters");
    interval(startMs, endMs, sourceDurationMs);
    if (startMs < previousEnd) fail("Ranges must be source ordered and non-overlapping");
    ids.add(id);
    previousEnd = endMs;
    copy.push({ id, startMs, endMs });
  }
  return { schemaVersion: 1, sourceDurationMs, ranges: copy };
}

const durationOf = (ranges) => ranges.reduce((sum, r) => sum + (r.endMs - r.startMs), 0);

export function retainedDurationMs(value) {
  return durationOf(validateRangeSet(value).ranges);
}

export function sourceToOutputMs(value, sourceMs) {
  const set = validateRangeSet(value);
  point(sourceMs, set.sourceDurationMs, "sourceMs");
  let offset = 0;
  for (const range of set.ranges) {
    if (sourceMs >= range.startMs && sourceMs < range.endMs)
      return offset + (sourceMs - range.startMs);
    offset += range.endMs - range.startMs;
  }
  return null;
}

export function outputToSourceMs(value, outputMs) {
  const set = validateRangeSet(value);
  point(outputMs, durationOf(set.ranges), "outputMs");
  let offset = 0;
  for (const range of set.ranges) {
    const next = offset + (range.endMs - range.startMs);
    if (outputMs < next) return range.startMs + (outputMs - offset);
    offset = next;
  }
  return null;
}

/** Accepts a source-time number, not an event object. Never snaps a removed event. */
export function sourceEventIncluded(value, sourceMs) {
  return sourceToOutputMs(value, sourceMs) !== null;
}

/**
 * Return one fragment per intersected retained range, preserving range identity
 * and both clocks. Even output-adjacent fragments stay separate across a cut.
 * No caption text, focus behavior or review authority is inferred here.
 */
export function mapSourceIntervalToOutput(value, startMs, endMs) {
  const set = validateRangeSet(value);
  interval(startMs, endMs, set.sourceDurationMs);
  const fragments = [];
  let offset = 0;
  for (const range of set.ranges) {
    const start = Math.max(startMs, range.startMs);
    const end = Math.min(endMs, range.endMs);
    if (start < end) fragments.push({
      rangeId: range.id,
      sourceStartMs: start,
      sourceEndMs: end,
      outputStartMs: offset + (start - range.startMs),
      outputEndMs: offset + (end - range.startMs),
    });
    offset += range.endMs - range.startMs;
  }
  return fragments;
}

/** Source-only intersections: [{rangeId,startMs,endMs}], never gap-spanning. */
export function clipSourceIntervalToRanges(value, startMs, endMs) {
  return mapSourceIntervalToOutput(value, startMs, endMs).map((fragment) => ({
    rangeId: fragment.rangeId,
    startMs: fragment.sourceStartMs,
    endMs: fragment.sourceEndMs,
  }));
}

// Preserve caller IDs for exact unchanged spans. Changed geometry receives a
// deterministic bounded ID. Reserve unchanged IDs first so adversarial caller
// names cannot collide with a new span's generated ID.
function editedSet(set, spans) {
  const original = new Map(set.ranges.map((r) => [`${r.startMs}:${r.endMs}`, r.id]));
  const ids = new Set(spans.map((r) => original.get(`${r.startMs}:${r.endMs}`))
    .filter((id) => id !== undefined));
  const ranges = spans.map(({ startMs, endMs }) => {
    let id = original.get(`${startMs}:${endMs}`);
    if (id === undefined) {
      const stem = `range-${startMs}-${endMs}`;
      id = stem;
      let suffix = 1;
      while (ids.has(id)) id = `${stem}-${suffix++}`;
      ids.add(id);
    }
    return { id, startMs, endMs };
  });
  return validateRangeSet({ schemaVersion: 1, sourceDurationMs: set.sourceDurationMs, ranges });
}

/** Subtract a source interval; a gap-only removal is a detached no-op. */
export function removeSourceInterval(value, startMs, endMs) {
  const set = validateRangeSet(value);
  interval(startMs, endMs, set.sourceDurationMs);
  const spans = [];
  for (const range of set.ranges) {
    if (endMs <= range.startMs || startMs >= range.endMs) spans.push(range);
    else {
      if (range.startMs < startMs) spans.push({ startMs: range.startMs, endMs: startMs });
      if (endMs < range.endMs) spans.push({ startMs: endMs, endMs: range.endMs });
    }
  }
  return editedSet(set, spans);
}

/**
 * Union with source [startMs,endMs), coalescing spans it overlaps or touches.
 * Restoring a wholly retained interval is a detached no-op. This is a source
 * restore, not revision undo: prior IDs/segment boundaries require a snapshot.
 * Disjoint caller segmentation is preserved. No input sorting/repair is done.
 */
export function restoreSourceInterval(value, startMs, endMs) {
  const set = validateRangeSet(value);
  interval(startMs, endMs, set.sourceDurationMs);
  if (set.ranges.some((r) => r.startMs <= startMs && r.endMs >= endMs)) return set;
  const spans = [];
  let start = startMs, end = endMs, inserted = false;
  for (const range of set.ranges) {
    if (range.endMs < start) spans.push(range);
    else if (range.startMs > end) {
      if (!inserted) spans.push({ startMs: start, endMs: end });
      inserted = true;
      spans.push(range);
    } else {
      start = Math.min(start, range.startMs);
      end = Math.max(end, range.endMs);
    }
  }
  if (!inserted) spans.push({ startMs: start, endMs: end });
  return editedSet(set, spans);
}

/** Explicit opt-in coalescing of adjacency only; never repairs overlap/order. */
export function normalizeRangeSet(value) {
  const set = validateRangeSet(value);
  const spans = [];
  for (const range of set.ranges) {
    const previous = spans.at(-1);
    if (previous && previous.endMs === range.startMs) previous.endMs = range.endMs;
    else spans.push({ startMs: range.startMs, endMs: range.endMs });
  }
  return editedSet(set, spans);
}
