import { applyDisplayNames } from "../../../../launcher/src/display-names.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { briefDocument, handoff } from "../agent/handoff";
import { gitStatus } from "../git/status";
import { run } from "../preview/process";
import type { Detail, Project, Runtime } from "./types";

import { flowSchema, runSchema, sourceIdentity, freshness } from './verification';
import {buildResume} from '../agent/support';

const idSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,59}$/,
    "Use a project folder name with letters, numbers and hyphens.",
  );
export const inputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  brief: z
    .string()
    .trim()
    .min(10, "Describe your idea in at least 10 characters.")
    .max(12000),
  reference: z.string().max(2000).default(""),
  tool: z.enum(["codex", "claude", "cursor", "gemini", "manual"]).default("codex"),
});
const checkSchema = z.object({
  status: z.enum(["passed", "failed"]),
  at: z.string(),
  log: z.string().max(24000),
});
const projectSchema = inputSchema.extend({
  schemaVersion: z.literal(1),
  id: idSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  imported: z.boolean(),
  previewPort: z.number().int().min(1024).max(65535).optional(),
  flow: flowSchema.optional(),
  verification: runSchema.optional(),
  verificationHistory: z.array(runSchema).max(5).optional(),
  restore: z.object({ id: z.string().uuid(), at: z.string(), target: z.string().max(200), paths: z.array(z.string().max(1024)).max(128), outcome: z.string().max(80), verificationRequired: z.boolean(), verificationRunId: z.string().uuid().optional(), postStatus: z.string().max(24000).optional() }).optional(),
  checks: z
    .object({
      install: checkSchema.optional(),
      typecheck: checkSchema.optional(),
      build: checkSchema.optional(),
      test: checkSchema.optional(),
    })
    .optional(),
});
export async function atomicWrite(filename: string, content: string) {
  const tmp = filename + "." + randomUUID() + ".tmp";
  const handle = await fs.open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, filename);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
  if (process.platform !== "win32") {
    const dir = await fs.open(path.dirname(filename), "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}
export async function regularFile(filename: string, max = 1000000) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max)
    throw new Error(
      "Expected a regular, bounded file: " + path.basename(filename),
    );
  return fs.readFile(filename, "utf8");
}
export class Projects {
  constructor(
    public root: string,
    private template: string,
  ) {}
  async init() {
    await fs.mkdir(this.root, { recursive: true });
    this.root = await fs.realpath(this.root);
  }
  async folder(id: string) {
    idSchema.parse(id);
    const folder = path.join(this.root, id);
    const stat = await fs.lstat(folder);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await fs.realpath(folder)) !== folder
    )
      throw new Error(
        "Project folders must be real directories inside the selected workspace.",
      );
    return folder;
  }
  async metadata(folder: string) {
    const dir = path.join(folder, ".launchforge");
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Invalid .launchforge directory.");
    return dir;
  }
  async read(id: string): Promise<Project> {
    const dir = await this.metadata(await this.folder(id));
    const p = projectSchema.parse(
      JSON.parse(await regularFile(path.join(dir, "project.json"))),
    );
    if (p.id !== id)
      throw new Error("Project identity does not match its folder.");
    return p;
  }
  async list() {
    const projects: Project[] = [];
    const warnings: string[] = [];
    for (const dir of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.name.startsWith(".")) continue;
      try {
        await fs.lstat(path.join(this.root, dir.name, ".launchforge"));
      } catch {
        continue;
      }
      try {
        projects.push(await this.read(dir.name));
      } catch {
        warnings.push(
          `${dir.name}: project metadata could not be read; files were left unchanged.`,
        );
      }
    }
    return {
      projects: projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      warnings,
      workspace: this.root,
    };
  }
  async persist(p: Project) {
    const folder = await this.folder(p.id);
    const dir = await this.metadata(folder);
    // JSON is the canonical state. The handoff document is derived and can be refreshed.
    await atomicWrite(
      path.join(dir, "project.json"),
      JSON.stringify(projectSchema.parse(p), null, 2) + "\n",
    );
    await atomicWrite(path.join(dir, "brief.md"), briefDocument(p));
    return p;
  }
  async create(raw: unknown) {
    const input = inputSchema.parse(raw);
    const id = input.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    idSchema.parse(id);
    const target = path.join(this.root, id);
    try {
      await fs.lstat(target);
      throw new Error(
        "That project folder already exists. Choose another name or open it.",
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const stage = path.join(this.root, ".creating-" + randomUUID());
    const p: Project = {
      ...input,
      schemaVersion: 1,
      id,
      imported: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    try {
      await fs.cp(this.template, stage, {
        recursive: true,
        filter: (source) =>
          !source
            .split(path.sep)
            .some((s) => ["node_modules", "dist", ".git"].includes(s)),
      });
      // Expand only source-owned starter copy, before any project/user data is written.
      for (const relative of ["src/main.tsx", "README.md"]) {
        const file = path.join(stage, relative);
        await atomicWrite(file, applyDisplayNames(await fs.readFile(file, "utf8")));
      }
      await fs.mkdir(path.join(stage, ".launchforge"));
      await atomicWrite(
        path.join(stage, ".launchforge/project.json"),
        JSON.stringify(p, null, 2) + "\n",
      );
      await atomicWrite(
        path.join(stage, ".launchforge/brief.md"),
        briefDocument(p),
      );
      await atomicWrite(
        path.join(stage, "src/project.json"),
        JSON.stringify({ name: p.name, brief: p.brief }, null, 2) + "\n",
      );
      const git = await run("git", ["init", "-b", "main"], stage, 5000);
      if (git.status !== "passed")
        throw new Error(
          "Git initialization failed. Install Git and try again. " + git.log,
        );
      await fs.rename(stage, target);
      return p;
    } catch (e) {
      await fs.rm(stage, { recursive: true, force: true });
      throw e;
    }
  }
  async import(id: string, raw: unknown) {
    const input = inputSchema.parse(raw);
    const folder = await this.folder(id);
    const pkg = JSON.parse(
      await regularFile(path.join(folder, "package.json")),
    );
    if (
      !(
        pkg.dependencies?.react &&
        (pkg.devDependencies?.vite || pkg.dependencies?.vite) &&
        pkg.scripts?.build &&
        pkg.scripts?.typecheck
      )
    )
      throw new Error(
        "Supported imports need React, Vite, and build/typecheck scripts in package.json. No files were changed.",
      );
    await regularFile(path.join(folder, "package-lock.json"), 8000000);
    const dir = path.join(folder, ".launchforge");
    try {
      await fs.mkdir(dir);
    } catch {
      throw new Error(
        "This folder already has .launchforge data. Open the existing project; nothing was overwritten.",
      );
    }
    const p: Project = {
      ...input,
      schemaVersion: 1,
      id,
      imported: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.persist(p);
    return p;
  }
  async detail(
    id: string,
    runtime: Runtime,
    trusted: boolean,
    busy: string | null,
  ): Promise<Detail> {
    const p = await this.read(id);
    const folder = await this.folder(id);
    const files = (await fs.readdir(folder, { withFileTypes: true }))
      .filter((f) => !["node_modules", ".git", "dist"].includes(f.name))
      .map((f) => f.name + (f.isDirectory() ? "/" : ""));
    let identity: string|null=null, identityError;
    try {identity=await sourceIdentity(folder,p.flow);} catch(e){identityError=(e as Error).message;}
    let resume, resumeError;
    try { resume = (await buildResume(p, folder, identity)).record; }
    catch { resumeError = 'Resume unavailable: review the project metadata and regenerate. No completion claim was inferred.'; }
    return {
      resume, resumeError,
      verificationState: p.restore?.verificationRequired && freshness(p.verification,identity).includes('PASS') ? 'VERIFICATION_REQUIRED' : freshness(p.verification,identity), identityError,
      project: p,
      path: folder,
      runtime,
      trusted,
      busy,
      files,
      handoff: handoff(p, folder),
      git: await gitStatus(folder),
    };
  }
}
