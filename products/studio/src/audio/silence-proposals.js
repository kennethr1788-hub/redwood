import { createHash } from "node:crypto";

// Inert source-time evidence only. No native process, media or timeline writes.
export const LIMITS = Object.freeze({ durationMs: 120000, observations: 256,
  diagnosticBytes: 65536, diagnosticLines: 2048, lineLength: 2048 });
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (message) => { throw new Error(message); };
function integer(value, name, min = 0, max = LIMITS.durationMs) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${name}`);
  return value;
}
function record(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("Expected plain data object");
  if (Object.keys(value).some((key) => !keys.includes(key))) fail("Unknown data field");
  return value;
}
function list(value) {
  if (!Array.isArray(value) || value.length > LIMITS.observations) fail("Unbounded observation list");
  for (let i = 0; i < value.length; i++)
    if (!Object.hasOwn(value, i)) fail("Sparse observation list");
  return value;
}
export function normalizeSourceIdentity(value) {
  record(value, ["sourceSha256", "sourceDurationMs", "timelineRevision", "transcriptRevision"]);
  if (typeof value.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceSha256)) fail("Invalid source hash");
  const result = { sourceSha256: value.sourceSha256,
    sourceDurationMs: integer(value.sourceDurationMs, "source duration", 1),
    timelineRevision: integer(value.timelineRevision, "timeline revision", 0, Number.MAX_SAFE_INTEGER) };
  if (value.transcriptRevision !== undefined)
    result.transcriptRevision = integer(value.transcriptRevision, "transcript revision", 0, Number.MAX_SAFE_INTEGER);
  return result;
}
export function isStaleSource(bound, current) {
  try { return hash(normalizeSourceIdentity(bound)) !== hash(normalizeSourceIdentity(current)); }
  catch { return true; }
}
function settings(value) {
  record(value, ["noiseDb", "minimumDurationMs"]);
  if (typeof value.noiseDb !== "number" || !Number.isFinite(value.noiseDb) ||
      value.noiseDb < -120 || value.noiseDb > 0) fail("Invalid noiseDb");
  return { noiseDb: value.noiseDb,
    minimumDurationMs: integer(value.minimumDurationMs, "detector minimum duration", 1) };
}
function interval(value, duration) {
  const startMs = integer(value.startMs, "startMs", 0, duration);
  const endMs = integer(value.endMs, "endMs", 1, duration);
  if (endMs <= startMs) fail("Empty or reversed interval");
  return { startMs, endMs };
}
function observation(range, sourceIdentity, detector, detectorSettings, evidenceKind) {
  record(range, ["startMs", "endMs", "confidence"]);
  const { startMs, endMs } = interval(range, sourceIdentity.sourceDurationMs);
  const value = { detector, detectorSettings: { ...detectorSettings }, sourceStartMs: startMs,
    sourceEndMs: endMs, evidenceKind, sourceIdentity: { ...sourceIdentity } };
  if (range.confidence !== undefined) {
    if (typeof range.confidence !== "number" || !Number.isFinite(range.confidence) ||
        range.confidence < 0 || range.confidence > 1) fail("Invalid confidence");
    value.confidence = range.confidence;
  }
  return { observationId: `obs-${hash(value)}`, ...value };
}
/** Supplied all-channel amplitude intervals; overlaps remain distinct evidence. */
export function normalizeSilenceObservations(ranges, { sourceIdentity, detectorSettings }) {
  const identity = normalizeSourceIdentity(sourceIdentity), config = settings(detectorSettings);
  return list(ranges).map((range) => observation(range, identity,
    "FFMPEG_SILENCEDETECT", config, "LOW_AMPLITUDE"));
}
/** Accepts the existing silenceCandidates helper's data, never infers audio silence. */
export function normalizeCaptionGaps(gaps, { sourceIdentity }) {
  const identity = normalizeSourceIdentity(sourceIdentity);
  if (identity.transcriptRevision === undefined) fail("Caption gaps require transcript revision");
  return list(gaps).map((gap) => {
    record(gap, ["startMs", "endMs", "reason", "reviewRequired"]);
    if (gap.reason !== undefined && gap.reason !== "caption-gap") fail("Invalid caption gap reason");
    if (gap.reviewRequired !== undefined && gap.reviewRequired !== true) fail("Caption gaps require review");
    return observation({ startMs: gap.startMs, endMs: gap.endMs }, identity,
      "CAPTION_GAPS", {}, "CAPTION_GAP");
  });
}
const NUMBER = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
const START = new RegExp(`^silence_start:\\s*(${NUMBER})$`);
const END = new RegExp(`^silence_end:\\s*(${NUMBER})(?:\\s*\\|\\s*silence_duration:\\s*(${NUMBER}))?$`);
/**
 * Full supplied diagnostic text, or { intervals: [{startMs,endMs,confidence?}], hasAudio? }.
 * Timestamps must use source origin (no seek offset). Only all-channel logs are supported.
 * Incomplete starts are dropped with a warning, never extended to EOF by assumption.
 * A NO_AUDIO marker/hasAudio:false produces no observations, even for silent-looking data.
 */
export function parseSilenceDiagnostics(input, { sourceIdentity, detectorSettings, hasAudio = true }) {
  const identity = normalizeSourceIdentity(sourceIdentity), config = settings(detectorSettings);
  if (typeof hasAudio !== "boolean") fail("Invalid hasAudio");
  let ranges = [], warnings = [], noAudio = !hasAudio;
  if (typeof input !== "string") {
    record(input, ["intervals", "hasAudio"]);
    if (input.hasAudio !== undefined && typeof input.hasAudio !== "boolean") fail("Invalid hasAudio");
    noAudio ||= input.hasAudio === false;
    ranges = list(input.intervals);
  } else {
    if (input.length > LIMITS.diagnosticBytes || Buffer.byteLength(input, "utf8") > LIMITS.diagnosticBytes)
      fail("Unbounded diagnostics");
    const lines = input.split(/\r\n|\n|\r/);
    if (lines.length > LIMITS.diagnosticLines) fail("Too many diagnostic lines");
    let pending, filterIdentity;
    const seconds = (text) => {
      const n = Number(text);
      if (!Number.isFinite(n) || n < 0 || n > identity.sourceDurationMs / 1000) fail("Invalid detector timestamp");
      return n;
    };
    for (const raw of lines) {
      if (raw.length > LIMITS.lineLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw))
        fail("Malformed diagnostic line");
      const line = raw.trim();
      if (line === "NO_AUDIO") { noAudio = true; continue; }
      if (!/silence_(?:start|end|duration)/.test(line)) continue;
      // Reject per-channel, multiple-filter and arbitrary embedded diagnostic fragments.
      const prefix = /^\[(?:Parsed_)?silencedetect(?:_\d+)? @ [^\]\r\n]{1,100}\]\s*/.exec(line);
      const currentFilter = prefix ? prefix[0].trim() : "BARE";
      if (filterIdentity !== undefined && currentFilter !== filterIdentity) fail("Mixed detector streams");
      filterIdentity = currentFilter;
      const payload = prefix ? line.slice(prefix[0].length) : line;
      let match = START.exec(payload);
      if (match) {
        if (pending !== undefined) fail("Unpaired silence start");
        pending = seconds(match[1]);
        continue;
      }
      match = END.exec(payload);
      if (!match || pending === undefined) fail("Malformed or unpaired silence end");
      const end = seconds(match[1]);
      if (end <= pending) fail("Reversed detector interval");
      if (match[2] !== undefined && Math.abs(seconds(match[2]) - (end - pending)) > 0.002)
        fail("Inconsistent detector duration");
      // Round inward so fractional timestamps cannot grow a proposed cut.
      const startMs = Math.ceil(pending * 1000), endMs = Math.floor(end * 1000);
      if (endMs > startMs) ranges.push({ startMs, endMs });
      else warnings.push("SUB_MILLISECOND_INTERVAL_IGNORED");
      if (ranges.length > LIMITS.observations) fail("Too many detector observations");
      pending = undefined;
    }
    if (pending !== undefined) warnings.push("MISSING_END_IGNORED");
  }
  // Validate supplied ranges even in NO_AUDIO input; never hide malformed data.
  const observations = normalizeSilenceObservations(ranges, { sourceIdentity: identity, detectorSettings: config });
  if (noAudio && observations.length) warnings.push("NO_AUDIO_CONFLICT_IGNORED");
  return { status: noAudio ? "NO_AUDIO" : "AUDIO", sourceIdentity: identity,
    observations: noAudio ? [] : observations, warnings };
}
function validateObservation(value, current) {
  record(value, ["observationId", "detector", "detectorSettings", "sourceStartMs", "sourceEndMs",
    "evidenceKind", "sourceIdentity", "confidence"]);
  const identity = normalizeSourceIdentity(value.sourceIdentity);
  if (isStaleSource(identity, current)) fail("Stale observation source");
  let detectorSettings;
  if (value.detector === "FFMPEG_SILENCEDETECT" && value.evidenceKind === "LOW_AMPLITUDE")
    detectorSettings = settings(value.detectorSettings);
  else if (value.detector === "CAPTION_GAPS" && value.evidenceKind === "CAPTION_GAP") {
    record(value.detectorSettings, []);
    if (identity.transcriptRevision === undefined || value.confidence !== undefined) fail("Invalid caption evidence");
    detectorSettings = {};
  } else fail("Unknown detector evidence");
  const normalized = observation({ startMs: value.sourceStartMs, endMs: value.sourceEndMs,
    ...(value.confidence === undefined ? {} : { confidence: value.confidence }) },
  identity, value.detector, detectorSettings, value.evidenceKind);
  if (value.observationId !== normalized.observationId) fail("Observation identity mismatch");
  return normalized;
}
/**
 * KEEP is the default. SHORTEN/REMOVE are explicit suggestion policy, never acceptance.
 * Padding shrinks the editable interior; retained pause is additional to protected edges.
 * Overlapping evidence defaults to KEEP to avoid duplicate/conflicting removal math.
 * keepObservationIds is an operator veto and cannot be overridden by the default action.
 */
export function createSilenceProposals(observations, { sourceIdentity, minimumIntervalMs = 700,
  speechPaddingMs = 100, retainedPauseMs = 300, suggestedAction = "KEEP", keepObservationIds = [] }) {
  const identity = normalizeSourceIdentity(sourceIdentity);
  integer(minimumIntervalMs, "minimum interval", 1);
  integer(speechPaddingMs, "speech padding");
  integer(retainedPauseMs, "retained pause");
  if (!["KEEP", "SHORTEN", "REMOVE"].includes(suggestedAction)) fail("Invalid action");
  if (suggestedAction === "SHORTEN" && retainedPauseMs === 0) fail("SHORTEN requires a retained pause");
  const rows = list(observations).map((value) => validateObservation(value, identity));
  const ids = new Set(rows.map((row) => row.observationId));
  if (ids.size !== rows.length) fail("Duplicate observation identity");
  list(keepObservationIds);
  const keeps = new Set(keepObservationIds);
  if (keeps.size !== keepObservationIds.length || keepObservationIds.some((id) => !ids.has(id)))
    fail("Unknown or duplicate KEEP override");
  return rows.map((row) => {
    const duration = row.sourceEndMs - row.sourceStartMs;
    const overlap = rows.some((other) => other !== row && other.sourceStartMs < row.sourceEndMs &&
      row.sourceStartMs < other.sourceEndMs);
    // No speech beyond the source bounds: pad only internal boundaries, cap at interval size.
    const left = row.sourceStartMs === 0 ? 0 : Math.min(speechPaddingMs, duration);
    const right = row.sourceEndMs === identity.sourceDurationMs ? 0 : Math.min(speechPaddingMs, duration - left);
    const interior = duration - left - right;
    let action = suggestedAction, reason = "LOW_AMPLITUDE_REQUIRES_AUDITION";
    if (keeps.has(row.observationId)) { action = "KEEP"; reason = "OPERATOR_KEEP"; }
    else if (overlap) { action = "KEEP"; reason = "OVERLAPPING_EVIDENCE_REQUIRES_REVIEW"; }
    else if (row.evidenceKind === "CAPTION_GAP") { action = "KEEP"; reason = "CAPTION_GAP_NOT_SILENCE_PROOF"; }
    else if (duration < minimumIntervalMs) { action = "KEEP"; reason = "BELOW_MINIMUM_INTERVAL"; }
    else if (!interior || (action === "SHORTEN" && interior <= retainedPauseMs)) {
      action = "KEEP"; reason = "PADDING_OR_RETAINED_PAUSE_PRESERVES_INTERVAL";
    }
    const startMs = action === "KEEP" ? row.sourceStartMs : row.sourceStartMs + left;
    const endMs = action === "KEEP" ? row.sourceEndMs : row.sourceEndMs - right;
    const retain = action === "KEEP" ? duration : action === "SHORTEN" ? retainedPauseMs : 0;
    const value = { observationId: row.observationId, sourceStartMs: startMs, sourceEndMs: endMs,
      suggestedAction: action, suggestedRetainMs: retain, reason, reviewRequired: true,
      sourceIdentity: { ...identity }, evidenceKind: row.evidenceKind };
    return { proposalId: `proposal-${hash([value, minimumIntervalMs, speechPaddingMs, retainedPauseMs])}`, ...value };
  });
}
