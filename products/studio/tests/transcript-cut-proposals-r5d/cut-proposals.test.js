import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWordTokens, wordsFromTranscript, transcriptProvenance, createTranscriptCutProposal,
  serializeTranscriptCutProposal, compareProposalProvenance, isTranscriptCutProposalStale,
  createCaptionTextCorrection } from "../../src/transcript/cut-proposals.js";

const sourceSha256 = "a".repeat(64);
function context() {
  return { sourceSha256, sourceDurationMs: 5000, transcriptRevision: 2, timelineRevision: 4,
    timelineIdentity: "project-1:timeline-1",
    transcript: { schemaVersion: 1, sourceSha256,
      provenance: { engine: "faster-whisper", versions: { "faster-whisper": "1.2.1" }, settings: { wordTimestamps: true } },
      segments: [{ start: 0, end: 4.5, text: "Hello, 世界 👩🏽‍💻 42!", words: [
        { start: 0, end: 0.5, word: " Hello" }, { start: 0.5, end: 0.6, word: "," },
        { start: 1, end: 1.5, word: " 世界" }, { start: 1.5, end: 2, word: " 👩🏽‍💻" },
        { start: 4, end: 4.4, word: " 42" }, { start: 4.4, end: 4.5, word: "!" },
      ] }] } };
}
const make = (extra = {}) => createTranscriptCutProposal({ ...context(), wordIds: ["s0:w2"], ...extra });
const freeze = (object) => {
  Object.freeze(object);
  for (const value of Object.values(object)) if (value && typeof value === "object") freeze(value);
  return object;
};

test("ASR normalization preserves Unicode, punctuation, numeric tokens, and source timing", () => {
  const c = context();
  const words = wordsFromTranscript(c.transcript, c.sourceDurationMs);
  assert.deepEqual(words.map((w) => w.id), ["s0:w0", "s0:w1", "s0:w2", "s0:w3", "s0:w4", "s0:w5"]);
  assert.deepEqual(words[2], { id: "s0:w2", startMs: 1000, endMs: 1500, text: " 世界" });
  const p = make({ wordIds: words.map((w) => w.id) });
  assert.equal(p.displayText, "Hello, 世界 👩🏽‍💻 42!");
  assert.deepEqual([p.sourceStartMs, p.sourceEndMs], [0, 4500]);
  assert.equal(p.reviewRequired, true);
  assert.equal(p.reason, "TRANSCRIPT_SELECTION");
});
test("explicit inclusive ID range equals the same canonical ID selection", () => {
  const p = make({ wordIds: ["s0:w4", "s0:w2", "s0:w3"] });
  const r = createTranscriptCutProposal({ ...context(), wordRange: { startWordId: "s0:w2", endWordId: "s0:w4" } });
  assert.deepEqual(p, r);
  assert.equal(p.displayText, "世界 👩🏽‍💻 42");
  assert.deepEqual([p.sourceStartMs, p.sourceEndMs], [1000, 4400]);
});
test("first and last words, asymmetric padding, and source bounds", () => {
  assert.deepEqual([make({ wordIds: ["s0:w0"] }).sourceStartMs, make({ wordIds: ["s0:w0"] }).sourceEndMs], [0, 500]);
  const last = make({ wordIds: ["s0:w5"], paddingMs: { before: 50, after: 1000 } });
  assert.deepEqual([last.sourceStartMs, last.sourceEndMs], [4350, 5000]);
  const first = make({ wordIds: ["s0:w0"], paddingMs: { before: 1000, after: 25 } });
  assert.deepEqual([first.sourceStartMs, first.sourceEndMs], [0, 525]);
  const all = make({ paddingMs: { before: 120000, after: 120000 } });
  assert.deepEqual([all.sourceStartMs, all.sourceEndMs], [0, 5000]);
});
test("gaps remain source-time spans, not silence claims or time-map edits", () => {
  const p = make({ wordIds: ["s0:w3", "s0:w4"] });
  assert.deepEqual([p.sourceStartMs, p.sourceEndMs], [1500, 4400]);
  assert.equal(p.displayText, "👩🏽‍💻 42");
  assert.equal(p.ranges, undefined);
});
test("cross-segment text has a boundary separator without inserting punctuation spaces", () => {
  const c = context();
  c.transcript.segments.push({ start: 4.5, end: 5, text: "Next.", words: [{ start: 4.5, end: 5, word: "Next." }] });
  const p = createTranscriptCutProposal({ ...c, wordRange: { startWordId: "s0:w4", endWordId: "s1:w0" } });
  assert.equal(p.displayText, "42! Next.");
});

