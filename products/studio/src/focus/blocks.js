/** Pure source-time focus data. No camera, persistence, inference or output-time map. */
export const FOCUS_LIMITS = Object.freeze({
  sourceDurationMs: 120000, blocks: 64, ranges: 256, events: 10000,
  minZoom: 1, maxZoom: 2,
});
const EASINGS = ["linear", "easeInOutCubic"];
const CURSORS = ["preserve", "on", "off", "smooth", "raw"];
const RATIOS = ["16:9", "9:16"];
const fail = (message) => { throw new TypeError(message); };
function object(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label}: expected plain data object`);
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${label}: unknown field`);
}
function number(value, min, max, label, integer = false) {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value)))
    fail(`${label}: out of bounds`);
  return value;
}
function id(value, label) {
  if (typeof value !== "string" || !value.trim() || value.length > 128) fail(`${label}: invalid id`);
}
function target(value) {
  object(value, ["x", "y"], "target");
  return { x: number(value.x, 0, 1, "target.x"), y: number(value.y, 0, 1, "target.y") };
}
function choice(value, choices, label) {
  if (!choices.includes(value)) fail(`${label}: unsupported value`);
  return value;
}
function presentation(value) {
  const result = {};
  if (Object.hasOwn(value, "target")) result.target = target(value.target);
  if (Object.hasOwn(value, "zoom")) result.zoom = number(value.zoom, 1, 2, "zoom");
  if (Object.hasOwn(value, "easing")) result.easing = choice(value.easing, EASINGS, "easing");
  if (Object.hasOwn(value, "cursorPolicy")) result.cursorPolicy = choice(value.cursorPolicy, CURSORS, "cursorPolicy");
  return result;
}
/** A ratio override is a nonempty partial presentation, never timing or identity. */
export function validateRatioOverride(value) {
  object(value, ["target", "zoom", "easing", "cursorPolicy"], "ratio override");
  if (!Object.keys(value).length) fail("ratio override: empty");
  return presentation(value);
}
function settings(options, extra = []) {
  object(options, ["sourceDurationMs", "overlapPolicy", ...extra], "options");
  const sourceDurationMs = number(options.sourceDurationMs === undefined ? FOCUS_LIMITS.sourceDurationMs : options.sourceDurationMs, 1, FOCUS_LIMITS.sourceDurationMs, "sourceDurationMs", true);
  const overlapPolicy = choice(options.overlapPolicy === undefined ? "reject" : options.overlapPolicy, ["reject", "latest-start"], "overlapPolicy");
  return { sourceDurationMs, overlapPolicy };
}
/** Returns detached, source-sorted blocks; rejects overlap unless explicitly opted in.
 * Disabled blocks are validated but never participate in overlap or resolution.
 */
