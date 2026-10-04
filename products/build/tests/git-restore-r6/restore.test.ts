import { afterEach, describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { applyRestore, inspectRestoreState, postRestoreStatus, previewRestore } from "../../src/git/restore";
const roots: string[] = [];
const env = { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
const git = (r: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: r, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = async (r: string, p: string, value: string | Buffer) => { await fs.mkdir(path.dirname(path.join(r, p)), { recursive: true }); await fs.writeFile(path.join(r, p), value); };
async function repo(unborn = false) {
  const r = await fs.mkdtemp(path.join(os.tmpdir(), "lf-restore-r6-")); roots.push(r);
  git(r, "init", "-b", "main");
  if (!unborn) {
    await write(r, "a.txt", "old\n"); await write(r, "b.txt", "keep\n"); await write(r, ".gitignore", "ignored.txt\n");
    git(r, "add", "--", "a.txt", "b.txt", ".gitignore"); git(r, "commit", "-m", "initial");
  }
  return await fs.realpath(r);
}
const read = (r: string, p = "a.txt") => fs.readFile(path.join(r, p), "utf8");
const preview = (r: string, target = "HEAD", paths = ["a.txt"]) => previewRestore(r, target, paths);
const apply = async (r: string, target = "HEAD", paths = ["a.txt"]) => {
  const p = await preview(r, target, paths); expect(p.blockedReasons).toEqual([]);
  return applyRestore(r, p.previewToken, p.statusIdentity);
};
const index = (r: string) => fs.readFile(path.join(r, ".git/index"));
afterEach(async () => { vi.unstubAllEnvs(); for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true }); });
describe("native protected worktree restore", () => {
  test("clean older file restore leaves HEAD/index intact", async () => {
    const r = await repo(); const old = git(r, "rev-parse", "HEAD");
    await write(r, "a.txt", "new\n"); git(r, "add", "a.txt"); git(r, "commit", "-m", "new");
    const head = git(r, "rev-parse", "HEAD"); const before = await index(r);
    const p = await preview(r, old); expect(p.paths[0].action).toBe("WRITE_WORKTREE");
    expect((await applyRestore(r, p.previewToken, p.statusIdentity)).outcome).toBe("RESTORED_SOURCE_ONLY");
    expect(await read(r)).toBe("old\n"); expect(git(r, "rev-parse", "HEAD")).toBe(head); expect(await index(r)).toEqual(before);
  });
  test("clean no-op", async () => { const r = await repo(); expect((await preview(r)).paths[0].action).toBe("NO_CHANGE"); await apply(r); });
  test("unstaged modification", async () => { const r = await repo(); await write(r, "a.txt", "dirty\n"); await apply(r); expect(await read(r)).toBe("old\n"); });
  test("staged-only change preserves staged bytes", async () => {
    const r = await repo(); await write(r, "a.txt", "staged\n"); git(r, "add", "a.txt"); const before = await index(r);
    await apply(r); expect(await read(r)).toBe("old\n"); expect(git(r, "show", ":a.txt")).toBe("staged"); expect(await index(r)).toEqual(before);
  });
  test("staged/worktree split is explicit and preserves index", async () => {
    const r = await repo(); await write(r, "a.txt", "staged\n"); git(r, "add", "a.txt"); await write(r, "a.txt", "worktree\n");
    const p = await preview(r); expect(p.paths[0].indexState?.oid).not.toBe(p.paths[0].targetState?.oid);
    const before = await index(r); await applyRestore(r, p.previewToken, p.statusIdentity); expect(await index(r)).toEqual(before); expect(await read(r)).toBe("old\n");
  });
  test("unrelated staged, dirty, untracked and ignored files preserved", async () => {
    const r = await repo(); await write(r, "b.txt", "staged-b\n"); git(r, "add", "b.txt"); await write(r, "b.txt", "dirty-b\n");
    await write(r, "loose.txt", "untracked"); await write(r, "ignored.txt", "ignored"); await write(r, "a.txt", "dirty-a");
    const before = await index(r); await apply(r); expect(await index(r)).toEqual(before);
    expect(await read(r, "b.txt")).toBe("dirty-b\n"); expect(await read(r, "loose.txt")).toBe("untracked"); expect(await read(r, "ignored.txt")).toBe("ignored");
  });
  test.each(["loose.txt", "ignored.txt"])("untracked or ignored collision: %s", async name => {
    const r = await repo(); await write(r, name, "target"); git(r, "add", "-f", "--", name); git(r, "commit", "-m", "target"); const target = git(r, "rev-parse", "HEAD");
    git(r, "rm", "--", name); git(r, "commit", "-m", "remove"); await write(r, name, "precious");
    const p = await preview(r, target, [name]); expect(p.paths[0].untrackedCollision).toBe(true);
    await expect(applyRestore(r, p.previewToken, p.statusIdentity)).rejects.toMatchObject({ code: "BLOCKED" }); expect(await read(r, name)).toBe("precious");
  });
  test("restore working deletion", async () => { const r = await repo(); await fs.unlink(path.join(r, "a.txt")); await apply(r); expect(await read(r)).toBe("old\n"); });
  test("target missing tracked path previews and performs deletion only in worktree", async () => {
    const r = await repo(); const old = git(r, "rev-parse", "HEAD"); await write(r, "added.txt", "added"); git(r, "add", "added.txt"); git(r, "commit", "-m", "add");
    const before = await index(r); const p = await preview(r, old, ["added.txt"]); expect(p.paths[0].action).toBe("DELETE_WORKTREE");
    await applyRestore(r, p.previewToken, p.statusIdentity); expect(await index(r)).toEqual(before); expect(git(r, "show", ":added.txt")).toBe("added");
    await expect(fs.stat(path.join(r, "added.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("target missing unknown path refuses", async () => { const r = await repo(); expect((await preview(r, "HEAD", ["unknown"])).blockedReasons.join()).toContain("TARGET_MISSING_PATH"); });
  test("staged rename never expands the scope", async () => {
    const r = await repo(); git(r, "mv", "a.txt", "renamed.txt"); const before = await index(r);
    await apply(r); expect(await read(r)).toBe("old\n"); expect(await read(r, "renamed.txt")).toBe("old\n"); expect(await index(r)).toEqual(before);
  });
  test("file/directory replacement refuses without touching children", async () => {
    const r = await repo(); await fs.unlink(path.join(r, "a.txt")); await write(r, "a.txt/child", "precious");
    const p = await preview(r); expect(p.blockedReasons.join()).toContain("UNSAFE_FILE_TYPE"); expect(await read(r, "a.txt/child")).toBe("precious");
  });
  test("target directory cannot expand to child paths", async () => {
    const r = await repo(); await write(r, "dir/child", "child"); git(r, "add", "dir/child"); git(r, "commit", "-m", "dir");
    expect((await preview(r, "HEAD", ["dir"])).blockedReasons.join()).toContain("FILE_DIRECTORY_CONFLICT");
  });
  test("unborn repo refusal", async () => { const r = await repo(true); await expect(preview(r)).rejects.toMatchObject({ code: "UNBORN" }); });
  test("detached HEAD supported and unchanged", async () => {
    const r = await repo(); git(r, "checkout", "--detach"); const head = git(r, "rev-parse", "HEAD"); await write(r, "a.txt", "dirty"); await apply(r);
    expect(git(r, "rev-parse", "HEAD")).toBe(head); expect(git(r, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
  });
  test("real merge conflict refusal", async () => {
    const r = await repo(); git(r, "checkout", "-b", "side"); await write(r, "a.txt", "side"); git(r, "add", "a.txt"); git(r, "commit", "-m", "side");
    git(r, "checkout", "main"); await write(r, "a.txt", "main"); git(r, "add", "a.txt"); git(r, "commit", "-m", "main");
    expect(() => git(r, "merge", "side")).toThrow(); const before = await read(r); await expect(preview(r)).rejects.toMatchObject({ code: "BUSY_OR_CONFLICT" }); expect(await read(r)).toBe(before);
  });
  test.each(["../escape", "/tmp/escape", "a/../b", "a//b", ".git/config", ".GiT/config", "a\\b", ":(glob)*", "a\n.txt"])("invalid path %j", async p => {
    const r = await repo(); await expect(preview(r, "HEAD", [p])).rejects.toMatchObject({ code: "INVALID_PATH" });
  });
  test("duplicates and overlapping paths refuse", async () => { const r = await repo(); await expect(preview(r, "HEAD", ["a", "a/b"])).rejects.toMatchObject({ code: "OVERLAPPING_PATHS" }); });
  test("non-root child refuses parent repository", async () => { const r = await repo(); await fs.mkdir(path.join(r, "child")); await expect(preview(path.join(r, "child"))).rejects.toMatchObject({ code: "WRONG_ROOT" }); });
  test("same-status worktree edit after preview refuses", async () => {
    const r = await repo(); await write(r, "a.txt", "dirty-one"); const p = await preview(r); await write(r, "a.txt", "dirty-two");
    await expect(applyRestore(r, p.previewToken, p.statusIdentity)).rejects.toMatchObject({ code: "STATE_CHANGED" }); expect(await read(r)).toBe("dirty-two");
  });
  test("untracked content change after preview refuses", async () => {
    const r = await repo(); await write(r, "loose", "one"); const p = await preview(r); await write(r, "loose", "two");
    await expect(applyRestore(r, p.previewToken, p.statusIdentity)).rejects.toMatchObject({ code: "STATE_CHANGED" });
  });
  test("index-only edit after preview refuses", async () => {
    const r = await repo(); await write(r, "b.txt", "new"); const p = await preview(r); git(r, "add", "b.txt");
    await expect(applyRestore(r, p.previewToken, p.statusIdentity)).rejects.toMatchObject({ code: "STATE_CHANGED" });
  });
  test("HEAD movement after preview refuses", async () => { const r = await repo(); const p = await preview(r); git(r, "commit", "--allow-empty", "-m", "move"); await expect(applyRestore(r, p.previewToken, p.statusIdentity)).rejects.toMatchObject({ code: "STATE_CHANGED" }); });
  test("symbolic target moved after preview refuses", async () => {
    const r = await repo(); git(r, "branch", "target"); await write(r, "a.txt", "next"); git(r, "add", "a.txt"); git(r, "commit", "-m", "next");
    const p = await preview(r, "target"); git(r, "branch", "-f", "target", "HEAD"); await expect(applyRestore(r, p.previewToken, p.statusIdentity)).rejects.toMatchObject({ code: "STATE_CHANGED" });
  });
  test("caller-edited preview does not change authorized target/paths", async () => {
    const r = await repo(); await write(r, "a.txt", "dirty"); await write(r, "b.txt", "precious"); const p = await preview(r);
    p.paths[0].path = "b.txt"; p.targetTreeOrCommit = "fake"; await applyRestore(r, p.previewToken, p.statusIdentity);
    expect(await read(r)).toBe("old\n"); expect(await read(r, "b.txt")).toBe("precious");
  });
  test("unknown/replayed tokens and wrong identity refuse", async () => {
    const r = await repo(); await expect(applyRestore(r, "made-up", "fake")).rejects.toMatchObject({ code: "INVALID_PREVIEW" });
    const p = await preview(r); await applyRestore(r, p.previewToken, p.statusIdentity);
    await expect(applyRestore(r, p.previewToken, p.statusIdentity)).rejects.toMatchObject({ code: "INVALID_PREVIEW" });
    const q = await preview(r); await expect(applyRestore(r, q.previewToken, "fake")).rejects.toMatchObject({ code: "INVALID_PREVIEW" });
  });
  test("symlink selected or ancestor refuses without following", async () => {
    const r = await repo(); await fs.unlink(path.join(r, "a.txt")); await fs.symlink("b.txt", path.join(r, "a.txt"));
    expect((await preview(r)).blockedReasons.join()).toContain("UNSAFE_FILE_TYPE"); expect(await read(r, "b.txt")).toBe("keep\n");
  });
  test("hardlinked selected file refuses", async () => { const r = await repo(); await fs.link(path.join(r, "a.txt"), path.join(r, "linked")); expect((await preview(r)).blockedReasons.join()).toContain("UNSAFE_FILE_TYPE"); });
  test("configured filter refuses before execution", async () => {
    const r = await repo(); git(r, "config", "filter.danger.clean", "touch FILTER_RAN"); await write(r, ".gitattributes", "a.txt filter=danger\n");
    await expect(preview(r)).rejects.toMatchObject({ code: "FILTER_UNSUPPORTED" }); await expect(fs.stat(path.join(r, "FILTER_RAN"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("fsmonitor and hooks do not execute", async () => {
    const r = await repo(); await write(r, "hook.sh", "#!/bin/sh\ntouch HOOK_RAN\n"); await fs.chmod(path.join(r, "hook.sh"), 0o755);
    git(r, "config", "core.fsmonitor", path.join(r, "hook.sh")); await write(r, ".git/hooks/post-checkout", "#!/bin/sh\ntouch HOOK_RAN\n"); await fs.chmod(path.join(r, ".git/hooks/post-checkout"), 0o755);
    await write(r, "a.txt", "dirty"); await apply(r); await expect(fs.stat(path.join(r, "HOOK_RAN"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("transformed contents refused", async () => { const r = await repo(); await write(r, ".gitattributes", "a.txt text eol=crlf\n"); expect((await preview(r)).blockedReasons.join()).toContain("CONTENT_TRANSFORM_UNSUPPORTED"); });
  test("binary bytes and executable bit restore exactly", async () => {
    const r = await repo(); const data = Buffer.from([0, 255, 254, 13, 10, 128]); await write(r, "a.txt", data); await fs.chmod(path.join(r, "a.txt"), 0o755); git(r, "add", "a.txt"); git(r, "commit", "-m", "binary");
    await write(r, "a.txt", "dirty"); await fs.chmod(path.join(r, "a.txt"), 0o644); await apply(r); expect(await fs.readFile(path.join(r, "a.txt"))).toEqual(data); expect((await fs.stat(path.join(r, "a.txt"))).mode & 0o111).not.toBe(0);
  });
  test("literal glob characters never expand scope", async () => {
    const r = await repo(); await write(r, "*.txt", "literal"); git(r, "--literal-pathspecs", "add", "--", "*.txt"); git(r, "commit", "-m", "literal"); await write(r, "*.txt", "dirty"); await write(r, "a.txt", "precious");
    await apply(r, "HEAD", ["*.txt"]); expect(await read(r, "*.txt")).toBe("literal"); expect(await read(r)).toBe("precious");
  });
  test("spaces, quotes and leading dash paths restore literally", async () => {
    const r = await repo(); const p = "-a 'file'.txt"; await write(r, p, "original"); git(r, "add", "--", p); git(r, "commit", "-m", "name"); await write(r, p, "dirty"); await apply(r, "HEAD", [p]); expect(await read(r, p)).toBe("original");
  });
  test("inspection and post-status do not issue mutation tokens", async () => {
    const r = await repo(); const before = await index(r); expect((await inspectRestoreState(r, "HEAD", ["a.txt"])).previewToken).toBe("");
    expect((await postRestoreStatus(r, ["a.txt"])).head).toBe(git(r, "rev-parse", "HEAD")); expect(await index(r)).toEqual(before);
  });
  test("oversized file fails bounded", async () => { const r = await repo(); await write(r, "large", Buffer.alloc(33 * 1024 * 1024)); await expect(preview(r)).rejects.toMatchObject({ code: "BOUNDS" }); });
  test("index lock refuses", async () => { const r = await repo(); await write(r, ".git/index.lock", "owned elsewhere"); await expect(preview(r)).rejects.toMatchObject({ code: "BUSY_OR_CONFLICT" }); });
  test("target-only absent file is created without staging", async () => {
    const r = await repo(); git(r, "checkout", "-b", "target"); await write(r, "new.txt", "new"); git(r, "add", "new.txt"); git(r, "commit", "-m", "new");
    const target = git(r, "rev-parse", "HEAD"); git(r, "checkout", "main"); const before = await index(r);
    await apply(r, target, ["new.txt"]); expect(await index(r)).toEqual(before); expect(await read(r, "new.txt")).toBe("new"); expect(git(r, "status", "--short")).toContain("?? new.txt");
  });
  test("multiple selected paths restore together", async () => {
    const r = await repo(); await write(r, "a.txt", "dirty-a"); await write(r, "b.txt", "dirty-b");
    await apply(r, "HEAD", ["a.txt", "b.txt"]); expect(await read(r)).toBe("old\n"); expect(await read(r, "b.txt")).toBe("keep\n");
  });
  test("special file refuses without reading it", async () => {
    const r = await repo(); await fs.unlink(path.join(r, "a.txt")); execFileSync("mkfifo", [path.join(r, "a.txt")]);
    expect((await preview(r)).blockedReasons.join()).toContain("UNSAFE_FILE_TYPE");
  });
  test("assume-unchanged refuses", async () => {
    const r = await repo(); git(r, "update-index", "--assume-unchanged", "a.txt"); await expect(preview(r)).rejects.toMatchObject({ code: "INDEX_FLAGS" });
  });
  test("target path symlink refuses", async () => {
    const r = await repo(); await fs.symlink("b.txt", path.join(r, "link")); git(r, "add", "link"); git(r, "commit", "-m", "link");
    expect((await preview(r, "HEAD", ["link"])).blockedReasons.join()).toContain("UNSUPPORTED_MODE");
  });
  test("Git config change invalidates preview", async () => {
    const r = await repo(); const p = await preview(r); git(r, "config", "restore.fixturemarker", "changed");
    await expect(applyRestore(r, p.previewToken, p.statusIdentity)).rejects.toMatchObject({ code: "STATE_CHANGED" });
  });
  test.each(["failure", "unrelated-edit"])("native mutation boundary fault: %s", async fault => {
    const r = await repo(); await write(r, "a.txt", "dirty"); const p = await preview(r);
    const shim = await fs.mkdtemp(path.join(os.tmpdir(), "lf-restore-shim-")); roots.push(shim);
    const realGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
    const quote = (v: string) => "'" + v.replace(/'/g, "'\"'\"'") + "'";
    await write(shim, "git", `#!/bin/sh\nfor arg do\n if [ "$arg" = restore ]; then\n ${fault === "failure" ? "exit 42" : "printf external > b.txt"}\n fi\ndone\nexec ${quote(realGit)} "$@"\n`);
    await fs.chmod(path.join(shim, "git"), 0o755); vi.stubEnv("PATH", shim + path.delimiter + process.env.PATH);
    await expect(applyRestore(r, p.previewToken, p.statusIdentity)).rejects.toMatchObject({ code: "RECONCILE_REQUIRED" });
    expect(await read(r)).toBe(fault === "failure" ? "dirty" : "old\n");
    expect(await read(r, "b.txt")).toBe(fault === "failure" ? "keep\n" : "external");
    await expect(applyRestore(r, p.previewToken, p.statusIdentity)).rejects.toMatchObject({ code: "INVALID_PREVIEW" });
  });

  test("branch change at identical commit invalidates preview", async () => {
    const r = await repo(); const p = await preview(r); git(r, "checkout", "-b", "other");
    await expect(applyRestore(r, p.previewToken, p.statusIdentity)).rejects.toMatchObject({ code: "STATE_CHANGED" });
  });
});
