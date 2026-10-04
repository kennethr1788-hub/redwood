import { expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

test("a real server restart retains projects and clears session trust and live preview claims", async () => {
  await fs.mkdir(".local", { recursive: true });
  const workspace = await fs.mkdtemp(path.resolve(".local/restart-"));
  const port = await new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
  let server: ChildProcess | undefined;
  async function start() {
    server = spawn(
      process.execPath,
      ["--import", "tsx", "src/backend/server.ts"],
      {
        env: { ...process.env, LF_PORT: String(port), LF_WORKSPACE: workspace },
        stdio: "ignore",
      },
    );
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/projects`, {
          headers: { "X-LaunchForge": "1" },
        });
        if (r.ok) return;
      } catch {
        /* Starting. */
      }
      await delay(50);
    }
    throw new Error("Server startup timed out.");
  }
  async function stop() {
    if (!server || server.exitCode !== null) return;
    const child = server;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  }
  async function call(url: string, body?: unknown) {
    const r = await fetch(`http://127.0.0.1:${port}/api${url}`, {
      method: body ? "POST" : "GET",
      headers: { "X-LaunchForge": "1", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(r.ok).toBe(true);
    return r.json();
  }
  try {
    await start();
    await call("/projects", {
      name: "Restart Proof",
      brief: "The project survives a full server restart.",
      tool: "cursor",
    });
    await call("/projects/restart-proof/action", { action: "trust" });
    expect((await call("/projects/restart-proof")).trusted).toBe(true);
    await stop();
    await start();
    const reopened = await call("/projects/restart-proof");
    expect(reopened.project.brief).toBe(
      "The project survives a full server restart.",
    );
    expect(reopened.trusted).toBe(false);
    expect(reopened.runtime.status).toBe("stopped");
    expect(reopened.handoff.command).toContain("cursor");
  } finally {
    await stop();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
