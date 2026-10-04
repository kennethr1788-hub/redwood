import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { transcribeProject } from "../../src/transcript/index.js";
import { defaultTimeline } from "../../src/core/schema.js";

test("no-audio, absent runtime, missing source and failed extraction preserve input", async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), "transcript-failures-"));
  const names = ["STUDIO_PYTHON", "STUDIO_WHISPER_MODEL", "FFMPEG_PATH"];
  const previous = Object.fromEntries(names.map((k) => [k, process.env[k]]));
  const studio = { schemaVersion: 1, id: randomUUID(), name: "Failure fixture", createdAt: new Date().toISOString(),
    asset: { path: "media/original.mp4", sha256: "0".repeat(64), width: 640, height: 360, durationMs: 4000, hasAudio: true },
    input: { kind: "import" }, revision: 0 };
  const timeline = { ...defaultTimeline(studio), captions: [{ startMs: 0, endMs: 1000, text: "Keep this edit" }] };
  const before = JSON.stringify(timeline);
  try {
    process.env.STUDIO_PYTHON = path.join(projectDir, "absent-python");
    await assert.rejects(transcribeProject({ projectDir, studio: { ...studio, asset: { ...studio.asset, hasAudio: false } }, timeline }), /no audio track/);
    await assert.rejects(transcribeProject({ projectDir, studio, timeline }), /not configured/);
    process.env.STUDIO_PYTHON = process.execPath;
    process.env.STUDIO_WHISPER_MODEL = projectDir;
    await assert.rejects(transcribeProject({ projectDir, studio, timeline }), /missing or unreadable/);
    await mkdir(path.join(projectDir, "media"));
    await writeFile(path.join(projectDir, studio.asset.path), "unreadable synthetic media");
    process.env.FFMPEG_PATH = path.join(projectDir, "absent-ffmpeg");
    await assert.rejects(transcribeProject({ projectDir, studio, timeline }), /Cannot read.*audio/);
    assert.equal(JSON.stringify(timeline), before);
    assert.ok(!(await readdir(projectDir)).some((s) => s.startsWith(".asr-")));
  } finally {
    for (const k of names) previous[k] === undefined ? delete process.env[k] : process.env[k] = previous[k];
    await rm(projectDir, { recursive: true, force: true });
  }
});
