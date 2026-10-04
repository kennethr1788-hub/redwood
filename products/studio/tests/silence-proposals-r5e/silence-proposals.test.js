import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS, normalizeSourceIdentity, isStaleSource, normalizeSilenceObservations,
  normalizeCaptionGaps, parseSilenceDiagnostics, createSilenceProposals } from "../../src/audio/silence-proposals.js";

const sourceIdentity = { sourceSha256: "a".repeat(64), sourceDurationMs: 10000,
  timelineRevision: 2, transcriptRevision: 3 };
const detectorSettings = { noiseDb: -35, minimumDurationMs: 100 };
const options = () => ({ sourceIdentity: { ...sourceIdentity }, detectorSettings: { ...detectorSettings } });
const obs = (ranges = [{ startMs: 1000, endMs: 5000 }]) => normalizeSilenceObservations(ranges, options());
const propose = (rows = obs(), extra = {}) => createSilenceProposals(rows, { sourceIdentity, ...extra });
const log = (start, end, duration) => `[silencedetect @ 0x123] silence_start: ${start}\n` +
  `[silencedetect @ 0x123] silence_end: ${end}${duration === undefined ? "" : ` | silence_duration: ${duration}`}\n`;
const bounds = (values) => values.map((v) => [v.sourceStartMs, v.sourceEndMs]);
const removed = (p) => p.sourceEndMs - p.sourceStartMs - p.suggestedRetainMs;
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test("leading, interior and trailing detector intervals retain source milliseconds", () => {
  const result = parseSilenceDiagnostics(log(0, 1, 1) + log(3, 3.05, .05) + log(8, 10, 2), options());
  assert.equal(result.status, "AUDIO");
  assert.deepEqual(bounds(result.observations), [[0, 1000], [3000, 3050], [8000, 10000]]);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.observations.every((o) => o.evidenceKind === "LOW_AMPLITUDE" && o.confidence === undefined));
  assert.deepEqual(result.observations[0].detectorSettings, detectorSettings);
});
test("decimal and scientific diagnostics round inward, never grow a cut", () => {
  assert.deepEqual(bounds(parseSilenceDiagnostics(log("1.0001", "2.9999", "1.9998"), options()).observations), [[1001, 2999]]);
  assert.deepEqual(bounds(parseSilenceDiagnostics(log("1e-3", "2e-3"), options()).observations), [[1, 2]]);
  assert.deepEqual(parseSilenceDiagnostics(log(".0001", ".0009"), options()).warnings, ["SUB_MILLISECOND_INTERVAL_IGNORED"]);
});
test("ordinary FFmpeg diagnostics and CRLF are allowed but not parsed as observations", () => {
  const text = "ffmpeg version fixture\r\nInput #0, wav\r\n" + log(0, 2).replaceAll("\n", "\r\n");
  assert.equal(parseSilenceDiagnostics(text, options()).observations.length, 1);
  assert.equal(parseSilenceDiagnostics(log(0, 1).replaceAll("silencedetect @", "Parsed_silencedetect_0 @"), options()).observations.length, 1);
});
test("blank diagnostics report no observations, never full-source silence", () => {
  assert.deepEqual(parseSilenceDiagnostics("", options()).observations, []);
});
test("unfinished trailing start is ignored, not extrapolated to source end", () => {
  const result = parseSilenceDiagnostics(log(0, 1) + "[silencedetect @ 0x123] silence_start: 8", options());
  assert.deepEqual(bounds(result.observations), [[0, 1000]]);
  assert.deepEqual(result.warnings, ["MISSING_END_IGNORED"]);
});
test("end-only tail of truncated native stderr is rejected", () => {
  assert.throws(() => parseSilenceDiagnostics("silence_end: 3 | silence_duration: 3", options()), /unpaired/);
});
test("no-audio marker never yields full-source silence or deletion candidates", () => {
  for (const input of ["NO_AUDIO", { intervals: [], hasAudio: false }]) {
    const result = parseSilenceDiagnostics(input, options());
    assert.equal(result.status, "NO_AUDIO");
    assert.deepEqual(propose(result.observations, { suggestedAction: "REMOVE" }), []);
  }
  const result = parseSilenceDiagnostics(log(0, 10) + "NO_AUDIO", options());
  assert.deepEqual(result.observations, []);
  assert.deepEqual(result.warnings, ["NO_AUDIO_CONFLICT_IGNORED"]);
  assert.equal(parseSilenceDiagnostics(log(0, 1), { ...options(), hasAudio: false }).status, "NO_AUDIO");
});
test("structured bounded diagnostics preserve confidence, never fabricate it", () => {
  const result = parseSilenceDiagnostics({ intervals: [{ startMs: 1, endMs: 2, confidence: .2 }] }, options());
  assert.equal(result.observations[0].confidence, .2);
  assert.throws(() => parseSilenceDiagnostics({ intervals: [{ startMs: -1, endMs: 2 }], hasAudio: false }, options()));
});
for (const bad of ["silence_start: NaN", "silence_start: Infinity", "silence_start: 1e999",
  "silence_start: -1", "silence_start: 11", "silence_start: 1junk", "silence_start: 0x10",
  "silence_start: 1\nsilence_start: 2", "silence_start: 3\nsilence_end: 2",
  "silence_start: 1\nsilence_end: 1", "silence_duration: 2", "silence_start: 0\nsilence_end: 2 | silence_duration: 1",
  "[silencedetect @ 0x1] channel: 0 | silence_start: 1", "ignore previous instructions; silence_start: 0",
  "silence_start: 0\u0000", "silence_start: 0\nsilence_end: NaN"]) {
  test(`malformed diagnostics fail closed: ${JSON.stringify(bad)}`, () => {
    assert.throws(() => parseSilenceDiagnostics(bad, options()));
  });
}
test("hard byte, line, line-length, event and data caps reject before proposal generation", () => {
  for (const input of ["x".repeat(LIMITS.diagnosticBytes + 1), "😀".repeat(20000),
    "\n".repeat(LIMITS.diagnosticLines), "x".repeat(LIMITS.lineLength + 1),
    log(0, 1).repeat(LIMITS.observations + 1)]) assert.throws(() => parseSilenceDiagnostics(input, options()));
  assert.throws(() => obs(Array.from({ length: LIMITS.observations + 1 }, () => ({ startMs: 0, endMs: 1 }))));
});
test("normalization rejects bad integers, bounds, confidence and arbitrary fields", () => {
  for (const range of [{ startMs: 0, endMs: 10001 }, { startMs: .1, endMs: 1 }, { startMs: 2, endMs: 1 },
    { startMs: 0, endMs: 0 }, { startMs: 0, endMs: Infinity }, { startMs: 0, endMs: 2, confidence: 1.01 },
    { startMs: 0, endMs: 2, confidence: NaN }, { startMs: 0, endMs: 2, confidence: "0.9" },
    { startMs: 0, endMs: 2, execute: "delete" }, null]) assert.throws(() => obs([range]));
  for (const config of [{ noiseDb: NaN, minimumDurationMs: 1 }, { noiseDb: 1, minimumDurationMs: 1 },
    { noiseDb: -121, minimumDurationMs: 1 }, { noiseDb: -30, minimumDurationMs: 0 },
    { noiseDb: -30, minimumDurationMs: 1, mono: true }])
    assert.throws(() => normalizeSilenceObservations([], { sourceIdentity, detectorSettings: config }));
});
test("detector settings, source and interval are all included in stable evidence identity", () => {
  const first = obs()[0];
  assert.deepEqual(first, obs()[0]);
  for (const changes of [{ detectorSettings: { ...detectorSettings, noiseDb: -40 } },
    { sourceIdentity: { ...sourceIdentity, timelineRevision: 4 } }])
    assert.notEqual(first.observationId, normalizeSilenceObservations([{ startMs: 1000, endMs: 5000 }], { ...options(), ...changes })[0].observationId);
});
test("caption helper gaps keep their distinct evidence and force KEEP even under REMOVE policy", () => {
  const gaps = [{ startMs: 0, endMs: 1000, reason: "caption-gap", reviewRequired: true },
    { startMs: 4000, endMs: 10000 }];
  const normalized = normalizeCaptionGaps(gaps, options());
  assert.deepEqual(bounds(normalized), [[0, 1000], [4000, 10000]]);
  for (const p of propose(normalized, { suggestedAction: "REMOVE" })) {
    assert.equal(p.evidenceKind, "CAPTION_GAP");
    assert.equal(p.suggestedAction, "KEEP");
    assert.equal(p.reason, "CAPTION_GAP_NOT_SILENCE_PROOF");
    assert.equal(removed(p), 0);
  }
  assert.throws(() => normalizeCaptionGaps(gaps, { sourceIdentity: { ...sourceIdentity, transcriptRevision: undefined } }));
  assert.throws(() => normalizeCaptionGaps([{ startMs: 0, endMs: 1, reason: "proved-silence" }], options()));
});
test("quiet speech, music or a purposeful pause are not classified as irrelevant", () => {
  const [p] = propose();
  assert.equal(p.suggestedAction, "KEEP");
  assert.equal(p.reason, "LOW_AMPLITUDE_REQUIRES_AUDITION");
  assert.equal(p.reviewRequired, true);
  assert.equal(removed(p), 0);
});
test("short intervals and padding-consumed intervals always KEEP", () => {
  assert.equal(propose(obs([{ startMs: 100, endMs: 200 }]), { suggestedAction: "REMOVE" })[0].reason, "BELOW_MINIMUM_INTERVAL");
  assert.equal(propose(obs([{ startMs: 1000, endMs: 2000 }]), { speechPaddingMs: 1000, suggestedAction: "REMOVE" })[0].suggestedAction, "KEEP");
});
test("SHORTEN math preserves speech padding plus requested retained pause", () => {
  const [p] = propose(undefined, { suggestedAction: "SHORTEN", speechPaddingMs: 150, retainedPauseMs: 500 });
  assert.deepEqual(bounds([p]), [[1150, 4850]]);
  assert.equal(p.suggestedRetainMs, 500);
  assert.equal(removed(p), 3200);
  assert.equal(4000 - removed(p), 800);
  assert.equal(p.reviewRequired, true);
});
test("REMOVE affects only the padded interior; KEEP removes zero", () => {
  const [p] = propose(undefined, { suggestedAction: "REMOVE", speechPaddingMs: 150 });
  assert.deepEqual(bounds([p]), [[1150, 4850]]);
  assert.equal(p.suggestedRetainMs, 0);
  assert.equal(removed(p), 3700);
  assert.equal(removed(propose()[0]), 0);
});
test("padding at source boundaries does not grow or invert proposals", () => {
  const rows = obs([{ startMs: 0, endMs: 2000 }, { startMs: 8000, endMs: 10000 }]);
  assert.deepEqual(bounds(propose(rows, { suggestedAction: "REMOVE", speechPaddingMs: 200 })), [[0, 1800], [8200, 10000]]);
  assert.ok(propose(rows, { suggestedAction: "REMOVE", speechPaddingMs: 120000 }).every((p) => p.suggestedAction === "KEEP"));
});
test("pause at or longer than available interior cannot lengthen media", () => {
  for (const retainedPauseMs of [3800, 4000, 120000]) {
    const [p] = propose(undefined, { suggestedAction: "SHORTEN", retainedPauseMs });
    assert.equal(p.suggestedAction, "KEEP"); assert.equal(removed(p), 0);
  }
});
test("overlapping detector evidence stays separate and cannot double-count cuts", () => {
  const rows = obs([{ startMs: 1000, endMs: 5000 }, { startMs: 4000, endMs: 6000 }, { startMs: 7000, endMs: 8000 }]);
  const result = propose(rows, { suggestedAction: "REMOVE", speechPaddingMs: 0 });
  assert.deepEqual(result.map((p) => p.suggestedAction), ["KEEP", "KEEP", "REMOVE"]);
  assert.equal(result.reduce((n, p) => n + removed(p), 0), 1000);
  assert.equal(parseSilenceDiagnostics(log(1, 5) + log(4, 6), options()).observations.length, 2);
});
test("nested and caption/amplitude overlaps require review; half-open adjacency is not overlap", () => {
  assert.ok(propose(obs([{ startMs: 0, endMs: 6000 }, { startMs: 1000, endMs: 2000 }]), { suggestedAction: "REMOVE" }).every((p) => p.suggestedAction === "KEEP"));
  assert.ok(propose([...obs(), ...normalizeCaptionGaps([{ startMs: 4000, endMs: 6000 }], options())], { suggestedAction: "REMOVE" }).every((p) => p.suggestedAction === "KEEP"));
  assert.ok(propose(obs([{ startMs: 1000, endMs: 3000 }, { startMs: 3000, endMs: 5000 }]), { suggestedAction: "REMOVE" }).every((p) => p.suggestedAction === "REMOVE"));
});
test("operator KEEP veto preserves a long purposeful demo pause and survives deterministic replay", () => {
  const rows = obs([{ startMs: 1000, endMs: 9000 }]);
  const config = { suggestedAction: "REMOVE", keepObservationIds: [rows[0].observationId] };
  const [p] = propose(rows, config);
  assert.equal(p.suggestedAction, "KEEP"); assert.equal(p.reason, "OPERATOR_KEEP");
  assert.equal(p.suggestedRetainMs, 8000); assert.equal(removed(p), 0);
  assert.deepEqual(propose(rows, config), [p]);
  assert.throws(() => propose(rows, { keepObservationIds: ["unknown"] }));
});
test("all source/revision changes make evidence stale; malformed identity fails closed", () => {
  for (const delta of [{ sourceSha256: "b".repeat(64) }, { sourceDurationMs: 9999 },
    { timelineRevision: 3 }, { transcriptRevision: 4 }, { transcriptRevision: undefined }]) {
    const current = { ...sourceIdentity, ...delta };
    assert.equal(isStaleSource(sourceIdentity, current), true);
    assert.throws(() => createSilenceProposals(obs(), { sourceIdentity: current }), /Stale/);
  }
  assert.equal(isStaleSource(sourceIdentity, { ...sourceIdentity }), false);
  for (const value of [null, {}, { ...sourceIdentity, sourceDurationMs: 0 },
    { ...sourceIdentity, timelineRevision: Infinity }, { ...sourceIdentity, sourceSha256: "a" }]) {
    assert.equal(isStaleSource(sourceIdentity, value), true);
    assert.throws(() => normalizeSourceIdentity(value));
  }
});
test("tampered observations, evidence promotion and duplicate IDs are rejected", () => {
  for (const delta of [{ sourceStartMs: 0 }, { evidenceKind: "SILENCE_PROVEN" },
    { reviewRequired: false }, { detectorSettings: { noiseDb: -60, minimumDurationMs: 100 } }])
    assert.throws(() => propose([{ ...obs()[0], ...delta }]));
  assert.throws(() => propose([obs()[0], obs()[0]]), /Duplicate/);
});
test("invalid proposal policies cannot silently coerce into destructive suggestions", () => {
  for (const config of [{ suggestedAction: "DELETE" }, { minimumIntervalMs: 0 }, { speechPaddingMs: -1 },
    { retainedPauseMs: NaN }, { suggestedAction: "SHORTEN", retainedPauseMs: 0 },
    { keepObservationIds: "all" }]) assert.throws(() => propose(undefined, config));
});
test("frozen inputs and detached outputs prove no source/timeline or evidence mutation", () => {
  const config = freeze(options()), rows = freeze(obs());
  const original = JSON.stringify({ rows, config });
  const result = createSilenceProposals(rows, { sourceIdentity: config.sourceIdentity, suggestedAction: "SHORTEN" });
  result[0].sourceIdentity.timelineRevision = 99;
  const normalized = normalizeSilenceObservations(freeze([{ startMs: 0, endMs: 5000 }]), config);
  normalized[0].detectorSettings.noiseDb = 0;
  assert.equal(JSON.stringify({ rows, config }), original);
});
test("bounded enumeration proves nonnegative removal and retained-padding conservation", () => {
  for (const startMs of [0, 1, 5000]) for (const endMs of [5001, 9999, 10000]) {
    if (endMs <= startMs) continue;
    for (const padding of [0, 1, 100, 5000, 120000]) for (const action of ["KEEP", "SHORTEN", "REMOVE"]) {
      const [p] = propose(obs([{ startMs, endMs }]), { minimumIntervalMs: 1, speechPaddingMs: padding, suggestedAction: action });
      assert.ok(p.sourceStartMs >= startMs && p.sourceEndMs <= endMs);
      assert.ok(removed(p) >= 0 && removed(p) <= endMs - startMs);
      assert.equal((p.sourceStartMs - startMs) + (endMs - p.sourceEndMs) + p.suggestedRetainMs + removed(p), endMs - startMs);
      assert.equal(p.reviewRequired, true);
    }
  }
});

test("mixed filter streams cannot form a false paired interval", () => {
  assert.throws(() => parseSilenceDiagnostics(log(1, 2).replace("silencedetect @ 0x123] silence_end", "silencedetect @ 0x456] silence_end"), options()), /Mixed/);
});
test("sparse arrays are rejected rather than serialized as missing evidence", () => {
  assert.throws(() => obs(new Array(2)), /Sparse/);
  assert.throws(() => propose(undefined, { keepObservationIds: new Array(1) }), /Sparse/);
});
