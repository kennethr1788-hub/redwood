import { promises as fs } from "node:fs";
import { run } from "../preview/process";
import { quote } from "../agent/handoff";

const clean = (s: string) =>
  s.replace(/\nExit:[^\n]*$/, "").replace(/\r?\n$/, "");
export async function gitStatus(folder: string) {
  // Status is read before project trust. Do not execute a repository's fsmonitor hook.
  const git = (args: string[]) =>
    run(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args],
      folder,
      5000,
    );
  let canonical: string;
  try {
    canonical = await fs.realpath(folder);
  } catch (e) {
    return {
      branch: "Git unavailable",
      files: `Cannot read project folder: ${(e as Error).message}`,
      history: "",
    };
  }
  const root = await git(["rev-parse", "--show-toplevel"]);
  if (root.status !== "passed") {
    if (!root.log.includes("not a git repository"))
      return {
        branch: "Git unavailable",
        files: clean(root.log),
        history:
          "Could not inspect Git. Check Git installation and repository permissions.",
      };
  } else {
    const top = await fs.realpath(clean(root.log)).catch(() => "");
    if (top === canonical) {
      const [branch, files, head] = await Promise.all([
        git(["symbolic-ref", "--quiet", "--short", "HEAD"]),
        git(["status", "--short", "--untracked-files=normal"]),
        git(["rev-parse", "--verify", "HEAD"]),
      ]);
      const history =
        head.status === "passed"
          ? await git(["log", "-5", "--format=%h %s"])
          : null;
      return {
        branch:
          branch.status === "passed"
            ? clean(branch.log)
            : head.status === "passed"
              ? `Detached HEAD (${clean(head.log).slice(0, 7)})`
              : "Cannot read Git HEAD",
        files:
          files.status === "passed"
            ? clean(files.log) || "Working tree clean"
            : `Git status failed:\n${clean(files.log)}`,
        history: history
          ? history.status === "passed"
            ? clean(history.log)
            : `Git history failed:\n${clean(history.log)}`
          : branch.status === "passed" && files.status === "passed"
            ? "No commits yet. Review the diff and commit from your editor or terminal when ready."
            : `Git HEAD failed:\n${clean(head.log)}`,
      };
    }
  }
  return {
    branch: "No project Git repository",
    files: `Source files are yours. To start project-only version history, run in a POSIX terminal:\ncd ${quote(canonical)} && git init -b main\nThen review files before staging or committing. Parent repository history is not shown.`,
    history: "",
  };
}
