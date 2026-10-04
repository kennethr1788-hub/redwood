import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  readFile,
  mkdir,
  mkdtemp,
  rm,
  access,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { captureFlow, validateFlow } from "../../src/capture/index.js";
import { CAPTURE_LIMITS } from "../../src/capture/flow.js";
import { Event } from "../../src/core/schema.js";
import { Store } from "../../src/core/store.js";
import { binary, probe } from "../../src/core/media.js";

const retained = process.env.STUDIO_CAPTURE_R2_EVIDENCE;
async function fixture(t, name) {
  const observed = [];
  const html = await readFile(new URL("./fixture.html", import.meta.url));
  const server = http.createServer(async (req, res) => {
    if (req.url === "/observed") {
      let body = "";
      for await (const chunk of req) body += chunk;
      observed.push(JSON.parse(body));
      res.end("ok");
      return;
    }
    if (req.url === "/missing") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = retained
    ? path.resolve(retained, name)
    : await mkdtemp(path.join(os.tmpdir(), "studio-r2-"));
  await mkdir(root, { recursive: true });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (!retained) await rm(root, { recursive: true, force: true });
  });
  return { url: `http://127.0.0.1:${server.address().port}`, root, observed };
}

test("reviewed format preserves exact actions and rejects expansion, code and wait abuse", () => {
  const flow = [
    {
      type: "click",
      selector: "#launch",
      label: "Prepare campaign",
      pauseAfterMs: 800,
    },
    { type: "navigate", url: "/next" },
    { type: "assert-visible", selector: "#next-action" },
  ];
  assert.deepEqual(validateFlow(flow, "http://127.0.0.1:4319"), flow);
  for (const bad of [
    [{ type: "navigate", url: "https://elsewhere.example" }],
    [{ type: "navigate", url: "javascript:alert(1)" }],
    [{ type: "click", selector: "#x", fallbackSelector: "button" }],
    [{ type: "wait", ms: 0, pauseAfterMs: Infinity }],
    [{ type: "wait", ms: 0, label: "" }],
    Array(13).fill({ type: "wait", ms: 0 }),
    Array(4).fill({ type: "wait", ms: 10000 }),
    Array(4).fill({ type: "click", selector: "#x", pauseAfterMs: 10000 }),
  ])
    assert.throws(() => validateFlow(bad, "http://127.0.0.1:4319"));
});

