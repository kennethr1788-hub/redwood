import test from "node:test";
import assert from "node:assert/strict";
import { captionsFromSegments, captionLines, silenceCandidates, validateCaptions } from "../../src/transcript/captions.js";
import { parseSrt, parseVtt, serializeSrt, serializeVtt } from "../../src/transcript/srt.js";

const words = [
  { start: 0.5, end: 1, word: " One" },
  { start: 1, end: 1.6, word: " sentence." },
  { start: 3, end: 3.5, word: " After" },
  { start: 3.5, end: 4, word: " pause." },
];
test("word alignment preserves speech onsets, offsets and pauses", () => {
  assert.deepEqual(captionsFromSegments([{ start: 0, end: 5, text: "One sentence. After pause.", words }], 5000), [
    { startMs: 500, endMs: 1600, text: "One sentence." },
    { startMs: 3000, endMs: 4000, text: "After pause." },
  ]);
});
test("incomplete or invalid alignment falls back without losing segment text", () => {
  for (const bad of [words.slice(1), words.map((w) => ({ ...w, end: 0 })), []]) {
    const result = captionsFromSegments([{ start: 0, end: 5, text: "One sentence. After pause.", words: bad }], 5000);
    assert.deepEqual(result, [{ startMs: 0, endMs: 5000, text: "One sentence. After pause." }]);
  }
});
test("long segments become bounded readable chunks with integer, contiguous timing", () => {
  const text = "Inspect this transcript and edit the words before rendering the final caption. ".repeat(5).trim();
  const cues = captionsFromSegments([{ start: 0.123, end: 24.001, text }], 24000);
  assert.equal(cues.map((c) => c.text).join(" "), text);
  assert.equal(cues[0].startMs, 123);
  assert.equal(cues.at(-1).endMs, 24000);
  for (const [i, c] of cues.entries()) {
    assert.ok(c.text.length <= 84);
    assert.ok(c.endMs > c.startMs);
    if (i) assert.equal(cues[i - 1].endMs, c.startMs);
  }
  const line = "Caption lines should split cleanly at a balanced word boundary.";
  assert.equal(captionLines(line).join(" "), line);
  assert.ok(captionLines(line).every((s) => s.length <= 42));
});
test("silence candidates are only labeled gaps, including leading and trailing", () => {
  const cues = [{ startMs: 1000, endMs: 2000, text: "Hello" }, { startMs: 2800, endMs: 3500, text: "World" }];
  assert.deepEqual(silenceCandidates(cues, 5000).map((c) => [c.startMs, c.endMs]), [[0, 1000], [2000, 2800], [3500, 5000]]);
  assert.ok(silenceCandidates(cues, 5000).every((c) => c.reason === "caption-gap" && c.reviewRequired));
  assert.throws(() => silenceCandidates(cues, 5000, 0));
});
test("subtitle import supports BOM, CRLF, indexless cues, markup and entities", () => {
  const srt = '\uFEFF1\r\n00:00:00,250 --> 00:00:02,000\r\n<b>Hello</b> &amp;\r\nworld\r\n\r\n00:00:03.000 --> 00:00:04.000\r\n&#x1F600; &lt;literal&gt;';
  assert.deepEqual(parseSrt(srt, 5000), [
    { startMs: 250, endMs: 2000, text: "Hello & world" },
    { startMs: 3000, endMs: 4000, text: "😀 <literal>" },
  ]);
});
test("invalid imports fail before writes; no empty, reversed, overlapping or oversized data", () => {
  for (const input of ["", "1\n00:00:61,000 --> 00:01:02,000\nbad", "1\n00:00:02,000 --> 00:00:01,000\nbad",
    "1\n00:00:01,000 --> 00:00:02,000\n<i></i>", "1\n00:00:01,000 --> 00:00:02,000\n\u0000",
    "1\n00:00:00,000 --> 00:00:02,000\nOne\n\n2\n00:00:01,999 --> 00:00:03,000\nTwo",
    "1\n00:00:00,000 --> 00:00:06,000\nExceeds source",
    "😀".repeat(30000)]) assert.throws(() => parseSrt(input, 5000));
  assert.throws(() => parseSrt(Array.from({ length: 41 }, (_, i) => `${i + 1}\n00:00:${String(i).padStart(2, "0")},000 --> 00:00:${String(i).padStart(2, "0")},500\nx`).join("\n\n")), /40 captions/);
  assert.throws(() => validateCaptions([{ startMs: 0, endMs: 1, text: "\u0000" }]));
});
test("SRT and VTT exports clip, rebase to trim, escape literal text and round trip", () => {
  const cues = [{ startMs: 500, endMs: 2000, text: 'Hello <literal> & --> "world"' },
    { startMs: 2000, endMs: 4000, text: "Final words" }];
  const options = { durationMs: 5000, trim: { startMs: 1000, endMs: 3000 } };
  const expected = [{ ...cues[0], startMs: 0, endMs: 1000 }, { ...cues[1], startMs: 1000, endMs: 2000 }];
  assert.deepEqual(parseSrt(serializeSrt(cues, options)), expected);
  assert.deepEqual(parseVtt(serializeVtt(cues, options)), expected);
  assert.match(serializeVtt(cues, options), /^WEBVTT\n\n1\n00:00:00\.000 --> 00:00:01\.000/);
  assert.throws(() => serializeSrt(cues, { trim: { startMs: -1, endMs: 1 } }));
  assert.equal(serializeSrt([]), "");
  assert.equal(serializeVtt([]), "WEBVTT\n\n");
});
test("plain VTT imports cue identifiers, settings, short timestamps and notes", () => {
  assert.deepEqual(parseVtt("WEBVTT\n\nNOTE reviewer comment\nignored\n\ncue-name\n00:00.100 --> 00:01.000 align:start\nHello"), [{ startMs: 100, endMs: 1000, text: "Hello" }]);
  assert.throws(() => parseVtt("WEBVTT\n00:00.100 --> 00:01.000\nHello"));
});

test("separately aligned punctuation does not gain invented whitespace", () => {
  const cues = captionsFromSegments([{ start: 0, end: 1, text: "Hello, world!", words: [
    { start: 0, end: 0.2, word: " Hello" }, { start: 0.2, end: 0.3, word: "," },
    { start: 0.3, end: 0.8, word: " world" }, { start: 0.8, end: 1, word: "!" },
  ] }], 1000);
  assert.equal(cues[0].text, "Hello, world!");
});