export function validateFocusBlocks(values, options = {}) {
  const { sourceDurationMs, overlapPolicy } = settings(options);
  if (!Array.isArray(values) || values.length > FOCUS_LIMITS.blocks) fail("focus blocks: limit exceeded or not an array");
  const ids = new Set();
  const blocks = Array.from(values, value => {
    object(value, ["id", "sourceStartMs", "sourceEndMs", "target", "zoom", "easing", "enabled", "cursorPolicy", "ratioOverrides"], "focus block");
    id(value.id, "focus block");
    if (ids.has(value.id)) fail("focus block: duplicate id");
    ids.add(value.id);
    const sourceStartMs = number(value.sourceStartMs, 0, sourceDurationMs, "sourceStartMs", true);
    const sourceEndMs = number(value.sourceEndMs, 0, sourceDurationMs, "sourceEndMs", true);
    if (sourceEndMs <= sourceStartMs) fail("focus block: empty or reversed interval");
    if (typeof value.enabled !== "boolean") fail("enabled: expected boolean");
    for (const key of ["target", "zoom", "easing", "cursorPolicy"])
      if (!Object.hasOwn(value, key)) fail(`focus block: missing ${key}`);
    const block = { id: value.id, sourceStartMs, sourceEndMs, ...presentation(value), enabled: value.enabled };
    if (Object.hasOwn(value, "ratioOverrides")) {
      object(value.ratioOverrides, RATIOS, "ratioOverrides");
      block.ratioOverrides = Object.fromEntries(Object.entries(value.ratioOverrides).map(([ratio, override]) => [ratio, validateRatioOverride(override)]));
    }
    return block;
  }).sort((a, b) => a.sourceStartMs - b.sourceStartMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let end = -1;
  for (const block of blocks) {
    if (!block.enabled) continue;
    if (overlapPolicy === "reject" && block.sourceStartMs < end) fail("focus blocks: enabled overlap");
    end = Math.max(end, block.sourceEndMs);
  }
  return blocks;
}
/** Half-open [start,end). Latest-start ties choose lexically smallest id.
 * Returns selected presentation data, not animated camera geometry; null is neutral.
 */
export function resolveFocusAtSourceTime(values, sourceTimeMs, options = {}) {
  const { sourceDurationMs, overlapPolicy } = settings(options, ["ratio"]);
  if (options.ratio !== undefined) choice(options.ratio, RATIOS, "ratio");
  number(sourceTimeMs, 0, sourceDurationMs, "sourceTimeMs");
  const blocks = validateFocusBlocks(values, { sourceDurationMs, overlapPolicy });
  let selected = null;
  for (const block of blocks) {
    if (block.enabled && sourceTimeMs >= block.sourceStartMs && sourceTimeMs < block.sourceEndMs &&
        (!selected || block.sourceStartMs > selected.sourceStartMs)) selected = block;
  }
  return selected ? { ...selected, ...selected.ratioOverrides?.[options.ratio] } : null;
}
/** Validate the frozen RangeSet boundary only; no source/output clock conversion. */
function retainedRanges(value) {
  object(value, ["schemaVersion", "sourceDurationMs", "ranges"], "RangeSet");
  if (value.schemaVersion !== 1) fail("RangeSet: unsupported version");
  number(value.sourceDurationMs, 1, FOCUS_LIMITS.sourceDurationMs, "sourceDurationMs", true);
  if (!Array.isArray(value.ranges) || !value.ranges.length || value.ranges.length > FOCUS_LIMITS.ranges) fail("RangeSet: invalid count");
  let end = -1;
  const ids = new Set();
  return Array.from(value.ranges, range => {
    object(range, ["id", "startMs", "endMs"], "range");
    id(range.id, "range");
    if (ids.has(range.id)) fail("range: duplicate id");
    ids.add(range.id);
    number(range.startMs, 0, value.sourceDurationMs, "range.startMs", true);
    number(range.endMs, 0, value.sourceDurationMs, "range.endMs", true);
    if (range.endMs <= range.startMs || range.startMs < end) fail("range: empty, unordered or overlapping");
    end = range.endMs;
    return { ...range };
  });
}
/** Intersects in SOURCE time; split ids are deterministic and collision checked.
 * Refuses >64 resulting blocks instead of dropping reviewed edits. No time map.
 */
export function clipFocusBlocksToRanges(values, rangeSet, options = {}) {
  const ranges = retainedRanges(rangeSet);
  object(options, [], "clip options");
  // Clipping erases original start priority; refuse enabled overlaps even when
  // callers use latest-start selection elsewhere, rather than changing winners.
  const config = { sourceDurationMs: rangeSet.sourceDurationMs };
  const blocks = validateFocusBlocks(values, config);
  const reserved = new Set(blocks.map(block => block.id));
  const clipped = [];
  for (const [index, block] of blocks.entries()) {
    const parts = ranges.map(range => ({ start: Math.max(block.sourceStartMs, range.startMs), end: Math.min(block.sourceEndMs, range.endMs) })).filter(part => part.end > part.start);
    for (const part of parts) {
      let splitId = block.id;
      if (parts.length > 1) {
        const stem = `focus-clip-${index}-${part.start}-${part.end}`;
        splitId = stem;
        for (let n = 1; reserved.has(splitId); n++) splitId = `${stem}-${n}`;
        reserved.add(splitId);
      }
      // Copy nested settings for each fragment; no shared mutable override/target.
      clipped.push({ ...structuredClone(block), id: splitId, sourceStartMs: part.start, sourceEndMs: part.end });
      if (clipped.length > FOCUS_LIMITS.blocks) fail("clipping exceeds focus block limit");
    }
  }
  return validateFocusBlocks(clipped, config);
}
// Architecture spelling and exact-task spelling refer to the same operation.
export const clipFocusBlocksToRangeSet = clipFocusBlocksToRanges;

/** Proposals from caller-supplied recorded Studio events only. This function cannot
 * authenticate telemetry. No events/preceding viewport => no invented focus.
 * Fixed heuristics: 80px per 1000px radius, <=500ms inter-click gap, >=500ms
 * suggested dwell, 1500ms hold, <=4000ms block. Moves never generate targets.
 * A far move, scroll, viewport change, next cluster or retained-range edge ends
 * the prior hold. Short menu/drag bursts are omitted, not chased.
 */
export function proposeFocusBlocksFromEvents(events = [], options = {}) {
  object(options, ["sourceDurationMs", "rangeSet"], "proposal options");
  const duration = number(options.sourceDurationMs === undefined ? options.rangeSet?.sourceDurationMs : options.sourceDurationMs, 1, FOCUS_LIMITS.sourceDurationMs, "sourceDurationMs", true);
  const ranges = options.rangeSet === undefined ? [{ startMs: 0, endMs: duration }] : retainedRanges(options.rangeSet);
  if (options.rangeSet !== undefined && options.rangeSet.sourceDurationMs !== duration) fail("RangeSet duration mismatch");
  if (!Array.isArray(events) || events.length > FOCUS_LIMITS.events) fail("events: limit exceeded or not an array");
  const ordered = Array.from(events, (event, index) => {
    object(event, ["type", "timeMs", "x", "y", "width", "height", "deltaY"], "event");
    choice(event.type, ["move", "click", "scroll", "viewport"], "event.type");
    number(event.timeMs, 0, duration, "event.timeMs", true);
    for (const key of ["x", "y", "deltaY"])
      if (Object.hasOwn(event, key) && !Number.isFinite(event[key])) fail(`event.${key}: nonfinite`);
    for (const key of ["width", "height"])
      if (Object.hasOwn(event, key)) number(event[key], Number.MIN_VALUE, 32768, `event.${key}`);
    if (event.type === "viewport") {
      number(event.width, Number.MIN_VALUE, 32768, "viewport.width");
      number(event.height, Number.MIN_VALUE, 32768, "viewport.height");
    }
    if (event.type === "scroll" && !Number.isFinite(event.deltaY)) fail("scroll: missing deltaY");
    return { ...event, index };
  }).sort((a, b) => a.timeMs - b.timeMs || a.index - b.index);
  let viewport = null, pending = null;
  const proposals = [], seen = new Set();
  const finish = boundary => {
    if (!pending) return;
    const end = Math.min(pending.lastMs + 1500, pending.startMs + 4000, pending.range.endMs, boundary);
    if (end - pending.startMs >= 500) {
      if (proposals.length >= FOCUS_LIMITS.blocks) fail("proposals exceed focus block limit");
      const blockId = `focus-click-${pending.indices[0]}`;
      proposals.push({
        proposalId: `proposal-${blockId}`, reason: "CLICK_CLUSTER", reviewRequired: true,
        block: { id: blockId, sourceStartMs: pending.startMs, sourceEndMs: end, target: { ...pending.target }, zoom: 1.35, easing: "easeInOutCubic", enabled: true, cursorPolicy: "preserve" },
        evidence: { eventIndices: [...pending.indices], viewportEventIndex: pending.viewportIndex, clickCount: pending.indices.length },
      });
    }
    pending = null;
  };
  for (const event of ordered) {
    const key = JSON.stringify([event.type, event.timeMs, event.x, event.y, event.width, event.height, event.deltaY]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (event.type === "viewport") {
      if (!viewport || event.width !== viewport.width || event.height !== viewport.height) finish(event.timeMs);
      viewport = event;
      continue;
    }
    if (event.type === "scroll") { finish(event.timeMs); continue; }
    const range = ranges.find(range => event.timeMs >= range.startMs && event.timeMs < range.endMs);
    if (!range || !viewport || !Number.isFinite(event.x) || !Number.isFinite(event.y) ||
        event.x < 0 || event.x > viewport.width || event.y < 0 || event.y > viewport.height) {
      // Unknown/offscreen coordinates cannot sustain a prior focus claim.
      finish(event.timeMs);
      continue;
    }
    const point = { x: event.x / viewport.width, y: event.y / viewport.height };
    const near = pending && Math.hypot(point.x - pending.target.x, point.y - pending.target.y) <= 0.08;
    if (pending && (pending.range !== range || !near)) finish(event.timeMs);
    if (event.type === "move") continue;
    if (pending && (event.timeMs - pending.lastMs > 500 || event.timeMs - pending.startMs >= 4000)) finish(event.timeMs);
    if (!pending) pending = { startMs: event.timeMs, lastMs: event.timeMs, target: point, indices: [], viewportIndex: viewport.index, range };
    pending.lastMs = event.timeMs;
    pending.indices.push(event.index);
  }
  finish(duration);
  validateFocusBlocks(proposals.map(proposal => proposal.block), { sourceDurationMs: duration });
  return proposals;
}
