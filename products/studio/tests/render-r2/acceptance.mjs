// Run after npm run test:e2e. Verify its final exports, not a second renderer.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { runNative } from "../../src/render/native.js";
import { binary, run } from "../../src/core/media.js";
const root = fileURLToPath(new URL("../../", import.meta.url));
const baseline = JSON.parse(await readFile(path.join(root, ".test-output/acceptance/acceptance.json")));
assert.equal(baseline.passed, true);
const exportsDir = path.join(baseline.projectDir, "exports");
const out = path.join(root, ".test-output/render-r2");
await mkdir(out, { recursive: true });
const receipt = JSON.parse(await readFile(path.join(exportsDir, "render.json")));
assert.equal(receipt.composition.version, "render-r2");
assert.equal(receipt.engine.licenseProfile, "GPL_LOCAL_COMPETITION_ONLY");
const sha = async file => createHash("sha256").update(await readFile(file)).digest("hex");
const evidence = { projectDir: baseline.projectDir, outputs: [], browser: [], gifFrames: [] };
for (const file of ["landscape.mp4", "vertical.mp4", "demo.gif"]) {
  const media = path.join(exportsDir, file);
  await runNative(binary("ffmpeg"), ["-v", "error", "-xerror", "-i", media, "-f", "null", "-"]);
  const meta = JSON.parse(await run(binary("ffprobe"), ["-v", "error", "-show_streams", "-show_format", "-of", "json", media]));
  const stream = meta.streams.find(s => s.codec_type === "video");
  evidence.outputs.push({ file, sha256: await sha(media), width: stream.width, height: stream.height, codec: stream.codec_name, duration: Number(meta.format.duration), frames: Number(stream.nb_frames), decode: "all frames decoded, -xerror, exit 0" });
  if (file === "demo.gif") {
    assert.ok(Number(stream.nb_frames) >= 100);
    for (const t of [0.5, 2, 4]) {
      const output = path.join(out, `gif-${t}.png`);
      await runNative(binary("ffmpeg"), ["-v", "error", "-y", "-ss", String(t), "-i", media, "-frames:v", "1", "-update", "1", output]);
      evidence.gifFrames.push(await sha(output));
    }
    assert.equal(new Set(evidence.gifFrames).size, 3);
  }
}
for (const name of ["landscape", "vertical"]) {
  const thumbnail = name === "landscape" ? "thumbnail.png" : "vertical-thumbnail.png";
  const reference = path.join(out, `${name}-cover-reference.png`);
  await runNative(binary("ffmpeg"), ["-v", "error", "-y", "-ss", String(receipt.composition.thumbnailTimeSeconds), "-i", path.join(exportsDir, `${name}.mp4`), "-frames:v", "1", "-update", "1", reference]);
  assert.equal(await sha(reference), await sha(path.join(exportsDir, thumbnail)));
}
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  for (const [share, orientation] of [["index.html", "landscape"], ["portrait.html", "vertical"]]) {
    await page.goto(pathToFileURL(path.join(exportsDir, share)).href);
    await page.waitForFunction(() => document.querySelector("video")?.readyState >= 2);
    assert.equal(await page.locator("video").count(), 1);
    for (const href of await page.locator("a").evaluateAll(links => links.map(a => a.getAttribute("href")))) await readFile(path.join(exportsDir, href));
    await page.evaluate(async () => { const v = document.querySelector("video"); v.muted = true; await v.play(); });
    await page.waitForFunction(() => { const v = document.querySelector("video"); return v.currentTime >= v.duration / 2; });
    await page.screenshot({ path: path.join(out, `${orientation}-playing.png`), fullPage: true });
    await page.waitForFunction(() => document.querySelector("video").ended, {}, { timeout: 20000 });
    const playback = await page.locator("video").evaluate(v => ({ ended: v.ended, time: v.currentTime, duration: v.duration, error: v.error, width: v.videoWidth, height: v.videoHeight }));
    assert.equal(playback.error, null);
    evidence.browser.push({ share, ...playback });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(out, `${orientation}-mobile.png`), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 1000 });
  }
  for (const file of ["thumbnail.png", "vertical-thumbnail.png", "demo.gif"]) {
    await page.goto(pathToFileURL(path.join(exportsDir, file)).href);
    assert.ok(await page.locator("img").evaluate(i => i.complete && i.naturalWidth > 0));
    await page.screenshot({ path: path.join(out, `${file}-opened.png`) });
  }
  assert.deepEqual(errors, []);
  evidence.errors = errors;
} finally { await browser.close(); }
evidence.passed = true;
await writeFile(path.join(out, "inspection.json"), JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));
