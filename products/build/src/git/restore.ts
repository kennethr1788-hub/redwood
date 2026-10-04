import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { stopChild } from "../preview/process";

// Source files only. No index restoration, checkpoint, database or deployment rollback.
// Callers must serialize external editors/Git operations during apply. Native Git does
// not provide a transaction spanning arbitrary worktree writers or multiple files.
const MAX_PATHS = 128;
const MAX_FILES = 10000;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
const TTL_MS = 5 * 60 * 1000;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const digest = (value: unknown) => hash(JSON.stringify(value));
type FileState = { kind: string; sha256?: string; mode?: number; size?: number };
type TreeEntry = { mode: string; oid: string };
export type RestorePreview = {
  previewToken: string;
  repositoryIdentity: string;
  targetTreeOrCommit: string;
  statusIdentity: string;
  destination: "WORKTREE_ONLY";
  head: string;
  paths: {
    path: string;
    targetState: TreeEntry | null;
    worktreeState: FileState;
    indexState: TreeEntry | null;
    untrackedCollision: boolean;
    action: "WRITE_WORKTREE" | "DELETE_WORKTREE" | "NO_CHANGE" | "BLOCKED";
  }[];
  blockedReasons: string[];
};
type Snapshot = {
  root: string; repositoryIdentity: string; head: string; headRef: string; index: string;
  status: string; config: string; indexEntries: Map<string, TreeEntry>;
  files: Record<string, FileState>; identity: string; flags: string;
};
export class RestoreError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = "RestoreError"; }
}
function refuse(code: string, message: string): never { throw new RestoreError(code, message); }
function pathsInput(paths: string[]) {
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_PATHS)
    refuse("INVALID_PATHS", "Choose 1–128 explicit file paths.");
  const result = [...paths];
  for (const p of result) {
    if (typeof p !== "string" || Buffer.byteLength(p) > 1024 ||
        /[\x00-\x1f\x7f\\:]/.test(p) || path.posix.isAbsolute(p) ||
        p.split("/").some(c => !c || c === "." || c === ".." ||
          c.toLowerCase() === ".git" || /[. ]$/.test(c)))
      refuse("INVALID_PATH", "Use normalized relative file paths outside Git metadata.");
  }
  if (new Set(result.map(p => p.normalize("NFC").toLowerCase())).size !== result.length ||
      result.some(p => result.some(q => p !== q && p.startsWith(q + "/"))))
    refuse("OVERLAPPING_PATHS", "Duplicate, aliased or overlapping paths are unsupported.");
  return result.sort();
}