test(
  "real actions, moved click target, routes, scroll, video clock and timeline survive import/reopen",
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, "happy");
    const steps = [
      {
        type: "fill",
        selector: "#campaign",
        text: "October demo",
        label: "Name campaign",
      },
      {
        type: "click",
        selector: "#launch",
        label: "Prepare campaign",
        pauseAfterMs: 700,
      },
      { type: "assert-visible", selector: "#done", label: "Review success" },
      { type: "scroll", deltaY: 550, label: "Show details", pauseAfterMs: 550 },
      { type: "navigate", url: "/next", label: "Open next screen" },
      { type: "click", selector: "#next-action", label: "Confirm next screen" },
      { type: "navigate", url: "/next#details", label: "Same-document route" },
    ];
    const result = await captureFlow({
      url: f.url,
      steps,
      outputDir: path.join(f.root, "capture"),
    });
    assert.deepEqual(result.flow.steps, steps);
    assert.deepEqual(
      result.timing.actions.map((a) => a.status),
      steps.map(() => "completed"),
    );
    for (const e of result.events) Event.parse(e);
    assert.ok(
      result.events.every((e, i, a) => i === 0 || e.timeMs >= a[i - 1].timeMs),
    );
    const clicks = result.events.filter((e) => e.type === "click");
    const actual = f.observed.filter((e) => e.trusted);
    assert.equal(actual.length, 2);
    assert.equal(clicks.length, 2);
    assert.deepEqual(
      clicks.map(({ x, y }) => ({ x, y })),
      actual.map(({ x, y }) => ({ x, y })),
    );
    assert.ok(
      clicks[0].x > 760,
      "click follows hover-moved target, not stale coordinates",
    );
    const launch = result.timing.actions[1];
    assert.equal(launch.inputTimeMs, clicks[0].timeMs);
    assert.ok(
      launch.inputTimeMs >=
        launch.startedMs - result.timing.inputClockUncertaintyMs,
    );
    assert.ok(
      launch.inputTimeMs <=
        launch.dispatchedMs + result.timing.inputClockUncertaintyMs,
    );
    assert.equal(
      result.timing.observations.find((o) => o.type === "click").target.id,
      "launch",
    );
    assert.equal(result.timing.actions[0].after.focus.id, "campaign");
    assert.ok(launch.after.url.endsWith("/prepared"));
    assert.ok(result.timing.routes.some((r) => r.url.endsWith("/prepared")));
    assert.ok(result.timing.routes.some((r) => r.url.endsWith("/next")));
    assert.ok(
      result.timing.actions[3].after.scroll.y >
        result.timing.actions[3].before.scroll.y,
    );
    assert.equal(result.timing.actions[3].after.viewport.width, 1280);
    const media = await probe(result.mediaPath);
    assert.equal(media.width, 1280);
    assert.equal(media.height, 800);
    assert.ok(clicks.every((e) => e.timeMs < media.durationMs));
    // Independent pixel oracle: the fixture turns a red marker green only on click.
    const pixels = execFileSync(
      binary("ffmpeg"),
      [
        "-v",
        "error",
        "-i",
        result.mediaPath,
        "-vf",
        "fps=25,crop=20:20:10:10,scale=1:1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
      ],
      { timeout: 10000, maxBuffer: 100000 },
    );
    let firstGreen = -1;
    for (let i = 0; i < pixels.length; i += 3)
      if (pixels[i + 1] > 150 && pixels[i] < 70) {
        firstGreen = (i / 3) * 40;
        break;
      }
    assert.ok(
      firstGreen >= 0,
      "captured media contains actual successful click state",
    );
    const alignmentErrorMs = firstGreen - clicks[0].timeMs;
    assert.ok(
      Math.abs(alignmentErrorMs) <= result.timing.pageCreationMs + 250,
      `video/input offset ${alignmentErrorMs}ms exceeds measured page bracket + 250ms presentation tolerance`,
    );
    execFileSync(
      binary("ffmpeg"),
      [
        "-v",
        "error",
        "-y",
        "-ss",
        String((firstGreen + 160) / 1000),
        "-i",
        result.mediaPath,
        "-frames:v",
        "1",
        path.join(f.root, "observed-click.png"),
      ],
      { timeout: 10000 },
    );
    const store = new Store(path.join(f.root, "projects"));
    const project = await store.importMedia(result.mediaPath, {
      name: "Reviewed Orbit capture",
      input: { kind: "url", url: f.url },
      events: result.events,
      flow: result.flow,
      timing: result.timing,
      readyFramePath: result.readyFramePath,
    });
    const reopened = await new Store(path.join(f.root, "projects")).get(
      project.studio.id,
    );
    assert.deepEqual(reopened.events, result.events);
    assert.equal(reopened.timeline.trim.startMs, result.timing.contentStartMs);
    assert.equal(reopened.timeline.focus.x, clicks[0].x / 1280);
    assert.equal(reopened.timeline.focus.y, clicks[0].y / 800);
    const persisted = JSON.parse(
      await readFile(
        path.join(f.root, "projects", project.studio.id, "capture-timing.json"),
        "utf8",
      ),
    );
    assert.deepEqual(persisted.actions, result.timing.actions);
    await writeFile(
      path.join(f.root, "evidence.json"),
      JSON.stringify(
        {
          media,
          firstGreen,
          clickTimeMs: clicks[0].timeMs,
          alignmentErrorMs,
          timing: result.timing,
          projectId: project.studio.id,
        },
        null,
        2,
      ),
    );
  },
);

test(
  "unreachable reviewed action stops honestly without executing the following action",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, "failure");
    let failure;
    const started = performance.now();
    try {
      await captureFlow({
        url: f.url,
        steps: [
          { type: "click", selector: "#launch", label: "Prepare" },
          { type: "click", selector: "#absent", label: "Missing control" },
          { type: "click", selector: "#next" },
        ],
        outputDir: f.root,
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(
      performance.now() - started < 12000,
      "missing target failure remains bounded",
    );
    assert.match(failure?.message, /step 2 \(Missing control\)/);
    assert.deepEqual(
      failure.report.actions.map((a) => a.status),
      ["completed", "failed"],
    );
    assert.deepEqual(
      f.observed.filter((e) => e.trusted).map((e) => e.id),
      ["launch"],
    );
    assert.equal(
      failure.report.observations.filter((e) => e.type === "click").length,
      1,
    );
    await assert.rejects(access(path.join(f.root, "original.webm")));
    const report = JSON.parse(
      await readFile(path.join(f.root, "capture-failure.json"), "utf8"),
    );
    assert.equal(report.status, "failed");
    assert.equal(CAPTURE_LIMITS.captureMs, 60000);
  },
);

test(
  "reviewed navigation HTTP failure is not a completed action",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, "navigation-failure");
    await assert.rejects(
      captureFlow({
        url: f.url,
        steps: [
          { type: "navigate", url: "/missing", label: "Unavailable route" },
        ],
        outputDir: f.root,
      }),
      (error) => {
        assert.match(error.message, /step 1.*HTTP 404/);
        assert.equal(error.report.actions[0].status, "failed");
        return true;
      },
    );
  },
);
