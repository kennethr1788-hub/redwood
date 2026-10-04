import test from "node:test";
import assert from "node:assert/strict";
import { cameraMotion, coverTime } from "../../src/render/camera.js";
import { layoutFor } from "../../src/render/visual.js";
import { cursorExpressions } from "../../src/render/motion.js";
import { writeShare } from "../../src/export/share.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Evaluate FFmpeg's small arithmetic expression vocabulary independently of
// camera.sample; this checks the actual expressions shipped to the compositor.
function evaluate(expression, t) {
  return Function("t", "clip", `return ${expression}`)(t, (x, a, b) => Math.max(a, Math.min(b, x)));
}
const timeline = { trim: { startMs: 1200, endMs: 9200 }, zoom: 1.7, focus: { x: 0.75, y: 0.3 } };

test("portrait gives wide recordings a 700px focus window instead of a letterbox", () => {
  const l = layoutFor(720, 1280, { width: 1280, height: 800 });
  assert.equal(l.videoHeight, 700);
  assert.ok(l.videoHeight / (616 / 1.6) > 1.8);
  assert.ok(l.y + l.videoHeight < l.captionTop);
});

test("camera expressions stay inside source at corners, without stretching, across shapes and trims", async () => {
  for (const [width, height] of [[1280, 800], [1920, 1080], [1080, 1920], [3440, 1440], [800, 800]]) {
    for (const [w, h] of [[1280, 720], [720, 1280]]) {
      for (const focus of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.73, y: 0.21 }]) {
        const layout = layoutFor(w, h, { width, height });
        const c = await cameraMotion(layout, { width, height }, { ...timeline, focus });
        const exp = c.expressions("t");
        assert.ok(Math.abs(c.sourceWidth / c.sourceHeight - width / height) < 0.01);
        for (let t = 0; t <= 8; t += 1 / 30) {
          const zoom = evaluate(exp.zoom, t), x = evaluate(exp.x, t), y = evaluate(exp.y, t);
          const cropW = c.canvasWidth / zoom, cropH = c.canvasHeight / zoom;
          assert.ok(zoom >= 1 && zoom <= 10); // FFmpeg zoompan's supported range.
          assert.ok(x >= -0.01 && y >= -0.01);
          assert.ok(x + cropW <= c.sourceWidth + 0.1);
          assert.ok(y + cropH <= c.sourceHeight + 0.1);
          assert.ok(Math.abs(cropW / cropH - layout.videoWidth / layout.videoHeight) < 1e-8);
        }
      }
    }
  }
});

test("short clips do not get an outro; settled cover time remains in clip", async () => {
  for (const duration of [0.5, 1, 3.99, 4, 8, 120]) {
    const c = await cameraMotion(layoutFor(720, 1280, { width: 1280, height: 720 }), { width: 1280, height: 720 }, {
      ...timeline, trim: { startMs: 0, endMs: duration * 1000 },
    });
    assert.ok(coverTime(duration) > 0 && coverTime(duration) < duration);
    assert.ok(c.sample(duration).zoom > c.cover);
    if (duration < 4) assert.equal(c.sample(duration).zoom, c.cover * timeline.zoom);
  }
});

test("cursor remains bounded, reaches late clicks, and does not invent pre-event motion", async () => {
  const events = Array.from({ length: 500 }, (_, i) => ({ type: i % 5 ? "move" : "click", timeMs: i * 20, x: i, y: 100 }));
  const p = await cursorExpressions(events, { asset: { width: 500, height: 500 } }, { trim: { startMs: 0, endMs: 10000 } }, 500, 500);
  assert.equal(evaluate(p.x, 10), 494);
  assert.ok(p.x.length < 100000);
  const late = await cursorExpressions([{ type: "click", timeMs: 3000, x: 100, y: 100 }], { asset: { width: 500, height: 500 } }, { trim: { startMs: 0, endMs: 5000 } }, 500, 500);
  assert.equal(late.start, 3);
});

test("both portable previews use exact exports, escaped titles and no executable script", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "studio-share-r2-"));
  try {
    await writeShare(dir, '<script>alert("x")</script>', "A & B");
    for (const [file, video] of [["index.html", "landscape.mp4"], ["portrait.html", "vertical.mp4"]]) {
      const html = await readFile(path.join(dir, file), "utf8");
      assert.ok(html.includes(`src="${video}"`));
      assert.ok(html.includes("&lt;script&gt;"));
      assert.ok(!html.includes("<script"));
      assert.ok(!html.includes("https://"));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("trimmed cursor starts at latest prior sample; duplicate timestamps do not jump backwards", async () => {
  const events = [
    ...Array.from({ length: 100 }, (_, i) => ({ type: "click", timeMs: i * 10, x: 0, y: 0 })),
    { type: "move", timeMs: 1199, x: 150, y: 100 },
    { type: "move", timeMs: 2000, x: 240, y: 100 },
    { type: "click", timeMs: 2000, x: 250, y: 100 },
    { type: "click", timeMs: 4000, x: 400, y: 100 },
  ];
  const p = await cursorExpressions(events, { asset: { width: 500, height: 500 } }, timeline, 500, 500);
  assert.equal(evaluate(p.x, 0), 145);
  assert.ok(Math.abs(evaluate(p.x, 0.8) - 245) < 0.01);
  assert.ok(Math.abs(evaluate(p.x, 2.8) - 395) < 0.01);
});

test("extreme accepted aspect ratios never exceed FFmpeg's zoom ceiling", async () => {
  for (const asset of [{ width: 7680, height: 16 }, { width: 16, height: 4320 }]) {
    for (const [w, h] of [[1280, 720], [720, 1280]]) {
      const layout = layoutFor(w, h, asset);
      const c = await cameraMotion(layout, asset, { ...timeline, zoom: 2 });
      assert.ok(layout.videoWidth >= 2 && layout.videoHeight >= 2);
      assert.ok(c.sample(3).zoom <= 10);
    }
  }
});