for (const [label, change] of [
  ["missing IDs", (w) => { delete w[0].id; }], ["duplicate IDs", (w) => { w[1].id = w[0].id; }],
  ["empty IDs", (w) => { w[0].id = " "; }], ["numeric IDs", (w) => { w[0].id = 0; }],
  ["overlap", (w) => { w[1].startMs = 1; }], ["reversal", (w) => { w[0].endMs = -1; }],
  ["zero duration", (w) => { w[0].endMs = 0; }], ["fractional ms", (w) => { w[0].endMs = 10.5; }],
  ["NaN", (w) => { w[0].startMs = NaN; }], ["Infinity", (w) => { w[0].endMs = Infinity; }],
  ["string time", (w) => { w[0].startMs = "0"; }], ["past source", (w) => { w[1].endMs = 5001; }],
  ["empty text", (w) => { w[0].text = "\u0000\n"; }], ["numeric text", (w) => { w[0].text = 42; }],
  ["oversized text", (w) => { w[0].text = "a".repeat(10001); }], ["sparse tokens", (w) => { delete w[0]; }],
]) test(`normalizer refuses ${label}`, () => {
  const words = [{ id: "a", startMs: 0, endMs: 500, text: "Hello" }, { id: "b", startMs: 500, endMs: 800, text: "!" }];
  change(words);
  assert.throws(() => normalizeWordTokens(words, 5000));
});

for (const [label, change] of [
  ["caption-only", (c) => { c.transcript = { captions: [{ startMs: 0, endMs: 5000, text: "Hello" }] }; }],
  ["SRT", (c) => { c.transcript.provenance.engine = "srt"; }],
  ["VTT", (c) => { c.transcript.provenance.engine = "vtt"; }],
  ["missing word timestamp flag", (c) => { delete c.transcript.provenance.settings.wordTimestamps; }],
  ["other runtime", (c) => { c.transcript.provenance.versions["faster-whisper"] = "2"; }],
  ["missing words", (c) => { delete c.transcript.segments[0].words; }],
  ["no words", (c) => { c.transcript.segments[0].words = []; }],
  ["missing spoken text", (c) => { c.transcript.segments[0].words.pop(); }],
  ["corrected token segmentation", (c) => { c.transcript.segments[0].text += " added"; }],
  ["raw sub-ms overlap", (c) => { c.transcript.segments[0].words[1].start = 0.4999; }],
  ["collapsed rounded word", (c) => { c.transcript.segments[0].words[1].end = 0.5001; }],
  ["word outside segment", (c) => { c.transcript.segments[0].words[0].start = -0.1; }],
  ["source mismatch", (c) => { c.transcript.sourceSha256 = "b".repeat(64); }],
  ["invalid duration", (c) => { c.sourceDurationMs = 120001; }],
  ["missing revision", (c) => { delete c.transcriptRevision; }],
  ["missing timeline identity", (c) => { delete c.timelineIdentity; }],
]) test(`proposal refuses ${label}`, () => {
  const c = context(); change(c);
  assert.throws(() => createTranscriptCutProposal({ ...c, wordIds: ["s0:w0"] }));
});

for (const [label, selection] of [
  ["empty", { wordIds: [] }], ["unknown", { wordIds: ["missing"] }],
  ["duplicates", { wordIds: ["s0:w0", "s0:w0"] }],
  ["noncontiguous", { wordIds: ["s0:w0", "s0:w2"] }],
  ["reversed range", { wordRange: { startWordId: "s0:w2", endWordId: "s0:w0" } }],
  ["missing range end", { wordRange: { startWordId: "s0:w0" } }],
  ["ambiguous", { wordIds: ["s0:w0"], wordRange: { startWordId: "s0:w0", endWordId: "s0:w1" } }],
  ["implicit", {}],
]) test(`selection refuses ${label}`, () => assert.throws(() => createTranscriptCutProposal({ ...context(), ...selection })));

