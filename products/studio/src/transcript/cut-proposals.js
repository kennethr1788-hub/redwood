import { createHash } from "node:crypto";

// Pure proposal data only. No store, RangeSet, renderer, ASR or media writes.
const MAX_WORDS = 10000;
const ALIGNMENT = "faster-whisper-word-timestamps";
const clean = (text) => text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/gu, " ");
const fail = (message) => { throw new Error(message); };
function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`Invalid ${label}.`);
  return value;
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${label}.`);
  return value;
}
function duration(value) { return integer(value, 1, 120000, "source duration"); }
function revision(value) { return integer(value, 0, Number.MAX_SAFE_INTEGER, "revision"); }
function id(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/u.test(value))
    fail("Missing or invalid word/caption ID.");
  return value;
}
function sha(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("Invalid source SHA-256.");
  return value;
}
function text(value, max = 10000, empty = false) {
  if (typeof value !== "string" || value.length > max || (!empty && !clean(value).trim()))
    fail("Invalid token/caption text.");
  return clean(value);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
const serialize = (value) => JSON.stringify(stable(value));
const digest = (value) => createHash("sha256").update(serialize(value)).digest("hex");

/** Explicit IDs, source milliseconds, and ASR token whitespace are preserved.
 * This validator alone grants no alignment authority; creation requires raw ASR.
 */
export function normalizeWordTokens(words, sourceDurationMs) {
  duration(sourceDurationMs);
  if (!Array.isArray(words) || !words.length || words.length > MAX_WORDS) fail("Usable word alignment required.");
  const ids = new Set();
  let previousEnd = 0;
  return Array.from(words, (word) => {
    record(word, "word");
    const wordId = id(word.id);
    if (ids.has(wordId)) fail("Duplicate word ID.");
    ids.add(wordId);
    const startMs = integer(word.startMs, previousEnd, sourceDurationMs, "ordered word start");
    const endMs = integer(word.endMs, startMs + 1, sourceDurationMs, "word end");
    previousEnd = endMs;
    return { id: wordId, startMs, endMs, text: text(word.text) };
  });
}

/** Consume existing transcript.json shape, never interpolated captions/SRT/VTT.
 * IDs are positional within the bound transcript revision/content digest.
 * Reject imperfect alignment instead of clamping, sorting or inventing timing.
 */
export function wordsFromTranscript(transcript, sourceDurationMs) {
  duration(sourceDurationMs);
  record(transcript, "transcript");
  if (transcript.schemaVersion !== 1 || transcript.provenance?.engine !== "faster-whisper" ||
      transcript.provenance?.versions?.["faster-whisper"] !== "1.2.1" ||
      transcript.provenance?.settings?.wordTimestamps !== true)
    fail("Usable faster-whisper word alignment required; captions alone cannot propose cuts.");
  sha(transcript.sourceSha256);
  if (!Array.isArray(transcript.segments) || !transcript.segments.length || transcript.segments.length > 200)
    fail("Usable aligned segments required.");
  const words = [];
  let previousSegmentEnd = 0;
  let previousWordEnd = 0;
  const seconds = (value) => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value * 1000 > sourceDurationMs)
      fail("Invalid source word/segment seconds.");
    return value;
  };
  for (const [s, segment] of transcript.segments.entries()) {
    record(segment, "segment");
    const start = seconds(segment.start), end = seconds(segment.end);
    if (end <= start || start < previousSegmentEnd) fail("Reversed or overlapping segments.");
    previousSegmentEnd = end;
    if (!Array.isArray(segment.words) || !segment.words.length || segment.words.length > 2000)
      fail("Usable word alignment required in every segment.");
    const segmentText = text(segment.text).trim();
    const pieces = [];
    for (const [w, word] of segment.words.entries()) {
      record(word, "word");
      const a = seconds(word.start), b = seconds(word.end);
      if (a < start || b > end || b <= a || a < previousWordEnd) fail("Invalid or overlapping word alignment.");
      previousWordEnd = b;
      const piece = text(word.word);
      pieces.push(piece);
      // Segment boundaries supply a separator; inside a segment use ASR spacing.
      words.push({ id: `s${s}:w${w}`, startMs: Math.round(a * 1000), endMs: Math.round(b * 1000),
        text: s > 0 && w === 0 ? ` ${piece.trimStart()}` : piece });
      if (words.length > MAX_WORDS) fail("Too many aligned words.");
    }
    if (clean(pieces.join("")).trim() !== segmentText) fail("Incomplete word alignment; correct/review transcript first.");
  }
  return normalizeWordTokens(words, sourceDurationMs);
}

/** Bind source bytes/duration, caller-owned revisions and actual aligned content.
 * Integration must supply authoritative revisions, not values from imported text.
 */
export function transcriptProvenance(context) {
  record(context, "context");
  const sourceSha256 = sha(context.sourceSha256);
  const sourceDurationMs = duration(context.sourceDurationMs);
  const words = wordsFromTranscript(context.transcript, sourceDurationMs);
  if (context.transcript.sourceSha256 !== sourceSha256) fail("Transcript source identity mismatch.");
  // Include raw alignment too: a sub-ms edit or segmentation change must stale
  // the proposal even if rounded normalized word times happen to be identical.
  const segments = context.transcript.segments.map((s) => ({ start: s.start, end: s.end, text: s.text,
    words: s.words.map((w) => ({ start: w.start, end: w.end, word: w.word })) }));
  return { sourceSha256, sourceDurationMs, transcriptRevision: revision(context.transcriptRevision),
    timelineRevision: revision(context.timelineRevision), timelineIdentity: id(context.timelineIdentity),
    transcriptSha256: digest({ words, segments }), alignment: ALIGNMENT };
}

function select(words, wordIds, wordRange) {
  if ((wordIds === undefined) === (wordRange === undefined)) fail("Supply exactly one explicit word ID selection or range.");
  const indexes = new Map(words.map((word, index) => [word.id, index]));
  let selected;
  if (wordRange !== undefined) {
    record(wordRange, "word range");
    const first = indexes.get(id(wordRange.startWordId)), last = indexes.get(id(wordRange.endWordId));
    if (first === undefined || last === undefined || last < first) fail("Unknown or reversed word range.");
    selected = words.slice(first, last + 1);
  } else {
    if (!Array.isArray(wordIds) || !wordIds.length || wordIds.length > words.length) fail("Empty or invalid word selection.");
    const requested = Array.from(wordIds, (value) => indexes.get(id(value)));
    if (requested.some((value) => value === undefined) || new Set(requested).size !== requested.length)
      fail("Unknown or duplicate selected word ID.");
    requested.sort((a, b) => a - b);
    if (requested.at(-1) - requested[0] + 1 !== requested.length)
      fail("Non-contiguous word selection requires separate proposals.");
    selected = requested.map((index) => words[index]);
  }
  return selected;
}

export function createTranscriptCutProposal(options) {
  const provenance = transcriptProvenance(options);
  const words = wordsFromTranscript(options.transcript, provenance.sourceDurationMs);
  const selected = select(words, options.wordIds, options.wordRange);
  const padding = options.paddingMs === undefined ? {} : record(options.paddingMs, "padding");
  if (Object.keys(padding).some((key) => key !== "before" && key !== "after")) fail("Unknown padding field.");
  const before = integer(padding.before === undefined ? 0 : padding.before, 0, 120000, "before padding");
  const after = integer(padding.after === undefined ? 0 : padding.after, 0, 120000, "after padding");
  const payload = {
    transcriptRevision: provenance.transcriptRevision, timelineRevision: provenance.timelineRevision,
    sourceStartMs: Math.max(0, selected[0].startMs - before),
    sourceEndMs: Math.min(provenance.sourceDurationMs, selected.at(-1).endMs + after),
    wordIds: selected.map((word) => word.id), displayText: clean(selected.map((word) => word.text).join("")).trim(),
    reason: "TRANSCRIPT_SELECTION", reviewRequired: true,
    provenance: { ...provenance, paddingMs: { before, after } },
  };
  return { proposalId: `transcript-cut-${digest(payload)}`, ...payload };
}

/** Deterministic JSON is portable; hashes detect edits, not human approval/auth. */
export function serializeTranscriptCutProposal(proposal) {
  record(proposal, "proposal");
  const { proposalId, ...payload } = proposal;
  if (proposal.reason !== "TRANSCRIPT_SELECTION" || proposal.reviewRequired !== true ||
      proposalId !== `transcript-cut-${digest(payload)}`) fail("Invalid or modified cut proposal.");
  return serialize(proposal);
}

/** Fail closed for malformed/current caption-only input. Recheck immediately
 * before later integration applies a reviewed RangeSet edit; this never applies it.
 */
export function compareProposalProvenance(proposal, current) {
  try { serializeTranscriptCutProposal(proposal); } catch { return { stale: true, reasons: ["INVALID_PROPOSAL"] }; }
  let now;
  try { now = transcriptProvenance(current); } catch { return { stale: true, reasons: ["INVALID_CURRENT_ALIGNMENT_OR_IDENTITY"] }; }
  const reasons = [];
  for (const [key, reason] of [
    ["sourceSha256", "SOURCE_CHANGED"], ["sourceDurationMs", "SOURCE_DURATION_CHANGED"],
    ["transcriptRevision", "TRANSCRIPT_REVISION_CHANGED"], ["timelineRevision", "TIMELINE_REVISION_CHANGED"],
    ["timelineIdentity", "TIMELINE_IDENTITY_CHANGED"],
    ["transcriptSha256", "TRANSCRIPT_CONTENT_CHANGED"], ["alignment", "ALIGNMENT_CHANGED"],
  ]) if (proposal.provenance?.[key] !== now[key]) reasons.push(reason);
  if (!reasons.length) {
    try {
      const rebuilt = createTranscriptCutProposal({ ...current, wordIds: proposal.wordIds, paddingMs: proposal.provenance.paddingMs });
      if (serializeTranscriptCutProposal(rebuilt) !== serializeTranscriptCutProposal(proposal)) reasons.push("PROPOSAL_CHANGED");
    } catch { reasons.push("INVALID_PROPOSAL"); }
  }
  return { stale: reasons.length > 0, reasons };
}

export function isTranscriptCutProposalStale(proposal, current) {
  return compareProposalProvenance(proposal, current).stale;
}

/** Text-only metadata, including inserted/deleted text. No inherited word timing
 * authority after correction; integration must invalidate/review that alignment.
 */
export function createCaptionTextCorrection({ captionId, caption, replacementText, sourceDurationMs,
  sourceSha256, transcriptRevision, timelineRevision }) {
  record(caption, "caption");
  duration(sourceDurationMs);
  const sourceStartMs = integer(caption.startMs, 0, sourceDurationMs, "caption start");
  const sourceEndMs = integer(caption.endMs, sourceStartMs + 1, sourceDurationMs, "caption end");
  return { kind: "CAPTION_TEXT_CORRECTION", captionId: id(captionId),
    beforeText: text(caption.text, 180, true).trim(), replacementText: text(replacementText, 180, true).trim(),
    sourceStartMs, sourceEndMs, sourceSha256: sha(sourceSha256), sourceDurationMs,
    transcriptRevision: revision(transcriptRevision), timelineRevision: revision(timelineRevision),
    mediaCut: false, wordAlignment: "REQUIRES_REVIEW", reviewRequired: true };
}
