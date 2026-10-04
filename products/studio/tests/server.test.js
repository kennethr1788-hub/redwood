import { DISPLAY_NAMES } from "../../../launcher/src/display-names.js";
import test from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../src/server.js";
test("loopback API rejects foreign origins, hosts and unauthenticated writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-http-"));
  const app = await startServer({ port: 0, root });
  try {
    const shell = await (await fetch(app.url + "/")).text();
    assert.ok(shell.includes(`<title>${DISPLAY_NAMES.umbrella} ${DISPLAY_NAMES.studio}</title>`));
    assert.ok(shell.includes(`aria-label="${DISPLAY_NAMES.umbrella} ${DISPLAY_NAMES.studio} home"`));
    assert.ok(!shell.includes("%LABEL_"));
    const labels = await fetch(app.url + "/display-names.js");
    assert.match(labels.headers.get("content-type"), /text\/javascript/);
    assert.equal(labels.status, 200);
    assert.ok((await labels.text()).includes("export const DISPLAY_NAMES"));
    assert.equal(
      (
        await fetch(app.url + "/api/config", {
          headers: { Origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      await new Promise((resolve, reject) => {
        const r = http.get(
          app.url + "/api/config",
          { headers: { Host: "evil.example" } },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        r.on("error", reject);
      }),
      403,
    );
    assert.equal(
      (await fetch(app.url + "/api/import", { method: "POST", body: "bad" }))
        .status,
      403,
    );
    const { csrfToken } = await (await fetch(app.url + "/api/config")).json();
    assert.match(csrfToken, /^[a-f0-9]{64}$/);
    const response = await fetch(app.url + "/api/import", {
      method: "POST",
      headers: { "X-Studio-Token": csrfToken, "X-Filename": "file.js" },
      body: "bad",
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Choose an MP4/);
    assert.deepEqual(await app.store.list(), []);
  } finally {
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  }
});

test("capture and ASR reserve the media slot before awaiting request bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-busy-"));
  const app = await startServer({ port: 0, root });
  try {
    const { csrfToken } = await (await fetch(app.url + "/api/config")).json();
    const headers = { "X-Studio-Token": csrfToken };
    for (const route of ["/api/capture", "/api/projects/invalid/transcribe"]) {
      // Pause an admitted request halfway through its JSON body. A second job
      // must be rejected even though the first has not begun media processing.
      let first;
      const finished = new Promise((resolve, reject) => {
        first = http.request(
          app.url + route,
          { method: "POST", headers },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode));
          },
        );
        first.on("error", reject);
      });
      const admitted = new Promise((resolve) =>
        app.server.once("request", resolve),
      );
      first.write("{");
      await admitted;
      try {
        const second = await fetch(app.url + "/api/projects/invalid/render", {
          method: "POST",
          headers,
        });
        assert.equal(second.status, 409);
      } finally {
        first.end("}");
      }
      assert.equal(await finished, 400);
      // Validation failure must release the slot for another request.
      const released = await fetch(app.url + "/api/capture", {
        method: "POST",
        headers,
        body: "{}",
      });
      assert.equal(released.status, 400);
      assert.match((await released.json()).error, /Project name/);
    }
  } finally {
    await new Promise((r) => app.server.close(r));
    await rm(root, { recursive: true, force: true });
  }
});
