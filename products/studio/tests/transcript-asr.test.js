import test from "node:test";
import assert from "node:assert/strict";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  captionsFromSegments,
  transcribeProject,
} from "../src/transcript/index.js";
import { defaultTimeline } from "../src/core/schema.js";

test("ASR caption admission bounds timestamps, text and number", () => {
  const caps = captionsFromSegments(
    [{ start: 0.2, end: 4.2, text: " A local transcript. " }],
    4000,
  );
  assert.deepEqual(caps, [
    { startMs: 200, endMs: 4000, text: "A local transcript." },
  ]);
  assert.throws(
    () => captionsFromSegments([{ start: 2, end: 1, text: "invalid" }], 4000),
    /invalid/,
  );
  assert.throws(
    () =>
      captionsFromSegments(
        [
          { start: 0, end: 2, text: "first" },
          { start: 1, end: 3, text: "overlap" },
        ],
        4000,
      ),
    /overlapping/,
  );
  assert.throws(() =>
    captionsFromSegments([{ start: NaN, end: 1, text: "invalid" }], 4000),
  );
  assert.throws(
    () =>
      captionsFromSegments(
        Array.from({ length: 41 }, (_, i) => ({
          start: i,
          end: i + 0.8,
          text: "caption",
        })),
        60000,
      ),
    /40 captions/,
  );
});

test("long ASR segments split for review without executable interpretation", () => {
  const text = "A caption with <script>untrusted text</script>. ".repeat(8);
  const result = captionsFromSegments([{ start: 0, end: 6, text }], 6000);
  assert.ok(result.length > 1);
  assert.ok(
    result.every(
      (c) =>
        c.text.length <= 180 &&
        Number.isInteger(c.startMs) &&
        c.endMs > c.startMs,
    ),
  );
  assert.equal(result.at(-1).endMs, 6000);
  assert.ok(
    result
      .map((c) => c.text)
      .join(" ")
      .includes("<script>"),
  );
});

test(
  "real qualified small model transcribes supplied synthetic audio offline",
  { skip: process.env.STUDIO_ASR_TEST !== "1" },
  async () => {
    assert.ok(
      process.env.STUDIO_ASR_FIXTURE,
      "Set STUDIO_ASR_FIXTURE to existing qualified fixture.mp4",
    );
    const projectDir = await mkdtemp(
      path.join(os.tmpdir(), "studio-asr-test-"),
    );
    try {
      await mkdir(path.join(projectDir, "media"));
      await copyFile(
        process.env.STUDIO_ASR_FIXTURE,
        path.join(projectDir, "media/original.mp4"),
      );
      const source = await readFile(
        path.join(projectDir, "media/original.mp4"),
      );
      const studio = {
        schemaVersion: 1,
        id: randomUUID(),
        name: "Synthetic speech",
        createdAt: new Date().toISOString(),
        asset: {
          path: "media/original.mp4",
          sha256: createHash("sha256").update(source).digest("hex"),
          width: 640,
          height: 360,
          durationMs: 8000,
          hasAudio: true,
        },
        input: { kind: "import" },
        revision: 0,
      };
      const timeline = defaultTimeline(studio);
      const before = JSON.stringify(timeline);
      const result = await transcribeProject({ projectDir, studio, timeline });
      assert.equal(
        JSON.stringify(timeline),
        before,
        "ASR must not mutate accepted timeline",
      );
      assert.ok(result.captions.length > 0 && result.captions.length <= 40);
      const text = result.captions
        .map((c) => c.text)
        .join(" ")
        .toLowerCase();
      assert.match(text, /blue bicycle/);
      assert.match(text, /tomorrow morning/);
      assert.equal(
        result.transcript.provenance.versions["faster-whisper"],
        "1.2.1",
      );
      assert.equal(
        result.transcript.provenance.networkSandbox,
        process.platform === "darwin",
      );
      assert.equal(result.transcript.reviewRequired, true);
      assert.ok(
        !(await readdir(projectDir)).some((name) => name.startsWith(".asr-")),
      );
      console.log(
        JSON.stringify({
          captions: result.captions,
          inferenceSeconds: result.transcript.inferenceSeconds,
          provenance: result.transcript.provenance,
        }),
      );
      await assert.rejects(
        transcribeProject({
          projectDir,
          studio: { ...studio, asset: { ...studio.asset, hasAudio: false } },
          timeline,
        }),
        /no audio/,
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  },
);
