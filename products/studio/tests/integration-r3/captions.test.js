import { DISPLAY_NAMES } from "../../../../launcher/src/display-names.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeCaptions, writeShare } from "../../src/export/share.js";
import { parseSrt, parseVtt } from "../../src/transcript/srt.js";

test("render bundle preserves literal saved captions in both trim-relative formats", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "studio-integrated-captions-"));
  try {
    const text = "Reviewed <literal> & --> caption";
    await writeCaptions(dir, {
      trim: { startMs: 500, endMs: 2500 },
      captions: [
        { startMs: 0, endMs: 1000, text },
        { startMs: 2000, endMs: 3000, text: "Last saved words" },
        { startMs: 3500, endMs: 4000, text: "Excluded" },
      ],
    });
    const expected = [
      { startMs: 0, endMs: 500, text },
      { startMs: 1500, endMs: 2000, text: "Last saved words" },
    ];
    assert.deepEqual(parseVtt(await readFile(path.join(dir, "captions.vtt"), "utf8")), expected);
    assert.deepEqual(parseSrt(await readFile(path.join(dir, "captions.srt"), "utf8")), expected);
    await writeShare(dir, "LaunchForge Studio", "Forge %LABEL_STUDIO% <literal>");
    for (const name of ["index.html", "portrait.html"]) {
      const page = await readFile(path.join(dir, name), "utf8");
      assert.ok(page.includes(`<div class="brand">${DISPLAY_NAMES.umbrella} ${DISPLAY_NAMES.studio} / product story</div>`));
      assert.ok(page.includes("<h1>LaunchForge Studio</h1><p>Forge %LABEL_STUDIO% &lt;literal&gt;</p>"));
      assert.match(page, /href="captions\.srt" download/);
      assert.match(page, /href="captions\.vtt" download/);
    }
    await writeCaptions(dir, { trim: { startMs: 0, endMs: 1000 }, captions: [] });
    assert.equal(await readFile(path.join(dir, "captions.vtt"), "utf8"), "WEBVTT\n\n");
    assert.equal(await readFile(path.join(dir, "captions.srt"), "utf8"), "");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
