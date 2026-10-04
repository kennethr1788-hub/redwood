import { DISPLAY_NAMES } from "../../../../launcher/src/display-names.js";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Projects, inputSchema } from "../core/projects";
import { Lifecycle } from "../preview/lifecycle";
import { stopAllChildren } from "../preview/process";

import { flowSchema } from '../core/verification';
import {prepareHandoff} from '../agent/support';

const productRoot = fileURLToPath(new URL("../../", import.meta.url));
const port = Number(process.env.LF_PORT || 4177);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("LF_PORT must be an integer from 1024 to 65535.");
const origin = `http://127.0.0.1:${port}`;
const projects = new Projects(
  path.resolve(
    process.env.LF_WORKSPACE || path.join(productRoot, ".local/projects"),
  ),
  path.join(productRoot, "templates/react"),
);
await projects.init();
const lifecycle = new Lifecycle(projects);
const app = express();
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
  });
  if (req.headers.host !== `127.0.0.1:${port}`)
    return res.status(403).json({ error: `Open ${DISPLAY_NAMES.umbrella} at ${origin}.` });
  if (req.path.startsWith("/api/")) {
    res.set("Cache-Control", "no-store");
    if (
      req.headers["x-launchforge"] !== "1" ||
      (req.headers.origin && req.headers.origin !== origin) ||
      (req.headers["sec-fetch-site"] &&
        req.headers["sec-fetch-site"] !== "same-origin" &&
        req.headers["sec-fetch-site"] !== "none")
    )
      return res
        .status(403)
        .json({
          error: `Use the local ${DISPLAY_NAMES.umbrella} workbench for project operations.`,
        });
  }
  next();
});
app.use(express.json({ limit: "32kb" }));
const detail = (id: string) =>
  projects.detail(
    id,
    lifecycle.state(id),
    lifecycle.trusted.has(id),
    lifecycle.busy,
  );
app.get("/api/projects", async (_req, res) => res.json(await projects.list()));
app.post("/api/projects", async (req, res) =>
  res
    .status(201)
    .json(
      await lifecycle.exclusive("Creating project", () =>
        projects.create(req.body),
      ),
    ),
);
app.post("/api/import", async (req, res) => {
  const body = z.object({ folder: z.string() }).parse(req.body);
  res
    .status(201)
    .json(
      await lifecycle.exclusive("Opening project", () =>
        projects.import(body.folder, req.body),
      ),
    );
});
app.get("/api/projects/:id", async (req, res) =>
  res.json(await detail(req.params.id)),
);
app.get('/api/projects/:id/resume', async (req, res) => {
  const current = await detail(req.params.id);
  if (!current.resume) return res.status(409).json({error: current.resumeError});
  res.json(current.resume);
});
app.post('/api/projects/:id/handoff', async (req, res) => {
  res.json(await lifecycle.exclusive('Preparing reviewed handoff', async () =>
    prepareHandoff(await projects.read(req.params.id), await projects.folder(req.params.id), req.body)));
});
app.put("/api/projects/:id", async (req, res) => {
  const input = inputSchema.parse(req.body);
  res.json(
    await lifecycle.exclusive("Saving brief", async () => {
      const p = await projects.read(req.params.id);
      return projects.persist({
        ...p,
        ...input,
        updatedAt: new Date().toISOString(),
      });
    }),
  );
});
app.put('/api/projects/:id/flow',async(req,res)=>{
 const flow=flowSchema.parse(req.body);
 res.json(await lifecycle.exclusive('Saving critical flow',async()=>{
  const p=await projects.read(req.params.id);return projects.persist({...p,flow});
 }));
});
app.post("/api/projects/:id/action", async (req, res) => {
  const { action } = z
    .object({
      action: z.enum(["trust", "install", "preview", "stop", "verify"]),
    })
    .parse(req.body);
  const id = req.params.id;
  await projects.read(id);
  const result = await lifecycle.exclusive(action, async () => {
    if (action === "trust") {
      lifecycle.trusted.add(id);
      return { ok: true, message: "Project trusted for this server session." };
    }
    if (action === "stop") {
      await lifecycle.stop(id);
      return {
        ok: true,
        message: "Preview stopped. All source files remain on disk.",
      };
    }
    if (action === "preview") {
      await lifecycle.start(id);
      return { ok: true, message: "Local preview is running." };
    }
    return lifecycle.check(id, action);
  });
  res.json(result);
});
app.post('/api/projects/:id/restore/preview',async(req,res)=>{
 const input=z.object({target:z.string().min(1).max(200),paths:z.array(z.string().min(1).max(1024)).min(1).max(128)}).strict().parse(req.body);
 res.json(await lifecycle.exclusive('Reviewing restore',()=>lifecycle.restorePreview(req.params.id,input.target,input.paths)));
});
app.post('/api/projects/:id/restore/apply',async(req,res)=>{
 const input=z.object({previewToken:z.string().uuid(),statusIdentity:z.string().length(64),reviewed:z.literal(true)}).strict().parse(req.body);
 res.json(await lifecycle.exclusive('Restoring source',()=>lifecycle.restoreApply(req.params.id,input.previewToken,input.statusIdentity,input.reviewed)));
});
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "Unknown project operation." }),
);
app.use(express.static(path.join(productRoot, "dist")));
app.get("/{*path}", (_req, res) =>
  res.sendFile(path.join(productRoot, "dist/index.html")),
);
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const message =
      error instanceof z.ZodError
        ? error.issues.map((i) => i.message).join(" ")
        : error instanceof Error
          ? error.message
          : "The operation failed.";
    res.status(400).json({ error: message });
  },
);
const server = app.listen(port, "127.0.0.1", () =>
  console.log(
    `${DISPLAY_NAMES.umbrella} ${DISPLAY_NAMES.build}: ${origin}\nProject directory: ${projects.root}`,
  ),
);
server.on("error", (e) => {
  console.error(`Cannot start ${DISPLAY_NAMES.umbrella}:`, e.message);
  lifecycle.stop();
  process.exitCode = 1;
});
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    lifecycle.stop();
    stopAllChildren();
    server.close();
    setTimeout(() => process.exit(0), 1800);
  });
