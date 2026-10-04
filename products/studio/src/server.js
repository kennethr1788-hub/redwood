import { DISPLAY_NAMES, applyDisplayNames } from "../../../launcher/src/display-names.js";
import {detectSilence,reviewSilence} from './audio/review.js';
import {transcriptContext,transcriptView,proposeTranscript,reviewTranscript} from './timeline/reviews.js';
import {proposeFocusBlocksFromEvents} from './focus/blocks.js';
import {editInterval} from './timeline/project.js';
import http from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { Store, atomicJSON, safeFile } from "./core/store.js";
import { captureFlow } from "./capture/index.js";
import {inspectFrame} from './render/inspection.js';
import {parseSrt,parseVtt} from './transcript/srt.js';
import { renderProject } from "./render/index.js";
const here = dirname(fileURLToPath(import.meta.url));
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".png": "image/png",
  ".gif": "image/gif",
  ".json": "application/json",
  ".vtt": "text/vtt",
  ".woff2": "font/woff2",
};
async function body(req, max = 1024 * 1024) {
  let n = 0;
  const chunks = [];
  for await (const c of req) {
    n += c.length;
    if (n > max) throw Error("Request too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function json(res, value, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
async function file(req, res, path) {
  const stat = await fs.stat(path);
  const headers = {
    "Content-Type": types[extname(path)] || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-cache",
  };
  let start = 0,
    end = stat.size - 1,
    status = 200;
  if (req.headers.range) {
    const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    if (!r) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }
    start = Number(r[1]);
    end = r[2] ? Number(r[2]) : end;
    if (start > end || end >= stat.size) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers["Content-Length"] = end - start + 1;
  res.writeHead(status, headers);
  const stream = createReadStream(path, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}
export async function startServer({
  port = Number(process.env.STUDIO_PORT || 4318),
  root = process.env.STUDIO_PROJECTS_DIR,
} = {}) {
  const store = new Store(root);
  await store.init();
  const token = randomBytes(32).toString("hex");
  const jobs = new Map();
  let mediaBusy = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    );
    try {
      const host = req.headers.host;
      const expected = `127.0.0.1:${server.address().port}`;
      if (host !== expected && host !== `localhost:${server.address().port}`)
        return json(res, { error: "Unrecognized local Host" }, 403);
      if (
        req.headers.origin &&
        ![
          `http://${expected}`,
          `http://localhost:${server.address().port}`,
        ].includes(req.headers.origin)
      )
        return json(res, { error: "Foreign Origin rejected" }, 403);
      if (
        !["GET", "HEAD"].includes(req.method) &&
        req.headers["x-studio-token"] !== token
      )
        return json(
          res,
          { error: `Invalid ${DISPLAY_NAMES.studio} session. Reload the editor.` },
          403,
        );
      const path = new URL(req.url, `http://${expected}`).pathname;
      if (req.method === "GET" && path === "/api/config")
        return json(res, { csrfToken: token });
      if (req.method === "GET" && path === "/api/projects")
        return json(res, await store.list());
      const match =
        /^\/api\/projects\/([^/]+)(?:\/(timeline|render|transcribe|inspect|subtitles|recover|cut|focus-proposals|transcript-words|transcript-propose|transcript-review|silence-detect|silence-review))?$/.exec(
          path,
        );
      if (match) {
        const [, id, action] = match;
        if (req.method === "GET" && !action)
          return json(res, await store.get(id));
        if(req.method==='POST'&&action==='silence-detect'){
          if(mediaBusy)return json(res,{error:'A media operation is already running.'},409);mediaBusy=true;
          try{const b=await body(req);return json(res,await store.edit(id,b.revision,async p=>({editing:{...p.editing,silence:await detectSilence({projectDir:store.dir(id),...p})}})));}finally{mediaBusy=false;}
        }
        if(req.method==='POST'&&action==='silence-review'){const b=await body(req);await store.verify(id);return json(res,await store.edit(id,b.revision,p=>reviewSilence(p,b)));}
        if(req.method==='GET'&&action==='transcript-words')return json(res,transcriptView(await store.get(id)));
        if(req.method==='POST'&&action==='transcript-propose'){const b=await body(req);return json(res,await store.edit(id,b.revision,p=>proposeTranscript(p,b)));}
        if(req.method==='POST'&&action==='transcript-review'){const b=await body(req);await store.verify(id);return json(res,await store.edit(id,b.revision,p=>reviewTranscript(p,b)));}
        if(req.method==='GET'&&action==='focus-proposals'){const p=await store.get(id);return json(res,{revision:p.studio.revision,proposals:proposeFocusBlocksFromEvents(p.events,{rangeSet:p.timeline.rangeSet})});}
        if (req.method === "PUT" && action === "timeline") {
          const b = await body(req);
          return json(res, await store.save(id, b.revision, b.timeline));
        }
        if(req.method==='POST' && action==='cut'){const b=await body(req);if(b.reviewed!==true)throw Error('Review the source interval before applying.');const p=await store.get(id);return json(res,await store.save(id,b.revision,editInterval(p.timeline,b.action,b.startMs,b.endMs)));}
        if(req.method==='POST' && action==='recover'){const b=await body(req);return json(res,await store.recover(id,b.revision));}
        if(req.method==='POST' && action==='subtitles'){
          const b=await body(req,110000);const p=await store.get(id);
          if(!['srt','vtt'].includes(b.format))throw Error('Choose SRT or VTT.');
          const captions=(b.format==='srt'?parseSrt:parseVtt)(b.text,p.studio.asset.durationMs);
          return json(res,await store.save(id,b.revision,{...p.timeline,captions}));
        }
        if(req.method==='POST' && action==='inspect'){
          if(mediaBusy)return json(res,{error:'A media operation is already running.'},409);
          mediaBusy=true;
          try{const b=await body(req);return json(res,await store.locked(id,async()=>{const p=await store.verify(id);if(p.studio.revision!==b.revision)throw Error('Project changed; reopen before inspection.');return inspectFrame({projectDir:store.dir(id),...p,ratio:b.ratio,timeMs:b.timeMs,reviewCover:b.reviewCover===true});}));}finally{mediaBusy=false;}
        }
        if (req.method === "POST" && action === "transcribe") {
          if (mediaBusy)
            return json(
              res,
              { error: "A media operation is already running." },
              409,
            );
          mediaBusy = true;
          try {
            const b = await body(req);
            const p = await store.verify(id);
            if (b.revision !== p.studio.revision)
              throw Error(
                "Project changed since opening. Reopen before transcribing.",
              );
            const { transcribeProject } = await import("./transcript/index.js");
            const result = await transcribeProject({
              projectDir: store.dir(id),
              ...p,
            });
            if (!result.captions.length)
              throw Error(
                "No speech found. Existing captions were left unchanged.",
              );
            const updated = await store.edit(id,b.revision,p=>({timeline:{...p.timeline,captions:result.captions},editing:{...p.editing,transcript:{raw:result.transcript,revision:p.studio.revision+1}},alignedTranscript:true}));
            await atomicJSON(join(store.dir(id), "transcript.json"), {
              ...result.transcript,
              revision: updated.studio.revision,
            });
            return json(res, updated);
          } finally {
            mediaBusy = false;
          }
        }
        if (req.method === "POST" && action === "render") {
          if (mediaBusy)
            return json(
              res,
              {
                error:
                  "A capture or render is already running. Wait for it to finish.",
              },
              409,
            );
          mediaBusy = true;
          const jobId = randomUUID();
          const job = {
            status: "running",
            progress: "Checking preserved media",
          };
          jobs.set(jobId, job);
          if (jobs.size > 40) jobs.delete(jobs.keys().next().value);
          void store
            .locked(id, async () => {
              const p = await store.verify(id);
              const result = await renderProject({
                projectDir: store.dir(id),
                ...p,
                onProgress: (v) =>
                  (job.progress =
                    typeof v === "string" ? v : JSON.stringify(v)),
              });
              await atomicJSON(join(store.dir(id), "exports", "receipt.json"), {
                ...result,
                revision: p.studio.revision,
              });
              job.result = result;
              job.status = "done";
              job.progress = "Export complete";
            })
            .catch((e) => {
              job.status = "error";
              job.error = e.message;
            })
            .finally(() => {
              mediaBusy = false;
            });
          return json(res, { jobId }, 202);
        }
      }
      const jm = /^\/api\/jobs\/([^/]+)$/.exec(path);
      if (req.method === "GET" && jm) {
        const job = jobs.get(jm[1]);
        return json(res, job || { error: "Job not found" }, job ? 200 : 404);
      }
      if (req.method === "POST" && path === "/api/import") {
        const name = decodeURIComponent(
          req.headers["x-project-name"] || "Untitled demo",
        );
        const filename = decodeURIComponent(
          req.headers["x-filename"] || "recording.mp4",
        );
        const ext = extname(filename).toLowerCase();
        if (![".mp4", ".mov", ".webm", ".mkv"].includes(ext))
          throw Error("Choose an MP4, MOV, WebM or MKV recording.");
        const dir = await fs.mkdtemp(join(store.root, ".upload-"));
        const path = join(dir, "input" + ext);
        try {
          const f = await fs.open(path, "wx", 0o600);
          try {
            let total = 0;
            for await (const c of req) {
              total += c.length;
              if (total > 256 * 1024 * 1024)
                throw Error("Media exceeds the 256 MB import limit");
              await f.write(c);
            }
            await f.sync();
          } finally {
            await f.close();
          }
          return json(res, await store.importMedia(path, { name }), 201);
        } finally {
          await fs.rm(dir, { recursive: true, force: true });
        }
      }
      if (req.method === "POST" && path === "/api/capture") {
        if (mediaBusy)
          return json(
            res,
            { error: "A capture or render is already running." },
            409,
          );
        mediaBusy = true;
        let dir;
        try {
          const b = await body(req);
          if (
            typeof b.name !== "string" ||
            !b.name.trim() ||
            b.name.length > 80
          )
            throw Error("Project name must be 1–80 characters");
          dir = await fs.mkdtemp(join(store.root, ".capture-"));
          const result = await captureFlow({
            url: b.url,
            steps: b.steps,
            outputDir: dir,
          });
          return json(
            res,
            await store.importMedia(result.mediaPath, {
              name: b.name,
              input: { kind: "url", url: b.url },
              events: result.events,
              flow: result.flow,
              timing: result.timing,
              readyFramePath: result.readyFramePath,
            }),
            201,
          );
        } finally {
          mediaBusy = false;
          if (dir) await fs.rm(dir, { recursive: true, force: true });
        }
      }
      const mm = /^\/media\/([^/]+)\/original$/.exec(path);
      if (req.method === "GET" && mm) {
        const p = await store.get(mm[1]);
        return await file(
          req,
          res,
          await safeFile(store.dir(mm[1]), p.studio.asset.path),
        );
      }
      const im=/^\/inspection\/([^/]+)\/(inspection.png|reviewed-cover.png)$/.exec(path);
      if(req.method==='GET'&&im)return file(req,res,await safeFile(store.dir(im[1]),im[2]));
      const em = /^\/exports\/([^/]+)\/([a-zA-Z0-9._-]+)$/.exec(path);
      if (req.method === "GET" && em) {
        store.dir(em[1]);
        return await file(
          req,
          res,
          await safeFile(store.dir(em[1]), "exports/" + em[2]),
        );
      }
      if (req.method === "GET" && path === "/display-names.js")
        return await file(req, res, fileURLToPath(new URL("../../../launcher/src/display-names.js", import.meta.url)));
      if (req.method === "GET" && path === "/") {
        res.writeHead(200, { "Content-Type": types[".html"], "Cache-Control": "no-cache" });
        return res.end(applyDisplayNames(await fs.readFile(join(here, "ui/index.html"), "utf8")));
      }
      const assets = {
        "/app.js": "ui/app.js",
        "/timeline/project.js":"timeline/project.js",
        "/timeline/ranges.js":"timeline/ranges.js",
        "/focus/blocks.js":"focus/blocks.js",
        "/styles.css": "styles/styles.css",
        "/fonts/dm-sans-latin-400-normal.woff2": "../node_modules/@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff2",
        "/fonts/dm-sans-latin-500-normal.woff2": "../node_modules/@fontsource/dm-sans/files/dm-sans-latin-500-normal.woff2",
        "/fonts/dm-sans-latin-600-normal.woff2": "../node_modules/@fontsource/dm-sans/files/dm-sans-latin-600-normal.woff2",
        "/fonts/instrument-serif-latin-400-normal.woff2": "../node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2",
        "/fonts/instrument-serif-latin-400-italic.woff2": "../node_modules/@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2",
      };
      if (req.method === "GET" && assets[path])
        return await file(req, res, join(here, assets[path]));
      json(res, { error: "Not found" }, 404);
    } catch (e) {
      if (!res.headersSent)
        json(res, { error: e.message }, e.code === "ENOENT" ? 404 : 400);
      else res.destroy();
    }
  });
  server.requestTimeout = 180000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, store, url: `http://127.0.0.1:${server.address().port}` };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server, url } = await startServer();
  console.log(`${DISPLAY_NAMES.umbrella} ${DISPLAY_NAMES.studio} → ${url}`);
  for (const s of ["SIGINT", "SIGTERM"])
    process.on(s, () => server.close(() => process.exit(0)));
}