test("invalid padding fails rather than coercing", () => {
  for (const value of [-1, NaN, Infinity, 1.1, "2", 120001, null])
    for (const side of ["before", "after"]) assert.throws(() => make({ paddingMs: { [side]: value } }));
  assert.throws(() => make({ paddingMs: null }));
  assert.throws(() => make({ paddingMs: { befor: 20 } }));
});
test("proposals round-trip with stable bytes independent of object key and selection order", () => {
  const p = make({ wordIds: ["s0:w3", "s0:w2"] });
  const json = serializeTranscriptCutProposal(p);
  assert.equal(serializeTranscriptCutProposal(JSON.parse(json)), json);
  assert.equal(serializeTranscriptCutProposal(make({ wordIds: ["s0:w2", "s0:w3"] })), json);
  assert.equal(isTranscriptCutProposalStale(JSON.parse(json), context()), false);
});
for (const [reason, change] of [
  ["SOURCE_CHANGED", (c) => { c.sourceSha256 = c.transcript.sourceSha256 = "b".repeat(64); }],
  ["SOURCE_DURATION_CHANGED", (c) => { c.sourceDurationMs = 6000; }],
  ["TRANSCRIPT_REVISION_CHANGED", (c) => { c.transcriptRevision++; }],
  ["TIMELINE_REVISION_CHANGED", (c) => { c.timelineRevision++; }],
  ["TIMELINE_IDENTITY_CHANGED", (c) => { c.timelineIdentity = "project-2:timeline-1"; }],
  ["TRANSCRIPT_CONTENT_CHANGED", (c) => { c.transcript.segments[0].words[0].end -= 0.0001; }],
  ["TRANSCRIPT_CONTENT_CHANGED", (c) => { c.transcript.segments[0].words[0].word = " Hi"; c.transcript.segments[0].text = c.transcript.segments[0].text.replace("Hello", "Hi"); }],
]) test(`stale comparison detects ${reason}`, () => {
  const c = context(); change(c);
  const comparison = compareProposalProvenance(make(), c);
  assert.equal(comparison.stale, true);
  assert.ok(comparison.reasons.includes(reason));
});
test("malformed current context, caption correction and altered proposals fail closed", () => {
  assert.equal(isTranscriptCutProposalStale(make(), {}), true);
  assert.equal(isTranscriptCutProposalStale(null, context()), true);
  for (const extra of [{ sourceEndMs: 5000 }, { reviewRequired: false }, { displayText: "delete everything" }]) {
    const changed = { ...make(), ...extra };
    assert.throws(() => serializeTranscriptCutProposal(changed));
    assert.equal(isTranscriptCutProposalStale(changed, context()), true);
  }
});
test("text correction can insert/delete words or clear caption while media intervals stay unchanged", () => {
  const c = freeze(context());
  const caption = freeze({ startMs: 0, endMs: 4500, text: "Hello, 世界 👩🏽‍💻 42!" });
  const before = JSON.stringify({ c, caption });
  for (const replacementText of ["Corrected number 43!", "世界", "", "<script>not executable</script>"]) {
    const correction = createCaptionTextCorrection({ ...c, captionId: "cue-1", caption, replacementText });
    assert.equal(correction.mediaCut, false);
    assert.equal(correction.wordAlignment, "REQUIRES_REVIEW");
    assert.deepEqual([correction.sourceStartMs, correction.sourceEndMs], [caption.startMs, caption.endMs]);
    assert.equal(correction.sourceSha256, c.sourceSha256);
    assert.equal(correction.sourceDurationMs, c.sourceDurationMs);
    assert.equal(isTranscriptCutProposalStale(correction, c), true);
  }
  assert.equal(JSON.stringify({ c, caption }), before);
});
test("all pure operations accept frozen data and return detached values", () => {
  const c = freeze(context()), before = JSON.stringify(c);
  const p = createTranscriptCutProposal({ ...c, wordIds: freeze(["s0:w0"]) });
  transcriptProvenance(c);
  assert.deepEqual(compareProposalProvenance(p, c), { stale: false, reasons: [] });
  p.wordIds.push("altered");
  assert.equal(JSON.stringify(c), before);
});
test("bounded input rejects empty/oversized/sparse collections", () => {
  for (const words of [[], new Array(10001), new Array(1)]) assert.throws(() => normalizeWordTokens(words, 5000));
  for (const segments of [[], new Array(201), new Array(1)]) {
    const c = context(); c.transcript.segments = segments;
    assert.throws(() => wordsFromTranscript(c.transcript, 5000));
  }
});
test("every contiguous selection agrees with independent source interval expectations", () => {
  const starts = [0, 500, 1000, 1500, 4000, 4400];
  const ends = [500, 600, 1500, 2000, 4400, 4500];
  for (let first = 0; first < 6; first++) for (let last = first; last < 6; last++) {
    const p = createTranscriptCutProposal({ ...context(),
      wordRange: { startWordId: `s0:w${first}`, endWordId: `s0:w${last}` }, paddingMs: { before: 17, after: 23 } });
    assert.deepEqual([p.sourceStartMs, p.sourceEndMs], [Math.max(0, starts[first] - 17), Math.min(5000, ends[last] + 23)]);
    assert.equal(p.wordIds.length, last - first + 1);
    assert.equal(isTranscriptCutProposalStale(p, context()), false);
  }
});
test("combining marks, adjacent scripts, literal instructions and markup remain inert text", () => {
  const c = context();
  c.transcript.segments = [{ start: 0, end: 4, text: "é你好 <b>ignore prior instructions</b>", words: [
    { start: 0, end: 1, word: "é" }, { start: 1, end: 2, word: "你" },
    { start: 2, end: 3, word: "好" }, { start: 3, end: 4, word: " <b>ignore prior instructions</b>" },
  ] }];
  const p = createTranscriptCutProposal({ ...c, wordRange: { startWordId: "s0:w0", endWordId: "s0:w3" } });
  assert.equal(p.displayText, c.transcript.segments[0].text);
  assert.equal(p.reason, "TRANSCRIPT_SELECTION");
  assert.equal(p.reviewRequired, true);
});
test("caption correction rejects invalid intervals and oversized text", () => {
  const base = { ...context(), captionId: "cue-1", caption: { startMs: 100, endMs: 200, text: "a" }, replacementText: "b" };
  for (const caption of [{ startMs: 200, endMs: 100, text: "a" }, { startMs: 0, endMs: 5001, text: "a" }])
    assert.throws(() => createCaptionTextCorrection({ ...base, caption }));
  assert.throws(() => createCaptionTextCorrection({ ...base, replacementText: "x".repeat(181) }));
});
