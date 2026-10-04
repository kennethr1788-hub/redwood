// Adversarial visual fixture: far-corner focus, 2x zoom, maximum-length text.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { chromium } from "playwright";
import { renderProject } from "../../src/render/index.js";
import { qualifyFFmpeg, runNative } from "../../src/render/native.js";
const root = fileURLToPath(new URL("../../.test-output/render-r2-edge/", import.meta.url));
await mkdir(path.join(root, "media"), { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.setContent('<body style="margin:0"><canvas width="1280" height="800"></canvas></body>');
  await page.evaluate(() => {
    const c = document.querySelector("canvas").getContext("2d");
    c.fillStyle = "#19343a"; c.fillRect(0, 0, 1280, 800);
    c.strokeStyle = "#4b6c6a";
    for (let x = 0; x < 1280; x += 80) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, 800); c.stroke(); }
    for (let y = 0; y < 800; y += 80) { c.beginPath(); c.moveTo(0, y); c.lineTo(1280, y); c.stroke(); }
    c.fillStyle = "#ffffff"; c.font = "30px sans-serif"; c.fillText("FOCUS / LOWER RIGHT", 910, 640);
    c.fillStyle = "#ff33bb"; c.beginPath(); c.arc(1190, 720, 30, 0, 2 * Math.PI); c.fill();
  });
  const source = path.join(root, "grid.png");
  await page.locator("canvas").screenshot({ path: source });
  const native = await qualifyFFmpeg();
  await runNative(native.binary, ["-v", "error", "-y", "-loop", "1", "-i", source, "-t", "2", "-r", "30", "-pix_fmt", "yuv420p", "-c:v", native.encoder, ...(native.encoder === "h264_videotoolbox" ? ["-allow_sw", "1"] : []), path.join(root, "media/original.mp4")]);
  await renderProject({ projectDir: root, studio: { revision: 0, asset: { path: "media/original.mp4", width: 1280, height: 800, hasAudio: false } }, timeline: {
    trim: { startMs: 0, endMs: 2000 }, title: "A title deliberately long enough to exercise the full one hundred character input budget in Studio R2.".slice(0, 100),
    subtitle: "A subtitle deliberately long enough to exercise wrapping while keeping the frame clear. Preview the lower-right target, then compare its circular shape in both formats.".slice(0, 160),
    theme: "midnight", zoom: 2, focus: { x: 1, y: 1 }, cursor: false,
    captions: [{ startMs: 0, endMs: 2000, text: "A maximum-length caption tests the reserved safe area under the recording. It must remain inside the frame and separate from the product title, browser chrome, and the final signature.".slice(0, 180) }],
  }});
  for (const name of ["landscape", "vertical"]) {
    const frame = path.join(root, `${name}-edge.png`);
    await runNative(native.binary, ["-v", "error", "-y", "-ss", "1.25", "-i", path.join(root, "exports", `${name}.mp4`), "-frames:v", "1", "-update", "1", frame]);
    await page.goto(pathToFileURL(frame).href);
    const marker = await page.locator("img").evaluate(image => {
      const c = document.createElement("canvas"); c.width = image.naturalWidth; c.height = image.naturalHeight;
      const ctx = c.getContext("2d"); ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
      let minX = c.width, minY = c.height, maxX = 0, maxY = 0, count = 0;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (pixels[i] > 210 && pixels[i + 1] < 100 && pixels[i + 2] > 140) {
          minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); count++;
        }
      }
      return { count, width: maxX - minX + 1, height: maxY - minY + 1, minX, minY, maxX, maxY };
    });
    assert.ok(marker.count > 2000, "far-corner focus marker must stay visible");
    assert.ok(Math.abs(marker.width - marker.height) <= 4, "circular marker must not be stretched");
    results.push({ name, marker });
  }
} finally { await browser.close(); }
await writeFile(path.join(root, "edge-check.json"), JSON.stringify({ results, passed: true }, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
