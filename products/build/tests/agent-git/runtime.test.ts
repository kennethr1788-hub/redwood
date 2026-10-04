import { expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { Detail } from "../../src/core/types";

test("real backend and Vite: create, official handoff, install, preview source edits, checks, stop/start and reopen", async () => {
  await fs.mkdir(".local", { recursive: true });
  const workspace = await fs.mkdtemp(
    path.resolve(".local/real runtime ' space-"),
  );
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const value = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(value));
    });
  });
  let server: ChildProcess | undefined;
  let serverLog = "";
  let previewUrl: string | undefined;
  const origin = `http://127.0.0.1:${port}`;
  async function call(url: string, body?: unknown) {
    const response = await fetch(origin + "/api" + url, {
      method: body ? "POST" : "GET",
      headers: { "X-LaunchForge": "1", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await response.json();
    expect(response.ok, JSON.stringify(json)).toBe(true);
    return json;
  }
  async function start() {
    server = spawn(
      process.execPath,
      ["--import", "tsx", "src/backend/server.ts"],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LF_PORT: String(port),
          LF_WORKSPACE: workspace,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    server.stdout?.on("data", (d) => {
      serverLog += d;
    });
    server.stderr?.on("data", (d) => {
      serverLog += d;
    });
    for (let n = 0; n < 100; n++) {
      try {
        const r = await fetch(origin);
        await r.body?.cancel();
        return;
      } catch {
        await delay(50);
      }
    }
    throw new Error("Backend did not start: " + serverLog);
  }
  async function stop() {
    if (!server || server.exitCode !== null || server.signalCode !== null)
      return;
    const child = server;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  }
  try {
    await start();
    await call("/projects", {
      name: "Real App",
      brief: "Test the real owned source preview workflow.",
      tool: "claude",
    });
    const base = "/projects/real-app";
    const detail: Detail = await call(base);
    expect(detail.handoff.command).toContain("&& claude");
    expect(detail.handoff.command).toContain("'\\''");
    expect(detail.git.branch).toBe("main");
    // Leave A failed before starting B: stopping A must not stop B's preview.
    await call("/projects", {
      name: "Failed App",
      brief: "A project without installed preview dependencies.",
      tool: "codex",
    });
    await call("/projects/failed-app/action", { action: "trust" });
    const failed = await fetch(origin + "/api/projects/failed-app/action", {
      method: "POST",
      headers: { "X-LaunchForge": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "preview" }),
    });
    expect(failed.status).toBe(400);
    expect((await failed.json()).error).toContain("dependencies");
    expect((await call("/projects/failed-app")).runtime.status).toBe("failed");
    await call(base + "/action", { action: "trust" });
    expect((await call(base + "/action", { action: "install" })).ok).toBe(true);
    await call(base + "/action", { action: "preview" });
    previewUrl = (await call(base)).runtime.url;
    expect(previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect((await fetch(previewUrl!)).status).toBe(200);
    await call("/projects/failed-app/action", { action: "stop" });
    expect((await call(base)).runtime.status).toBe("running");
    expect((await fetch(previewUrl!)).status).toBe(200);
    const file = path.join(workspace, "real-app/src/project.json");
    const data = JSON.parse(await fs.readFile(file, "utf8"));
    data.brief = "Edited through an ordinary source file";
    await fs.writeFile(file, JSON.stringify(data));
    expect(
      await (await fetch(previewUrl + "/src/project.json")).text(),
    ).toContain(data.brief);
    expect((await call(base + "/action", { action: "verify" })).ok).toBe(true);
    await call(base + "/action", { action: "stop" });
    await expect(
      fetch(previewUrl!, { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
    await call(base + "/action", { action: "preview" });
    expect((await call(base)).runtime.url).toBe(previewUrl);
    await stop();
    await expect(
      fetch(previewUrl!, { signal: AbortSignal.timeout(500) }),
    ).rejects.toThrow();
    await start();
    const reopened: Detail = await call(base);
    expect(reopened.trusted).toBe(false);
    expect(reopened.runtime.status).toBe("stopped");
    expect(reopened.project.checks?.build?.status).toBe("passed");
    expect(JSON.parse(await fs.readFile(file, "utf8")).brief).toBe(data.brief);
    await call(base + "/action", { action: "trust" });
    await call(base + "/action", { action: "preview" });
    expect((await call(base)).runtime.url).toBe(previewUrl);
  } finally {
    await stop();
    await fs.rm(workspace, { recursive: true, force: true });
  }
}, 120000);
