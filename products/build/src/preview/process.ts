import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
const children = new Set<ChildProcess>();
export function stopAllChildren() {
  for (const child of children) stopChild(child);
}
export function boundedLog(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, "").slice(-24000);
}
const stopping = new WeakMap<ChildProcess, Promise<void>>();
export function stopChild(child: ChildProcess): Promise<void> {
  const pending = stopping.get(child);
  if (pending) return pending;
  const task = (async () => {
    if (!child.pid) return;
    const alive = () => {
      if (process.platform === "win32")
        return child.exitCode === null && child.signalCode === null;
      try {
        process.kill(-child.pid!, 0);
        return true;
      } catch {
        return false;
      }
    };
    const signal = (value: NodeJS.Signals) => {
      try {
        if (process.platform === "win32") child.kill(value);
        else process.kill(-child.pid!, value);
      } catch {
        /* The owned process group has already exited. */
      }
    };
    // A group can outlive its parent; exitCode alone is not a cleanup check.
    if (!alive()) return;
    signal("SIGTERM");
    const deadline = performance.now() + 1500;
    while (alive() && performance.now() < deadline) await delay(25);
    if (alive()) {
      signal("SIGKILL");
      const hardDeadline = performance.now() + 500;
      while (alive() && performance.now() < hardDeadline) await delay(25);
    }
  })();
  stopping.set(child, task);
  return task;
}
export function launch(command: string, args: string[], cwd: string) {
  // Only baseline runtime variables. Do not inherit the workbench's provider keys.
  const env = Object.fromEntries(
    ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "SystemRoot"].flatMap(
      (k) => (process.env[k] ? [[k, process.env[k]!]] : []),
    ),
  );
  const child = spawn(command, args, {
    cwd,
    env: { ...env, NO_COLOR: "1", BROWSER: "none", CI: "1" },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  child.once("close", () => children.delete(child));
  return child;
}
export function run(
  command: string,
  args: string[],
  cwd: string,
  timeout = 120000,
): Promise<{ status: "passed" | "failed"; log: string }> {
  return new Promise((resolve) => {
    const child = launch(command, args, cwd);
    let log = "";
    let finished = false;
    const finish = async (status: "passed" | "failed", extra = "") => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      await stopChild(child);
      resolve({ status, log: boundedLog(log + extra) });
    };
    child.stdout?.on("data", (d) => {
      log = boundedLog(log + d);
    });
    child.stderr?.on("data", (d) => {
      log = boundedLog(log + d);
    });
    const timer = setTimeout(() => {
      void finish("failed", "\nCommand timed out; process stopped.");
    }, timeout);
    child.on("error", (e) => finish("failed", "\n" + e.message));
    child.on("close", (code, signal) =>
      finish(code === 0 ? "passed" : "failed", `\nExit: ${code ?? signal}`),
    );
  });
}
export async function waitUntilReady(
  url: string,
  alive: () => boolean,
  ready: () => boolean = () => true,
) {
  const end = performance.now() + 20000;
  while (performance.now() < end && alive()) {
    if (!ready()) {
      await delay(150);
      continue;
    }
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(800) });
      await r.body?.cancel();
      if (r.ok && alive()) return;
    } catch {
      /* Startup pending. */
    }
    await delay(150);
  }
  throw new Error(
    "Preview did not become ready. Check the output, dependencies and Vite configuration.",
  );
}
