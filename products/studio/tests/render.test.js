import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  motionTiming,
  cursorExpressions,
  piecewiseExpression,
} from "../src/render/motion.js";
import { qualifyFFmpeg } from "../src/render/native.js";
import { renderProject } from "../src/render/index.js";
import { escapeHTML } from "../src/export/share.js";

test("Motion Canvas easing preserves endpoints and eases both ends", async () => {
  const { easeInOutCubic } = await motionTiming();
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(0.5), 0.5);
  assert.ok(easeInOutCubic(0.1) < 0.1);
  assert.ok(easeInOutCubic(0.9) > 0.9);
});
test("cursor expressions need actual recorded events", async () => {
  assert.equal(
    await cursorExpressions(
      [],
      { asset: { width: 1280, height: 720 } },
      { trim: { startMs: 0, endMs: 5000 } },
      640,
      360,
    ),
    null,
  );
  assert.equal(
    piecewiseExpression([
      [0, 4],
      [1, 4],
    ]),
    "4",
  );
});
test("missing original is rejected before tools or output mutations", async () => {
  await assert.rejects(
    () =>
      renderProject({
        projectDir: "/nonexistent-studio-test",
        studio: { asset: { path: "media/missing.mp4" } },
        timeline: { trim: { startMs: 0, endMs: 1000 }, zoom: 1, captions: [] },
      }),
    /Original media is missing/,
  );
});
test("static share text is HTML escaped", () => {
  assert.equal(escapeHTML('<script>"&'), "&lt;script&gt;&quot;&amp;");
});
test("native FFmpeg permits qualified local GPL use and rejects nonfree", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-render-test-"));
  try {
    for (const [flag, encoder] of [
      ["gpl", "h264_videotoolbox"],
      ["gpl", "libx264"],
      ["nonfree", "libx264"],
      ["", "libopenh264"],
    ]) {
      const binary = path.join(temp, `fake-${flag}-${encoder}`);
      await writeFile(
        binary,
        `#!/bin/sh\nprintf 'ffmpeg version test\\nconfiguration: ${flag ? "--enable-" + flag : "--disable-gpl"}\\n V..... ${encoder}\\n'\n`,
      );
      await chmod(binary, 0o700);
      if (flag === "nonfree")
        await assert.rejects(
          () => qualifyFFmpeg(binary),
          /rejects FFmpeg builds with --enable-nonfree/,
        );
      else {
        const qualified = await qualifyFFmpeg(binary);
        assert.equal(qualified.encoder, encoder);
        assert.equal(
          qualified.licenseProfile,
          flag === "gpl"
            ? "GPL_LOCAL_COMPETITION_ONLY"
            : "LGPL_LOCAL_EXECUTABLE",
        );
        assert.match(qualified.distribution, /redistribution are not approved/);
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
