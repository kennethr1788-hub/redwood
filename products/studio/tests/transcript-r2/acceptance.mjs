// Real qualified offline ASR, existing editor, reopened state, native captions,
// existing SRT CLI and new transcript export CLI. Synthetic fixture only.
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { startServer } from "../../src/server.js";
import { Store } from "../../src/core/store.js";
import { binary, run } from "../../src/core/media.js";
import { renderProject } from "../../src/render/index.js";
import { transcribeProject } from "../../src/transcript/index.js";
import { parseSrt, parseVtt, serializeVtt } from "../../src/transcript/srt.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = join(root, ".test-output/transcript-r2");
const fixture = process.env.STUDIO_ASR_FIXTURE;
if (!fixture || !process.env.STUDIO_PYTHON || !process.env.STUDIO_WHISPER_MODEL)
  throw Error("Set STUDIO_ASR_FIXTURE, STUDIO_PYTHON and STUDIO_WHISPER_MODEL to the existing qualified runtime.");
await mkdir(out, { recursive: true });
const app = await startServer({ port: 0, root: join(out, "projects") });
const browser = await chromium.launch({ headless: true });
const errors = [], checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.url);
  await page.locator("#new-project").click();
  await page.locator("#new-name").fill("Transcript R2 acceptance");
  await page.locator("#media-file").setInputFiles(fixture);
  await page.locator("#create-project").click();
  await page.locator("#editor").waitFor({ state: "visible" });
  await page.locator("summary").filter({ hasText: "Captions" }).click();
  const response = page.waitForResponse((r) => r.url().endsWith("/transcribe") && r.request().method() === "POST");
  await page.locator("#transcribe").click();
  const r = await response;
  const p = await r.json();
  assert.equal(r.status(), 200, JSON.stringify(p));
  const id = p.studio.id, projectDir = app.store.dir(id);
  const draft = JSON.parse(await readFile(join(projectDir, "transcript.json"), "utf8"));
  assert.equal(draft.provenance.settings.wordTimestamps, true);
  assert.ok(draft.segments.every((s) => s.words.length > 0));
  assert.equal(draft.reviewRequired, true);
  assert.equal(draft.provenance.offline, true);
  if (process.platform === "darwin") assert.equal(draft.provenance.networkSandbox, true);
  assert.match(p.timeline.captions.map((c) => c.text).join(" "), /blue bicycle/i);
  checks.push("real offline qualified ASR and persisted word timestamps");

  const edit = "Saved edit: captions use my reviewed words.";
  await page.locator("[data-text]").first().fill(edit);
  await page.locator("#trim-start").fill("0.5");
  await page.locator("#trim-end").fill("2.5");
  const savedResponse = page.waitForResponse((r) => r.request().method() === "PUT");
  await page.locator("#save").click();
  assert.equal((await savedResponse).status(), 200);
  await page.reload();
  await page.locator("#editor").waitFor({ state: "visible" });
  assert.equal(await page.locator("[data-text]").first().inputValue(), edit);
  const reopened = await new Store(app.store.root).get(id);
  assert.equal(reopened.timeline.captions[0].text, edit);
  assert.equal(reopened.timeline.captions[0].startMs, p.timeline.captions[0].startMs);
  assert.equal(reopened.timeline.captions[0].endMs, p.timeline.captions[0].endMs);
  const native = await renderProject({ projectDir, ...reopened });
  const renderedVtt = await readFile(join(projectDir, "exports/captions.vtt"), "utf8");
  assert.match(renderedVtt, /Saved edit/);
  assert.doesNotMatch(renderedVtt, /blue bicycle/i);
  const playback = [];
  for (const name of ["landscape", "vertical"]) {
    const file = join(projectDir, "exports", `${name}.mp4`);
    await page.goto(pathToFileURL(file).href);
    await page.locator("video").waitFor();
    await page.evaluate(async () => { const v = document.querySelector("video"); v.muted = true; await v.play(); });
    await page.waitForFunction(() => document.querySelector("video").ended);
    playback.push(await page.evaluate(() => { const v = document.querySelector("video"); return { width: v.videoWidth, height: v.videoHeight, ended: v.ended, error: v.error?.message || null }; }));
    await run(binary("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-y", "-ss", "0.5", "-i", file, "-frames:v", "1", "-update", "1", join(out, `${name}.png`)]);
  }
  assert.ok(playback.every((p) => p.ended && p.error === null));
  checks.push("browser text edit/reload, new Store reopen, native render and both videos played to end");

  const oldRoot = process.env.STUDIO_PROJECTS_DIR;
  process.env.STUDIO_PROJECTS_DIR = app.store.root;
  let srt;
  try {
    srt = await run(process.execPath, [join(root, "src/transcript/cli.js"), "export", id, "srt"]);
    const vtt = await run(process.execPath, [join(root, "src/transcript/cli.js"), "export", id, "vtt"]);
    assert.deepEqual(parseSrt(srt), parseVtt(vtt));
    assert.equal(parseSrt(srt)[0].startMs, 0);
    assert.equal(parseSrt(srt)[0].endMs, reopened.timeline.captions[0].endMs - 500);
    await writeFile(join(out, "captions.srt"), srt);
    await writeFile(join(out, "captions.vtt"), vtt);
    const imported = JSON.parse(await run(process.execPath, [join(root, "src/cli.js"), "captions", id, join(out, "captions.srt"), String(reopened.studio.revision)]));
    assert.deepEqual(imported.timeline.captions, parseSrt(srt));
    const updated = JSON.parse(await run(process.execPath, [join(root, "src/transcript/cli.js"), "import", id, "vtt", join(out, "captions.vtt"), String(imported.studio.revision)]));
    assert.deepEqual((await new Store(app.store.root).get(id)).timeline.captions, updated.timeline.captions);
    await assert.rejects(run(process.execPath, [join(root, "src/transcript/cli.js"), "import", id, "vtt", join(out, "captions.vtt"), String(imported.studio.revision)]), /changed since opening/);
  } finally { oldRoot === undefined ? delete process.env.STUDIO_PROJECTS_DIR : process.env.STUDIO_PROJECTS_DIR = oldRoot; }
  checks.push("existing SRT CLI, VTT CLI, SRT/VTT trim rebasing, saved imports and stale revision rejection");

  // Independent browser WebVTT parser proves escaping is interpreted as text.
  const escaped = serializeVtt([{ startMs: 0, endMs: 1000, text: "A <literal> & --> test" }]);
  await page.goto(app.url);
  const parsed = await page.evaluate(async (vtt) => {
    const video = document.createElement("video"), track = document.createElement("track");
    const url = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
    try {
      video.append(track); document.body.append(video); track.kind = "captions"; track.src = url; track.track.mode = "hidden";
      await new Promise((resolve, reject) => { track.onload = resolve; track.onerror = () => reject(Error("VTT parser failed")); });
      return [...track.track.cues].map((c) => ({ text: c.getCueAsHTML().textContent, start: c.startTime, end: c.endTime }));
    } finally { video.remove(); URL.revokeObjectURL(url); }
  }, escaped);
  assert.deepEqual(parsed, [{ text: "A <literal> & --> test", start: 0, end: 1 }]);
  checks.push("Chromium WebVTT parser recovered literal markup, entities and exact times");

  const silentPath = join(out, "silent.mp4");
  await run(binary("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-y", "-i", fixture, "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-map", "0:v:0", "-map", "1:a:0", "-t", "1", "-c:v", "copy", "-c:a", "aac", silentPath]);
  const importedSilent = await app.store.importMedia(silentPath);
  const silent = await app.store.save(importedSilent.studio.id, 0, {
    ...importedSilent.timeline, captions: [{ startMs: 0, endMs: 1000, text: "Keep my existing caption" }],
  });
  const silentDir = app.store.dir(silent.studio.id);
  const silentBefore = await readFile(join(silentDir, "state.json"), "utf8");
  const noSpeech = await transcribeProject({ projectDir: silentDir, ...silent });
  assert.deepEqual(noSpeech.captions, []);
  assert.equal(await readFile(join(silentDir, "state.json"), "utf8"), silentBefore);
  assert.ok(!(await readdir(silentDir)).some((n) => n.startsWith(".asr-")));
  const config = await (await fetch(app.url + "/api/config")).json();
  const postTranscribe = async (project) => fetch(`${app.url}/api/projects/${project.studio.id}/transcribe`, {
    method: "POST", headers: { "content-type": "application/json", "x-studio-token": config.csrfToken },
    body: JSON.stringify({ revision: project.studio.revision }),
  });
  const silentResponse = await postTranscribe(silent);
  assert.equal(silentResponse.status, 400);
  assert.match((await silentResponse.json()).error, /No speech found.*left unchanged/);
  assert.equal(await readFile(join(silentDir, "state.json"), "utf8"), silentBefore);
  const noAudioPath = join(out, "no-audio.mp4");
  await run(binary("ffmpeg"), ["-hide_banner", "-loglevel", "error", "-y", "-i", fixture, "-t", "1", "-c:v", "copy", "-an", noAudioPath]);
  const noAudio = await app.store.importMedia(noAudioPath);
  assert.equal(noAudio.studio.asset.hasAudio, false);
  const noAudioResponse = await postTranscribe(noAudio);
  assert.equal(noAudioResponse.status, 400);
  assert.match((await noAudioResponse.json()).error, /no audio track/);
  const model = process.env.STUDIO_WHISPER_MODEL;
  try {
    process.env.STUDIO_WHISPER_MODEL = out; // exists, but has no model files
    await assert.rejects(transcribeProject({ projectDir, ...reopened }), /unavailable.*invalid data/);
    const current = await app.store.get(id);
    const before = await readFile(join(projectDir, "state.json"), "utf8");
    const failed = await postTranscribe(current);
    assert.equal(failed.status, 400);
    assert.match((await failed.json()).error, /unavailable.*invalid data/);
    assert.equal(await readFile(join(projectDir, "state.json"), "utf8"), before);
    assert.ok(!(await readdir(projectDir)).some((n) => n.startsWith(".asr-")));
  } finally { process.env.STUDIO_WHISPER_MODEL = model; }
  checks.push("digital-silence, no-audio and broken-model HTTP failures preserve state; temp cleanup");
  assert.deepEqual(errors, []);
  const evidence = { passed: true, checks, projectId: id, inferenceSeconds: draft.inferenceSeconds,
    provenance: draft.provenance, draftCaptions: p.timeline.captions, savedCaptions: reopened.timeline.captions,
    playback, nativeEngine: native.engine, browserErrors: errors };
  await writeFile(join(out, "acceptance.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser.close();
  await new Promise((resolve) => app.server.close(resolve));
}