// Unlike run(), this collector keeps stdout separate and refuses truncation.
// It reuses owned-process cleanup; environment also disables host Git config and lazy fetch.
async function git(folder: string, args: string[], deadline: number, allowFailure = false) {
  if (performance.now() >= deadline) refuse("BOUNDS", "Git inspection exceeded its time limit.");
  const env = Object.fromEntries(["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "SystemRoot"].flatMap(k => process.env[k] ? [[k, process.env[k]!]] : []));
  const child = spawn("git", ["--no-optional-locks", "--literal-pathspecs",
    "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null",
    "-c", "core.untrackedCache=false", "-c", "core.autocrlf=false",
    "-c", "core.eol=lf", "-c", "core.filemode=true", "-c", "submodule.recurse=false",
    "-c", "core.attributesFile=/dev/null", ...args], {
      cwd: folder, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      env: { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1",
        GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", NO_COLOR: "1" },
    });
  return new Promise<string>((resolve, reject) => {
    const stdout: Buffer[] = []; let size = 0; let failed = false;
    const fail = (code: string, message: string) => {
      if (failed) return; failed = true;
      clearTimeout(timer);
      void stopChild(child).then(() => reject(new RestoreError(code, message)));
    };
    const timer = setTimeout(() => fail("BOUNDS", "Git command timed out; inspect current state."),
      Math.min(5000, Math.max(1, deadline - performance.now())));
    child.stdout?.on("data", (data: Buffer) => {
      size += data.length;
      if (size > MAX_OUTPUT) fail("BOUNDS", "Git output exceeds inspection limit.");
      else stdout.push(data);
    });
    child.stderr?.on("data", (data: Buffer) => {
      size += data.length;
      if (size > MAX_OUTPUT) fail("BOUNDS", "Git output exceeds inspection limit.");
    });
    child.once("error", () => fail("GIT_FAILED", "Cannot start native Git."));
    child.once("close", (code) => {
      clearTimeout(timer); if (failed) return;
      if (code !== 0 && !allowFailure) reject(new RestoreError("GIT_FAILED", `Git ${args[0]} failed; inspect current state.`));
      else resolve(code === 0 ? Buffer.concat(stdout).toString("utf8") : "");
    });
  });
}
async function stat(p: string) {
  try { return await fs.lstat(p); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
}
async function bytes(p: string, budget: { bytes: number }) {
  const fd = await fs.open(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.size > MAX_BYTES - budget.bytes)
      refuse("BOUNDS", "Only bounded regular files can be inspected.");
    budget.bytes += before.size;
    const data = Buffer.alloc(before.size);
    let n = 0;
    while (n < data.length) {
      const read = await fd.read(data, n, data.length - n, n);
      if (!read.bytesRead) refuse("STATE_CHANGED", "File changed while reading; preview again.");
      n += read.bytesRead;
    }
    const after = await fd.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      refuse("STATE_CHANGED", "File changed while reading; preview again.");
    return data;
  } finally { await fd.close(); }
}
async function fileState(root: string, p: string, budget: { bytes: number }): Promise<FileState> {
  let at = root;
  const components = p.split("/");
  for (let i = 0; i < components.length; i++) {
    at = path.join(at, components[i]);
    const s = await stat(at);
    if (!s) return { kind: "ABSENT" };
    if (s.isSymbolicLink()) return { kind: "SYMLINK", sha256: hash(await fs.readlink(at)) };
    if (i < components.length - 1) {
      if (!s.isDirectory()) return { kind: "PARENT_NOT_DIRECTORY" };
    } else {
      if (!s.isFile()) return { kind: s.isDirectory() ? "DIRECTORY" : "SPECIAL" };
      if (s.nlink !== 1) return { kind: "HARDLINK" };
      return { kind: "FILE", sha256: hash(await bytes(at, budget)), size: s.size, mode: s.mode & 0o777 };
    }
  }
  return { kind: "ABSENT" };
}
function entries(raw: string, index = false) {
  const out = new Map<string, TreeEntry>();
  for (const row of raw.split("\0").filter(Boolean)) {
    const match = row.match(index ? /^(\d{6}) ([a-f0-9]+) (\d)\t(.+)$/s : /^(\d{6}) \w+ ([a-f0-9]+)\t(.+)$/s);
    if (!match || (index && match[3] !== "0")) refuse("CONFLICT", "Unmerged or unsupported index; resolve manually first.");
    out.set(match[index ? 4 : 3], { mode: match[1], oid: match[2] });
    if (out.size > MAX_FILES) refuse("BOUNDS", "Repository has too many files for bounded restore.");
  }
  return out;
}
async function snapshot(folder: string, explicit: string[], deadline: number): Promise<Snapshot> {
  const root = await fs.realpath(folder);
  if (path.resolve(folder) !== root) refuse("WRONG_ROOT", "Choose the canonical project folder, without symlink aliases.");
  const top = (await git(root, ["rev-parse", "--show-toplevel"], deadline)).trim();
  if (await fs.realpath(top) !== root) refuse("WRONG_ROOT", "Project must be the exact Git root.");
  const gitDir = (await git(root, ["rev-parse", "--absolute-git-dir"], deadline)).trim();
  const rootStat = await fs.stat(root); const gitStat = await fs.stat(gitDir);
  const repositoryIdentity = digest([root, rootStat.dev, rootStat.ino, gitDir, gitStat.dev, gitStat.ino]);
  // Includes repository-local included config; never return values to callers/logs.
  const configRaw = await git(root, ["config", "--null", "--list", "--includes"], deadline);
  if (configRaw.split("\0").some(row => /^filter\./i.test(row)))
    refuse("FILTER_UNSUPPORTED", "Configured clean/smudge/process filters require manual Git review.");
  const head = (await git(root, ["rev-parse", "--verify", "HEAD"], deadline, true)).trim();
  const headRef = (await git(root, ["symbolic-ref", "--quiet", "HEAD"], deadline, true)).trim();
  if (!head) refuse("UNBORN", "No committed HEAD exists; restore is unavailable.");
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "index.lock"]) {
    if (await stat(path.join(gitDir, name))) refuse("BUSY_OR_CONFLICT", "Finish the active Git operation before restore.");
  }
  const indexPath = path.join(gitDir, "index");
  const index = hash(await bytes(indexPath, { bytes: 0 }));
  const rawIndex = await git(root, ["ls-files", "--stage", "-z"], deadline);
  const indexEntries = entries(rawIndex, true);
  const flags = await git(root, ["ls-files", "-v", "-z"], deadline);
  if (flags.split("\0").filter(Boolean).some(r => r[0] !== "H"))
    refuse("INDEX_FLAGS", "Sparse, assume-unchanged and special index entries require manual review.");
  if ([...indexEntries.values()].some(e => e.mode === "160000"))
    refuse("SUBMODULE", "Submodule repositories are outside this restore slice.");
  const others = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], deadline)).split("\0").filter(Boolean);
  const names = [...new Set([...indexEntries.keys(), ...others, ...explicit])].sort();
  if (names.length > MAX_FILES) refuse("BOUNDS", "Repository has too many files for bounded restore.");
  const files: Record<string, FileState> = Object.create(null);
  const budget = { bytes: 0 };
  for (const name of names) {
    if (performance.now() > deadline) refuse("BOUNDS", "Worktree scan exceeded its time limit.");
    // Git owns these names, but it does not grant filesystem traversal authority.
    pathsInput([name]);
    files[name] = await fileState(root, name, budget);
  }
  const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"], deadline);
  const config = hash(configRaw);
  const value = { root, repositoryIdentity, head, headRef, index, status, config, indexEntries, files, flags };
  return { ...value, identity: digest([repositoryIdentity, head, headRef, index, rawIndex, flags, status, config, files]) };
}
async function inspect(folder: string, target: string, explicit: string[], deadline: number) {
  const paths = pathsInput(explicit);
  if (typeof target !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_./~^{}-]{0,199}$/.test(target))
    refuse("INVALID_TARGET", "Choose an explicit local tree or commit revision.");
  const before = await snapshot(folder, paths, deadline);
  const tree = (await git(before.root, ["rev-parse", "--verify", "--end-of-options", `${target}^{tree}`], deadline)).trim();
  const targetEntries = entries(await git(before.root, ["ls-tree", "-r", "-z", tree], deadline));
  const blockedReasons: string[] = [];
  const previewPaths: RestorePreview["paths"] = [];
  for (const p of paths) {
    const worktreeState = before.files[p];
    const targetState = targetEntries.get(p) ?? null;
    const indexState = before.indexEntries.get(p) ?? null;
    const collision = !indexState && worktreeState.kind !== "ABSENT";
    const reasons: string[] = [];
    if (collision) reasons.push("UNTRACKED_COLLISION");
    if (!["FILE", "ABSENT"].includes(worktreeState.kind)) reasons.push("UNSAFE_FILE_TYPE");
    if ([targetState, indexState].some(e => e && !["100644", "100755"].includes(e.mode))) reasons.push("UNSUPPORTED_MODE");
    if (!targetState && !indexState) reasons.push("TARGET_MISSING_PATH");
    // Never expand a directory path or a rename into an implicit second path.
    if ([...targetEntries.keys(), ...before.indexEntries.keys()].some(q =>
      q.startsWith(p + "/") || p.startsWith(q + "/"))) reasons.push("FILE_DIRECTORY_CONFLICT");
    // Avoid aliases on case-insensitive/Unicode-normalizing filesystems.
    if ([...targetEntries.keys(), ...before.indexEntries.keys(), ...Object.keys(before.files)].some(q =>
      q !== p && q.normalize("NFC").toLowerCase() === p.normalize("NFC").toLowerCase())) reasons.push("PATH_ALIAS");
    for (const source of [[], ["--source", tree]]) {
      const attrs = (await git(before.root, ["check-attr", ...source, "-z", "--all", "--", p], deadline)).split("\0");
      for (let i = 0; i + 2 < attrs.length; i += 3) {
        if (["filter", "ident", "text", "eol", "working-tree-encoding"].includes(attrs[i + 1]) &&
            !["unset", "unspecified"].includes(attrs[i + 2])) reasons.push("CONTENT_TRANSFORM_UNSUPPORTED");
      }
    }
    let equal = false;
    if (targetState && ["100644", "100755"].includes(targetState.mode)) {
      const size = Number((await git(before.root, ["cat-file", "-s", targetState.oid], deadline)).trim());
      if (!Number.isSafeInteger(size) || size > MAX_OUTPUT / 2) reasons.push("TARGET_TOO_LARGE");
      // A raw blob hash proves bytes independently of Git's stat cache/clean filters.
      else {
        const actual = worktreeState.kind === "FILE"
          ? (await git(before.root, ["hash-object", "--no-filters", "--", p], deadline)).trim() : "";
        equal = actual === targetState.oid &&
          Boolean((worktreeState.mode ?? 0) & 0o111) === (targetState.mode === "100755");
      }
    }
    blockedReasons.push(...reasons.map(r => `${r}: ${p}`));
    previewPaths.push({ path: p, targetState, worktreeState, indexState, untrackedCollision: collision,
      action: reasons.length ? "BLOCKED" : equal || (!targetState && worktreeState.kind === "ABSENT")
        ? "NO_CHANGE" : targetState ? "WRITE_WORKTREE" : "DELETE_WORKTREE" });
  }
  const after = await snapshot(folder, paths, deadline);
  if (after.identity !== before.identity) refuse("STATE_CHANGED", "Source changed during inspection; preview again.");
  const preview: RestorePreview = { previewToken: "", repositoryIdentity: before.repositoryIdentity,
    targetTreeOrCommit: tree, statusIdentity: before.identity, head: before.head,
    destination: "WORKTREE_ONLY", paths: previewPaths, blockedReasons: [...new Set(blockedReasons)] };
  return { preview, snapshot: before };
}
export async function inspectRestoreState(folder: string, target: string, explicitPaths: string[]) {
  return (await inspect(folder, target, explicitPaths, performance.now() + 20000)).preview;
}
export async function postRestoreStatus(folder: string, explicitPaths: string[]) {
  const s = await snapshot(folder, pathsInput(explicitPaths), performance.now() + 20000);
  return { repositoryIdentity: s.repositoryIdentity, head: s.head, statusIdentity: s.identity,
    indexIdentity: s.index, status: s.status, paths: explicitPaths.map(p => ({ path: p, state: s.files[p] })) };
}
class RestoreOwner {
  private pending = new Map<string, { folder: string; target: string; preview: RestorePreview; created: number }>();
  private busy = new Set<string>();
  async preview(folder: string, target: string, paths: string[]) {
    const { preview, snapshot: s } = await inspect(folder, target, paths, performance.now() + 20000);
    for (const [key, value] of this.pending) if (performance.now() - value.created > TTL_MS) this.pending.delete(key);
    if (this.pending.size >= 32) this.pending.delete(this.pending.keys().next().value!);
    preview.previewToken = randomUUID();
    this.pending.set(preview.previewToken, { folder: s.root, target, preview: structuredClone(preview), created: performance.now() });
    return preview;
  }
  async apply(folder: string, token: string, statusIdentity: string) {
    const saved = this.pending.get(token);
    if (!saved || performance.now() - saved.created > TTL_MS) refuse("INVALID_PREVIEW", "Preview expired or unavailable; preview again.");
    this.pending.delete(token); // Single-use even on failure; no blind retry after partial effects.
    if (path.resolve(folder) !== saved.folder || saved.preview.statusIdentity !== statusIdentity)
      refuse("INVALID_PREVIEW", "Preview belongs to another folder or state.");
    if (saved.preview.blockedReasons.length) refuse("BLOCKED", saved.preview.blockedReasons.join("; "));
    if (this.busy.has(saved.folder)) refuse("BUSY", "Another restore is running.");
    this.busy.add(saved.folder);
    let mutationStarted = false;
    try {
      const deadline = performance.now() + 20000;
      const selected = saved.preview.paths.map(p => p.path);
      const current = await inspect(folder, saved.target, selected, deadline);
      const expected = { ...saved.preview, previewToken: "" };
      if (digest(current.preview) !== digest(expected)) refuse("STATE_CHANGED", "HEAD, target, index or worktree changed; preview again.");
      // Last bounded read immediately precedes the one path-scoped mutation.
      const last = await snapshot(folder, selected, deadline);
      if (last.identity !== current.snapshot.identity) refuse("STATE_CHANGED", "Source changed before mutation; preview again.");
      const changed = current.preview.paths.filter(p => p.action !== "NO_CHANGE");
      if (changed.length) {
        mutationStarted = true;
        await git(folder, ["restore", `--source=${current.preview.targetTreeOrCommit}`, "--worktree",
          "--no-recurse-submodules", "--", ...changed.map(p => p.path)], deadline);
      }
      const after = await snapshot(folder, selected, performance.now() + 20000);
      const unrelated = (s: Snapshot) => Object.entries(s.files).filter(([p]) => !selected.includes(p));
      if (after.head !== last.head || after.headRef !== last.headRef || after.index !== last.index || after.config !== last.config ||
          after.repositoryIdentity !== last.repositoryIdentity || digest(unrelated(after)) !== digest(unrelated(last)))
        refuse("POST_STATE_MISMATCH", "State outside restore scope changed; inspect manually. No rollback attempted.");
      for (const p of current.preview.paths) {
        if (!p.targetState) {
          if (after.files[p.path].kind !== "ABSENT") refuse("POST_STATE_MISMATCH", "Expected deletion was not observed.");
        } else {
          if (after.files[p.path].kind !== "FILE") refuse("POST_STATE_MISMATCH", "Expected regular file was not observed.");
          const oid = (await git(folder, ["hash-object", "--no-filters", "--", p.path], performance.now() + 5000)).trim();
          if (oid !== p.targetState.oid || Boolean((after.files[p.path].mode ?? 0) & 0o111) !== (p.targetState.mode === "100755"))
            refuse("POST_STATE_MISMATCH", "Restored content or mode differs from the reviewed target.");
        }
      }
      return { outcome: "RESTORED_SOURCE_ONLY" as const, repositoryIdentity: after.repositoryIdentity,
        head: after.head, statusIdentity: after.identity, indexIdentity: after.index, status: after.status,
        paths: selected.map(p => ({ path: p, state: after.files[p] })), verificationRequired: true as const };
    } catch (error) {
      if (mutationStarted) throw new RestoreError("RECONCILE_REQUIRED", `Restore attempted; partial effects are possible. Inspect current status before any retry. ${(error as Error).message}`);
      throw error;
    } finally { this.busy.delete(saved.folder); }
  }
}
const owner = new RestoreOwner();
export const previewRestore = (folder: string, target: string, explicitPaths: string[]) => owner.preview(folder, target, explicitPaths);
export const applyRestore = (folder: string, previewToken: string, currentIdentity: string) => owner.apply(folder, previewToken, currentIdentity);
