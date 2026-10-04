import assert from "node:assert/strict";
import http from "node:http";
import { readFile, mkdir, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium } from "playwright";
import { startServer } from "../src/server.js";
import { binary, run, probe } from "../src/core/media.js";
import { sha256 } from "../src/core/store.js";
import { qualifyFFmpeg } from "../src/render/native.js";
const out = fileURLToPath(
  new URL("../.test-output/acceptance/", import.meta.url),
);
await mkdir(out, { recursive: true });
const html = await readFile(
  new URL("../tests/capture-fixture.html", import.meta.url),
);
const fixture = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(html);
});
await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
let app = await startServer({ port: 0, root: join(out, "projects") });
let browser;
const errors = [];
const results = {};
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.url);
  await page.locator("#new-project").click();
  await page.locator("#new-name").fill("Orbit — a better launch");
  await page.locator("#capture-tab").click();
  await page
    .locator("#capture-url")
    .fill(`http://127.0.0.1:${fixture.address().port}`);
  await page.locator("#capture-steps").fill(
    JSON.stringify(
      [
        { type: "wait", ms: 900 },
        { type: "click", selector: "#launch" },
        { type: "wait", ms: 1300 },
        { type: "scroll", deltaY: 350 },
        { type: "wait", ms: 1800 },
      ],
      null,
      2,
    ),
  );
  await page.locator("#flow-reviewed").check();
  await page.locator("#create-project").click();
  await page.locator("#editor").waitFor({ state: "visible", timeout: 60000 });
  results.projectId = await page.evaluate(() =>
    localStorage.getItem("launchforge.lastProject"),
  );
  const id = results.projectId;
  let p = await (await fetch(`${app.url}/api/projects/${id}`)).json();
  assert.ok(p.events.some((e) => e.type === "click"));
  assert.ok(p.events.some((e) => e.type === "scroll"));
  await page.locator("#title").fill("From idea to launch.");
  await page.locator("#subtitle").fill("One clear story. Every format.");
  await page.locator("#zoom").fill("1.25");
  await page.locator("#zoom").dispatchEvent("input");
  await page.locator("summary").filter({ hasText: "Captions" }).click();
  await page.locator("#add-caption").click();
  await page
    .locator("[data-text]")
    .fill("Prepare your next campaign in one click.");
  await page
    .locator("[data-start]")
    .fill(String((p.timeline.trim.startMs + 500) / 1000));
  await page
    .locator("[data-end]")
    .fill(String((p.timeline.trim.endMs - 500) / 1000));
  await page.locator("#save").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#saved-state").textContent === "Saved locally",
  );
  await page.screenshot({ path: join(out, "editor.png"), fullPage: true });
  p = await (await fetch(`${app.url}/api/projects/${id}`)).json();
  results.sourceHash = await sha256(
    join(app.store.dir(id), p.studio.asset.path),
  );
  const renderResponse = page.waitForResponse(
    (r) => r.url().endsWith("/render") && r.request().method() === "POST",
  );
  await page.locator("#render").click();
  const { jobId } = await (await renderResponse).json();
  assert.ok(jobId);
  let job;
  const deadline = Date.now() + 180000;
  do {
    await new Promise((r) => setTimeout(r, 500));
    job = await (await fetch(`${app.url}/api/jobs/${jobId}`)).json();
    if (job.status === "error") throw Error(job.error);
    if (Date.now() > deadline) throw Error("Render acceptance timed out");
  } while (job.status !== "done");
  await page
    .locator("#exports-view")
    .waitFor({ state: "visible", timeout: 10000 });
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#export-list video")].every(
      (v) => v.readyState >= 2,
    ),
  );
  await page.screenshot({ path: join(out, "exports-ui.png"), fullPage: true });
  results.outputs = [];
  for (const name of ["landscape.mp4", "vertical.mp4"]) {
    const media = join(app.store.dir(id), "exports", name);
    const meta = await probe(media);
    assert.equal(meta.width, name.startsWith("landscape") ? 1280 : 720);
    assert.equal(meta.height, name.startsWith("landscape") ? 720 : 1280);
    await page.goto(`${app.url}/exports/${id}/${name}`);
    await page.waitForFunction(
      () => document.querySelector("video")?.readyState >= 2,
    );
    await page.evaluate(async () => {
      const v = document.querySelector("video");
      v.muted = true;
      await v.play();
    });
    await page.waitForFunction(
      () => document.querySelector("video").ended,
      {},
      { timeout: 20000 },
    );
    assert.equal(
      await page.evaluate(() => document.querySelector("video").error),
      null,
    );
    for (const [suffix, seconds] of [
      ["early", 0.5],
      ["middle", meta.durationMs / 2000],
      ["late", meta.durationMs / 1000 - 0.3],
    ])
      await run(binary("ffmpeg"), [
        "-v",
        "error",
        "-y",
        "-ss",
        String(seconds),
        "-i",
        media,
        "-frames:v",
        "1",
        "-update",
        "1",
        join(out, name + "-" + suffix + ".png"),
      ]);
    results.outputs.push({
      name,
      ...meta,
      sha256: await sha256(media),
      playback: "loaded, played to ended; media.error=null",
    });
  }
  await page.goto(`${app.url}/exports/${id}/thumbnail.png`);
  assert.ok(
    await page
      .locator("img")
      .evaluate((i) => i.complete && i.naturalWidth === 1280),
  );
  await page.screenshot({ path: join(out, "thumbnail-open.png") });
  await page.goto(`${app.url}/exports/${id}/demo.gif`);
  assert.ok(
    await page
      .locator("img")
      .evaluate((i) => i.complete && i.naturalWidth === 480),
  );
  await page.goto(`${app.url}/exports/${id}/index.html`);
  assert.equal(await page.locator("video").count(), 1);
  await page.goto(app.url);
  await page.locator("#editor").waitFor({ state: "visible" });
  assert.equal(
    await page.locator("#title").inputValue(),
    "From idea to launch.",
  );
  // Important failure: invalid import through the user-visible dialog.
  await page.locator("#new-project").click();
  await page.locator("#new-name").fill("Invalid recording");
  await page
    .locator("#media-file")
    .setInputFiles({
      name: "broken.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("not a video"),
    });
  await page.locator("#create-project").click();
  await page.locator("#create-error").waitFor({ state: "visible" });
  assert.match(
    await page.locator("#create-error").innerText(),
    /Invalid or unreadable media/,
  );
  await page.screenshot({ path: join(out, "invalid-media.png") });
  await page.locator("#close-dialog").click();
  // Independent imported audio/video fixture verifies the second input route.
  const imported = join(out, "import-source.mp4");
  const qualified = await qualifyFFmpeg();
  results.importFixtureEncoder = qualified.encoder;
  await run(qualified.binary, [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000",
    "-t",
    "3",
    "-c:v",
    qualified.encoder,
    ...(qualified.encoder === "h264_videotoolbox" ? ["-allow_sw", "1"] : []),
    "-b:v",
    "2M",
    "-c:a",
    "aac",
    imported,
  ]);
  await page.locator("#new-project").click();
  await page.locator("#new-name").fill("Imported audio sample");
  await page.locator("#media-file").setInputFiles(imported);
  await page.locator("#create-project").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#project-name").textContent ===
      "Imported audio sample",
  );
  const importId = await page.evaluate(() =>
    localStorage.getItem("launchforge.lastProject"),
  );
  const importedProject = await app.store.get(importId);
  assert.equal(importedProject.studio.asset.hasAudio, true);
  assert.equal(importedProject.events.length, 0);
  const config = await (await fetch(app.url + "/api/config")).json();
  const importedJob = await (
    await fetch(`${app.url}/api/projects/${importId}/render`, {
      method: "POST",
      headers: { "X-Studio-Token": config.csrfToken },
    })
  ).json();
  let ij;
  do {
    await new Promise((r) => setTimeout(r, 500));
    ij = await (await fetch(`${app.url}/api/jobs/${importedJob.jobId}`)).json();
    if (ij.status === "error") throw Error(ij.error);
  } while (ij.status !== "done");
  const audioExport = join(app.store.dir(importId), "exports", "landscape.mp4");
  const audioMeta = await probe(audioExport);
  assert.equal(audioMeta.hasAudio, true);
  assert.ok(Math.abs(audioMeta.durationMs - 3000) < 100);
  results.importRenderedWithAudio = audioMeta;
  results.importId = importId;
  results.invalidMedia = "clear UI error, original project remains intact";
  // Restart the actual service, not only a JavaScript object.
  await browser.close();
  browser = null;
  await new Promise((r) => app.server.close(r));
  app = await startServer({ port: 0, root: join(out, "projects") });
  const reopened = await app.store.verify(id);
  assert.equal(reopened.timeline.title, "From idea to launch.");
  assert.equal(
    await sha256(join(app.store.dir(id), reopened.studio.asset.path)),
    results.sourceHash,
  );
  results.reopen =
    "server stopped/restarted; timeline and original hash preserved";
  assert.deepEqual(errors, []);
  results.consoleErrors = errors;
  results.projectDir = app.store.dir(id);
  results.passed = true;
  await writeFile(
    join(out, "acceptance.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
  console.log(JSON.stringify(results, null, 2));
} catch (e) {
  await writeFile(join(out, "failure.txt"), e.stack);
  throw e;
} finally {
  await browser?.close();
  await new Promise((r) => app.server.close(r));
  await new Promise((r) => fixture.close(r));
}
