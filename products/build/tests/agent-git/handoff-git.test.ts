import { DISPLAY_NAMES } from "../../../../launcher/src/display-names.js";
import { afterEach, beforeEach, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { handoff, briefDocument } from "../../src/agent/handoff";
import { gitStatus } from "../../src/git/status";
import { Projects } from "../../src/core/projects";
import { run } from "../../src/preview/process";
import type { Project } from "../../src/core/types";
let root: string;
const input = {
  name: "Tool Handoff",
  brief: "Build an ordinary app with owned source.",
  reference: "",
  tool: "codex" as const,
};
const project: Project = {
  ...input,
  id: "tool-handoff",
  schemaVersion: 1,
  createdAt: "",
  updatedAt: "",
  imported: false,
};
beforeEach(async () => {
  await fs.mkdir(".local", { recursive: true });
  root = await fs.mkdtemp(path.resolve(".local/agent git ' space-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const git = async (...args: string[]) => {
  const r = await run(
    "git",
    [
      "-c",
      "user.name=LaunchForge Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    root,
  );
  expect(r.status, r.log).toBe("passed");
};
test("all three copy commands preserve shell metacharacters as a single path without launching a provider", async () => {
  const folder = path.join(
    root,
    "it's $(touch ESCAPED) `touch ESCAPED2` ; & project",
  );
  await fs.mkdir(folder);
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  for (const tool of ["codex", "claude", "cursor"] as const)
    await fs.writeFile(
      path.join(bin, tool),
      '#!/bin/sh\n/bin/pwd\nprintf "ARG:%s\\n" "$@"\n',
      { mode: 0o700 },
    );
  const old = process.env.PATH;
  process.env.PATH = bin + path.delimiter + old;
  try {
    for (const tool of ["codex", "claude", "cursor"] as const) {
      const h = handoff({ ...project, tool }, folder);
      const result = await run("/bin/sh", ["-c", h.command], root);
      expect(result.status).toBe("passed");
      expect(result.log).toContain(
        tool === "cursor" ? `ARG:${folder}` : folder,
      );
      expect(h.prompt).toContain("existing project instructions");
      expect(h.prompt).toContain(`return to ${DISPLAY_NAMES.umbrella}`);
    }
    expect(await fs.readdir(root)).not.toContain("ESCAPED");
    expect(await fs.readdir(root)).not.toContain("ESCAPED2");
    expect(await fs.readdir(folder)).toEqual([]);
  } finally {
    process.env.PATH = old;
  }
});
test("handoff rejects relative/control paths and unknown tools; neutral brief explains manual authentication and return", () => {
  for (const folder of [
    "../escape",
    "relative",
    "/tmp/new\ncommand",
    "/tmp/zero\0byte",
  ])
    expect(() => handoff(project, folder)).toThrow("absolute project path");
  expect(() =>
    handoff({ ...project, tool: "codex; injected" as Project["tool"] }, root),
  ).toThrow("Choose Codex");
  const brief = briefDocument({ ...project, imported: true });
  for (const expected of [
    "official client",
    "do not submit the brief automatically",
    "Codex",
    "Claude Code",
    "Cursor",
    "imported project",
    "session-only",
    "old passing check",
  ])
    expect(brief).toContain(expected);
});
test("Git exposes unborn, dirty, committed, clean and detached states without changing history", async () => {
  await git("init", "-b", "main");
  expect((await gitStatus(root)).history).toContain("No commits yet");
  await fs.writeFile(path.join(root, "ordinary source.txt"), "hello");
  expect((await gitStatus(root)).files).toContain("ordinary source.txt");
  await git("add", "ordinary source.txt");
  await git("commit", "-m", "Owned source checkpoint");
  const clean = await gitStatus(root);
  expect(clean.branch).toBe("main");
  expect(clean.files).toBe("Working tree clean");
  expect(clean.history).toContain("Owned source checkpoint");
  await git("checkout", "--detach");
  expect((await gitStatus(root)).branch).toMatch(
    /^Detached HEAD \([a-f0-9]{7}\)$/,
  );
  await fs.writeFile(path.join(root, "ordinary source.txt"), "edit");
  expect((await gitStatus(root)).files).toContain(" M ");
});
test("imports do not expose ancestor Git history and offer a quoted project-only initialization command", async () => {
  await git("init", "-b", "main");
  const child = path.join(root, "child");
  await fs.mkdir(child);
  const status = await gitStatus(child);
  expect(status.branch).toBe("No project Git repository");
  expect(status.history).toBe("");
  expect(status.files).toContain("git init -b main");
  const command = status.files.split("\n")[1];
  expect((await run("/bin/sh", ["-c", command], root)).status).toBe("passed");
  expect((await gitStatus(child)).branch).toBe("main");
});
test("Git configuration failures are visible and status does not execute fsmonitor hooks", async () => {
  await git("init", "-b", "main");
  const hook = path.join(root, "monitor.sh");
  await fs.writeFile(hook, "#!/bin/sh\ntouch MONITOR_EXECUTED\n", {
    mode: 0o700,
  });
  await git("config", "core.fsmonitor", hook);
  await gitStatus(root);
  expect(await fs.readdir(root)).not.toContain("MONITOR_EXECUTED");
  await fs.writeFile(path.join(root, ".git/config"), "[broken");
  const status = await gitStatus(root);
  expect(status.branch).toBe("Git unavailable");
  expect(status.files).toContain("bad config");
  expect(status.history).not.toContain("No commits yet");
});
test("import, reopen and handoff preserve instructions/source and reject escaped project IDs", async () => {
  const store = new Projects(root, path.resolve("templates/react"));
  await store.init();
  const folder = path.join(root, "imported");
  await fs.cp(path.resolve("templates/react"), folder, {
    recursive: true,
    filter: (f) => !f.includes("node_modules"),
  });
  for (const name of ["AGENTS.md", "CLAUDE.md", ".cursor/rules/project.mdc"])
    await fs.writeFile(path.join(folder, name), `Original ${name}`);
  await store.import("imported", input);
  for (const tool of ["codex", "claude", "cursor"] as const) {
    await store.persist({ ...(await store.read("imported")), tool });
    const detail = await new Projects(root, "").detail(
      "imported",
      { status: "stopped", log: "" },
      false,
      null,
    );
    expect(detail.handoff.command).toContain(tool);
    expect(detail.git.branch).toBe("No project Git repository");
  }
  for (const name of ["AGENTS.md", "CLAUDE.md", ".cursor/rules/project.mdc"])
    expect(await fs.readFile(path.join(folder, name), "utf8")).toBe(
      `Original ${name}`,
    );
  for (const id of ["../outside", "/tmp/outside", "x/y", "..", "bad name"])
    await expect(store.folder(id)).rejects.toThrow();
  await fs.symlink(root, path.join(root, "escape"));
  await expect(store.import("escape", input)).rejects.toThrow(
    "real directories",
  );
});
