import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { chromium } from "playwright";
import { startServer } from "../src/server.js";
const fixture = process.env.STUDIO_ASR_FIXTURE;
if (!fixture)
  throw Error("Set STUDIO_ASR_FIXTURE to a short synthetic speech video.");
const out = fileURLToPath(
  new URL("../.test-output/asr-acceptance/", import.meta.url),
);
await mkdir(out, { recursive: true });
const app = await startServer({ port: 0, root: join(out, "projects") });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(app.url);
  await page.locator("#new-project").click();
  await page.locator("#new-name").fill("Local speech · offline captions");
  await page.locator("#media-file").setInputFiles(fixture);
  await page.locator("#create-project").click();
  await page.locator("#editor").waitFor({ state: "visible" });
  await page.locator("summary").filter({ hasText: "Captions" }).click();
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/transcribe") && r.request().method() === "POST",
  );
  await page.locator("#transcribe").click();
  const r = await response;
  const p = await r.json();
  assert.equal(r.status(), 200, JSON.stringify(p));
  assert.ok(p.timeline.captions.length > 0);
  assert.match(
    p.timeline.captions.map((c) => c.text).join(" "),
    /blue bicycle/i,
  );
  await page.waitForFunction(
    () => document.querySelectorAll("[data-text]").length > 0,
  );
  await page.screenshot({ path: join(out, "captions-ui.png"), fullPage: true });
  const transcript = JSON.parse(
    await readFile(join(app.store.dir(p.studio.id), "transcript.json")),
  );
  assert.equal(transcript.provenance.versions["faster-whisper"], "1.2.1");
  assert.equal(transcript.provenance.settings.computeType, "int8");
  assert.equal(transcript.provenance.networkSandbox, true);
  await page.reload();
  await page.locator("#editor").waitFor({ state: "visible" });
  assert.equal(
    (await app.store.get(p.studio.id)).timeline.captions.length,
    p.timeline.captions.length,
  );
  assert.deepEqual(errors, []);
  const evidence = {
    passed: true,
    projectId: p.studio.id,
    captions: p.timeline.captions,
    provenance: transcript.provenance,
    inferenceSeconds: transcript.inferenceSeconds,
    consoleErrors: errors,
  };
  await writeFile(
    join(out, "acceptance.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser?.close();
  await new Promise((r) => app.server.close(r));
}
