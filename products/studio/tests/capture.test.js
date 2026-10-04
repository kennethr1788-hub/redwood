import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { captureFlow, validateFlow } from "../src/capture/index.js";
import {
  createCaptureProxy,
  isPublicIPv4,
  parseCaptureUrl,
  resolveTarget,
} from "../src/capture/network.js";

test("bounded declarative flow rejects code, oversized waits and unknown fields", () => {
  assert.deepEqual(
    validateFlow([
      { type: "wait", ms: 10 },
      { type: "click", selector: "#button" },
    ]),
    [
      { type: "wait", ms: 10 },
      { type: "click", selector: "#button" },
    ],
  );
  for (const steps of [
    [{ type: "eval", script: "alert(1)" }],
    [{ type: "wait", ms: 10001 }],
    [{ type: "click", selector: "#x", code: "x" }],
    Array(13).fill({ type: "wait", ms: 0 }),
    [{ type: "scroll", deltaY: Infinity }],
  ]) {
    assert.throws(() => validateFlow(steps));
  }
});

test("URL boundary rejects credentials, protocols, metadata and reserved IP forms", () => {
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pass@example.com",
    "http://169.254.169.254/",
    "http://0xa9fea9fe/",
    "http://10.0.0.1",
    "http://[::1]/",
    "http://example.com:9000",
  ])
    assert.throws(() => parseCaptureUrl(url));
  assert.equal(parseCaptureUrl("http://127.0.0.1:4319/demo").port, "4319");
  assert.equal(parseCaptureUrl("https://example.com").protocol, "https:");
  for (const address of [
    "0.0.0.0",
    "100.64.0.1",
    "172.16.0.1",
    "192.168.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "::ffff:127.0.0.1",
  ])
    assert.equal(isPublicIPv4(address), false);
  assert.equal(isPublicIPv4("93.184.216.34"), true);
});

test("DNS result is pinned and mixed public/private resolutions fail closed", async () => {
  const selected = new URL("https://public.example");
  assert.deepEqual(
    await resolveTarget(selected, selected, async () => [
      { address: "93.184.216.34" },
    ]),
    { address: "93.184.216.34", port: 443 },
  );
  await assert.rejects(
    resolveTarget(selected, selected, async () => [
      { address: "93.184.216.34" },
      { address: "127.0.0.1" },
    ]),
    /blocked/,
  );
  const local = new URL("http://localhost:4519");
  assert.equal(
    (await resolveTarget(local, local, async () => [{ address: "127.0.0.1" }]))
      .port,
    4519,
  );
  await assert.rejects(
    resolveTarget(new URL("http://localhost:4520"), local, async () => [
      { address: "127.0.0.1" },
    ]),
    /selected loopback/,
  );
});

test("real proxy permits selected loopback fixture and blocks different loopback origin", async () => {
  const fixture = http.createServer((_req, res) => res.end("synthetic demo"));
  await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const selected = new URL(`http://127.0.0.1:${fixture.address().port}`);
  const proxy = await createCaptureProxy(selected);
  const get = (url) =>
    new Promise((resolve, reject) => {
      const request = http.get(proxy.server, { path: url.href }, (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode, body }),
        );
      });
      request.on("error", reject);
    });
  try {
    assert.deepEqual(await get(selected), {
      status: 200,
      body: "synthetic demo",
    });
    assert.equal((await get(new URL("http://127.0.0.1:1"))).status, 403);
    assert.equal((await get(new URL("http://169.254.169.254"))).status, 403);
  } finally {
    await proxy.close();
    await new Promise((resolve) => fixture.close(resolve));
  }
});

test(
  "synthetic Chromium capture produces original video and timed real interactions",
  { skip: process.env.STUDIO_CAPTURE_TEST !== "1" },
  async () => {
    const html = await readFile(
      new URL("./capture-fixture.html", import.meta.url),
    );
    const fixture = http.createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(html);
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const outputDir = await mkdtemp(
      path.join(os.tmpdir(), "studio-capture-test-"),
    );
    try {
      const result = await captureFlow({
        url: `http://127.0.0.1:${fixture.address().port}`,
        steps: [
          { type: "click", selector: "#launch" },
          { type: "scroll", deltaY: 350 },
          { type: "wait", ms: 500 },
        ],
        outputDir,
      });
      assert.ok((await stat(result.mediaPath)).size > 1000);
      assert.ok(
        (await stat(path.join(outputDir, "ready-frame.png"))).size > 1000,
      );
      assert.equal(result.flow.steps.length, 3);
      assert.ok(result.flow.url.startsWith("http://127.0.0.1:"));
      assert.ok(result.timing.pageCreationMs >= 0);
      assert.ok(result.timing.contentStartMs >= 700);
      assert.ok(result.events.some((event) => event.type === "click"));
      assert.ok(result.events.some((event) => event.type === "scroll"));
      assert.ok(
        result.events.every(
          (event, index, all) =>
            index === 0 || event.timeMs >= all[index - 1].timeMs,
        ),
      );
      assert.ok(
        (
          await readFile(path.join(outputDir, "events.ndjson"), "utf8")
        ).includes("viewport"),
      );
    } finally {
      await new Promise((resolve) => fixture.close(resolve));
      await rm(outputDir, { recursive: true, force: true });
    }
  },
);
