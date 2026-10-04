import { afterEach, beforeEach, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Projects } from "../../src/core/projects";
import { Lifecycle } from "../../src/preview/lifecycle";
import { launch, run, stopChild } from "../../src/preview/process";
let root: string;
let store: Projects;
let lifecycle: Lifecycle;
const input = {
  name: "Preview",
  brief: "A preview with real process lifecycle tests.",
  reference: "",
  tool: "codex" as const,
};
const fixture = `
const http = require('node:http');
const fs = require('node:fs');
const mode = fs.existsSync('mode') ? fs.readFileSync('mode', 'utf8') : '';
fs.writeFileSync('preview.pid', String(process.pid));
if (mode === 'fail') { console.error('Intentional Vite configuration failure'); process.exit(23); }
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const server = http.createServer((_req, res) => {
  if (fs.existsSync('hang')) return;
  res.end('Owned preview source');
});
server.on('error', e => { console.error(e.message); process.exit(1); });
server.listen(port, '127.0.0.1', () => console.log('Local: http://127.0.0.1:' + port));
process.on('SIGTERM', () => setTimeout(() => server.close(() => process.exit(0)), 300));
`;
async function fakeVite() {
  const folder = await store.folder("preview");
  const dir = path.join(folder, "node_modules/vite/bin");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(folder, "node_modules/vite/package.json"),
    JSON.stringify({ type: "commonjs" }),
  );
  await fs.writeFile(path.join(dir, "vite.js"), fixture);
  return folder;
}
async function until(fn: () => Promise<boolean> | boolean) {
  for (let n = 0; n < 100; n++) {
    if (await fn()) return;
    await delay(40);
  }
  throw new Error("Expected process state was not reached");
}
beforeEach(async () => {
  await fs.mkdir(".local", { recursive: true });
  root = await fs.mkdtemp(path.resolve(".local/preview ' space-"));
  store = new Projects(root, path.resolve("templates/react"));
  await store.init();
  await store.create(input);
  lifecycle = new Lifecycle(store);
  lifecycle.trusted.add("preview");
});
afterEach(async () => {
  const url = lifecycle.state("preview").url;
  lifecycle.stop();
  if (url)
    await until(async () => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(200) });
        await r.body?.cancel();
        return false;
      } catch {
        return true;
      }
    });
  await fs.rm(root, { recursive: true, force: true });
});
test("missing preview dependencies persist an actionable failure and leave source intact", async () => {
  await expect(lifecycle.start("preview")).rejects.toThrow(
    "Install dependencies",
  );
  expect(lifecycle.state("preview")).toMatchObject({ status: "failed" });
  expect(lifecycle.state("preview").url).toBeUndefined();
  expect(lifecycle.state("preview").log).toContain("Install dependencies");
  expect(
    await fs.readFile(path.join(root, "preview/src/main.tsx"), "utf8"),
  ).toContain("react");
});
test("immediate stop/start waits for port release; dead preview reports and restarts at its saved URL", async () => {
  const folder = await fakeVite();
  await lifecycle.start("preview");
  const url = lifecycle.state("preview").url;
  const firstPid = Number(
    await fs.readFile(path.join(folder, "preview.pid"), "utf8"),
  );
  lifecycle.stop();
  await lifecycle.start("preview");
  expect(lifecycle.state("preview")).toMatchObject({ status: "running", url });
  const pid = Number(
    await fs.readFile(path.join(folder, "preview.pid"), "utf8"),
  );
  expect(pid).not.toBe(firstPid);
  process.kill(pid, "SIGKILL");
  await until(() => lifecycle.state("preview").status === "failed");
  expect(lifecycle.state("preview").url).toBeUndefined();
  expect(lifecycle.state("preview").log).toContain("SIGKILL");
  await lifecycle.start("preview");
  expect(lifecycle.state("preview")).toMatchObject({ status: "running", url });
  expect((await fetch(url!)).status).toBe(200);
});
test("startup failure is visible and corrected source can start without reopening the workbench", async () => {
  const folder = await fakeVite();
  await fs.writeFile(path.join(folder, "mode"), "fail");
  await expect(lifecycle.start("preview")).rejects.toThrow(
    "Intentional Vite configuration failure",
  );
  expect(lifecycle.state("preview").log).toContain("23");
  expect(lifecycle.state("preview").status).toBe("failed");
  await fs.unlink(path.join(folder, "mode"));
  await lifecycle.start("preview");
  expect(lifecycle.state("preview").status).toBe("running");
});
test("occupied saved port cannot be mistaken for this project's ready preview", async () => {
  await fakeVite();
  const other = net.createServer();
  await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
  const port = (other.address() as net.AddressInfo).port;
  await store.persist({ ...(await store.read("preview")), previewPort: port });
  try {
    await expect(lifecycle.start("preview")).rejects.toThrow(
      `Preview port ${port} is unavailable`,
    );
    expect(lifecycle.state("preview").status).toBe("failed");
    expect(lifecycle.state("preview").url).toBeUndefined();
  } finally {
    await new Promise<void>((resolve) => other.close(() => resolve()));
  }
  await lifecycle.start("preview");
  expect(lifecycle.state("preview").status).toBe("running");
});
test("a stale responding process is restarted, invalid IDs do not interrupt it, and reopen clears trust", async () => {
  const folder = await fakeVite();
  await lifecycle.start("preview");
  const pid = await fs.readFile(path.join(folder, "preview.pid"), "utf8");
  await fs.writeFile(path.join(folder, "hang"), "hang requests");
  // Clear the hung behavior once start has observed the failed health probe.
  const timer = setTimeout(
    () => void fs.unlink(path.join(folder, "hang")),
    950,
  );
  try {
    await lifecycle.start("preview");
  } finally {
    clearTimeout(timer);
  }
  expect(await fs.readFile(path.join(folder, "preview.pid"), "utf8")).not.toBe(
    pid,
  );
  lifecycle.trusted.add("../escape");
  await expect(lifecycle.start("../escape")).rejects.toThrow();
  expect(lifecycle.state("preview").status).toBe("running");
  const reopened = new Lifecycle(store);
  expect(reopened.state("preview").status).toBe("stopped");
  await expect(reopened.start("preview")).rejects.toThrow("Trust this project");
});
test("dependency symlinks outside project are refused before execution", async () => {
  const external = path.join(root, "external/vite/bin");
  await fs.mkdir(external, { recursive: true });
  await fs.writeFile(path.join(external, "vite.js"), fixture);
  await fs.symlink(
    path.join(root, "external"),
    path.join(root, "preview/node_modules"),
  );
  await expect(lifecycle.start("preview")).rejects.toThrow(
    "outside this project",
  );
  expect(lifecycle.state("preview").status).toBe("failed");
});
test("a failed actual npm check is persisted and source is preserved; missing scripts are explicit", async () => {
  const folder = await store.folder("preview");
  const pkgPath = path.join(folder, "package.json");
  const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
  pkg.scripts.typecheck = `node -e "console.error('Intentional check failure'); process.exit(7)"`;
  await fs.writeFile(pkgPath, JSON.stringify(pkg));
  expect((await lifecycle.check("preview", "verify")).ok).toBe(false);
  const check = (await store.read("preview")).checks?.typecheck;
  expect(check?.status).toBe("failed");
  expect(check?.log).toContain("Intentional check failure");
  expect(check?.log).toContain("Exit: 7");
  expect(JSON.parse(await fs.readFile(pkgPath, "utf8")).scripts.typecheck).toBe(
    pkg.scripts.typecheck,
  );
  delete pkg.scripts.typecheck;
  await fs.writeFile(pkgPath, JSON.stringify(pkg));
  expect((await lifecycle.check("preview", "verify")).ok).toBe(false);
  expect((await store.read("preview")).checks?.typecheck?.log).toContain(
    "Missing npm typecheck script",
  );
});
test("process runner reports spawn errors, bounds logs, times out and strips provider environment", async () => {
  expect((await run("/no-such-launchforge-command", [], root)).log).toContain(
    "ENOENT",
  );
  const key = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-not-a-secret";
  try {
    const r = await run(
      process.execPath,
      ["-e", "console.log(process.env.OPENAI_API_KEY || 'not inherited')"],
      root,
    );
    expect(r.log).toContain("not inherited");
    expect(r.log).not.toContain("test-not-a-secret");
  } finally {
    if (key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = key;
  }
  const large = await run(
    process.execPath,
    ["-e", "console.log('x'.repeat(30000))"],
    root,
  );
  expect(large.log.length).toBeLessThanOrEqual(24000);
  const timeout = await run(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    root,
    150,
  );
  expect(timeout).toMatchObject({ status: "failed" });
  expect(timeout.log).toContain("timed out");
});
test.skipIf(process.platform === "win32")(
  "stop reaps an owned group even after its parent has exited",
  async () => {
    const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync('descendant.pid',String(child.pid)); child.unref(); setTimeout(()=>process.exit(0),150);`;
    const parent = launch(process.execPath, ["-e", script], root);
    await new Promise<void>((resolve) => parent.once("exit", () => resolve()));
    const pid = Number(
      await fs.readFile(path.join(root, "descendant.pid"), "utf8"),
    );
    try {
      process.kill(pid, 0);
      await stopChild(parent);
      await until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      });
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already reaped. */
      }
    }
  },
);
