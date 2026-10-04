import { afterEach, beforeEach, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Projects } from "../src/core/projects";
import { Lifecycle } from "../src/preview/lifecycle";
import { DISPLAY_NAMES } from "../../../launcher/src/display-names.js";
import { handoff } from "../src/agent/handoff";
let root: string;
let store: Projects;
const input = {
  name: "Garden Notes",
  brief: "A calm place for tracking garden projects.",
  reference: "/reference/leaf.png",
  tool: "codex" as const,
};
beforeEach(async () => {
  await fs.mkdir(".local", { recursive: true });
  root = await fs.mkdtemp(path.resolve(".local/unit-"));
  store = new Projects(root, path.resolve("templates/react"));
  await store.init();
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
test("creation writes independent source, instructions and a Git root; reopening preserves an edited brief", async () => {
  const p = await store.create(input);
  const dir = await store.folder(p.id);
  expect(await fs.readFile(path.join(dir, "src/main.tsx"), "utf8")).toContain(
    `Made with a ${DISPLAY_NAMES.umbrella} starter. Owned by you.`,
  );
  expect(await fs.readFile(path.join(dir, "README.md"), "utf8")).toContain(
    `Your project works without ${DISPLAY_NAMES.umbrella}.`,
  );
  expect(await fs.readFile(path.join(dir, "AGENTS.md"), "utf8")).toContain(
    ".launchforge/brief.md",
  );
  expect(
    await fs.readFile(path.join(dir, "package-lock.json"), "utf8"),
  ).toContain("lockfileVersion");
  await store.persist({
    ...p,
    brief: "Keep a seasonal journal and a planting calendar.",
  });
  const reopened = new Projects(root, path.resolve("templates/react"));
  await reopened.init();
  expect((await reopened.read(p.id)).brief).toContain("seasonal journal");
  expect(
    (await reopened.detail(p.id, { status: "stopped", log: "" }, false, null))
      .git.branch,
  ).toBe("main");
});
test("duplicate creation and path escape leave the original source unchanged", async () => {
  const p = await store.create(input);
  const file = path.join(root, p.id, "src/main.tsx");
  await fs.writeFile(file, "USER OWNED CONTENT");
  await expect(store.create(input)).rejects.toThrow("already exists");
  await expect(store.folder("../outside")).rejects.toThrow();
  expect(await fs.readFile(file, "utf8")).toBe("USER OWNED CONTENT");
});
test("symlinked project and metadata directories are refused before writing", async () => {
  await fs.symlink(root, path.join(root, "escape"));
  await expect(store.folder("escape")).rejects.toThrow("real directories");
  const p = await store.create(input);
  await fs.rename(
    path.join(root, p.id, ".launchforge"),
    path.join(root, p.id, "saved-metadata"),
  );
  await fs.symlink(
    path.join(root, p.id, "saved-metadata"),
    path.join(root, p.id, ".launchforge"),
  );
  await expect(store.persist(p)).rejects.toThrow("Invalid .launchforge");
});
test("unsupported import is non-mutating; supported import preserves root instructions and never runs scripts", async () => {
  await fs.mkdir(path.join(root, "unsupported"));
  await fs.writeFile(path.join(root, "unsupported/package.json"), "{}");
  await expect(store.import("unsupported", input)).rejects.toThrow(
    "Supported imports",
  );
  expect(await fs.readdir(path.join(root, "unsupported"))).toEqual([
    "package.json",
  ]);
  await fs.cp(path.resolve("templates/react"), path.join(root, "imported"), {
    recursive: true,
    filter: (f) => !f.includes("node_modules"),
  });
  await fs.writeFile(
    path.join(root, "imported/AGENTS.md"),
    "MY ORIGINAL INSTRUCTIONS",
  );
  const p = await store.import("imported", input);
  expect(p.imported).toBe(true);
  expect(await fs.readFile(path.join(root, "imported/AGENTS.md"), "utf8")).toBe(
    "MY ORIGINAL INSTRUCTIONS",
  );
  const runtime = new Lifecycle(store);
  await expect(runtime.start("imported")).rejects.toThrow("Trust this project");
  await expect(runtime.check("imported", "install")).rejects.toThrow(
    "Trust this project",
  );
});
test("corrupt metadata is visible and preserved; shell handoff quotes filenames as data", async () => {
  const p = await store.create(input);
  const file = path.join(root, p.id, ".launchforge/project.json");
  await fs.writeFile(file, "{broken");
  expect((await store.list()).warnings[0]).toContain("left unchanged");
  expect(await fs.readFile(file, "utf8")).toBe("{broken");
  expect(handoff(p, "/project/it's $(touch nope)").command).toBe(
    "cd '/project/it'\\''s $(touch nope)' && codex",
  );
});

test("display expansion never rewrites project input or existing source on reopen", async () => {
  const literal = "LaunchForge Forge Studio %LABEL_UMBRELLA% %LABEL_STUDIO%";
  const p = await store.create({ ...input, name: "Studio Forge", brief: literal, reference: literal });
  const dir = await store.folder(p.id);
  const brief = await fs.readFile(path.join(dir, ".launchforge/brief.md"), "utf8");
  expect(brief).toContain(`## Return to ${DISPLAY_NAMES.umbrella}`);
  expect(brief).toContain(literal);
  expect(JSON.parse(await fs.readFile(path.join(dir, "src/project.json"), "utf8"))).toEqual({name: p.name, brief: literal});
  await fs.writeFile(path.join(dir, "src/main.tsx"), literal);
  const reopened = await new Projects(root, path.resolve("templates/react")).read(p.id);
  expect(reopened.name).toBe("Studio Forge");
  expect(reopened.brief).toBe(literal);
  expect(reopened.reference).toBe(literal);
  expect(await fs.readFile(path.join(dir, "src/main.tsx"), "utf8")).toBe(literal);
});
