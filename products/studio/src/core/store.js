import { DISPLAY_NAMES } from "../../../../launcher/src/display-names.js";
import { promises as fs, createReadStream } from "node:fs";
import { resolve, join, extname, dirname } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Studio, Event, validateTimeline, defaultTimeline } from "./schema.js";
import { probe } from "./media.js";
import {reconcileTrim} from '../timeline/project.js';
export const defaultRoot = fileURLToPath(
  new URL("../../.studio/projects/", import.meta.url),
);
export async function atomicJSON(path, value) {
  const tmp = path + "." + randomUUID() + ".tmp";
  const f = await fs.open(tmp, "wx", 0o600);
  try {
    await f.writeFile(JSON.stringify(value, null, 2) + "\n");
    await f.sync();
  } finally {
    await f.close();
  }
  await fs.rename(tmp, path);
  const d = await fs.open(dirname(path), "r");
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
export async function sha256(path) {
  const h = createHash("sha256");
  for await (const c of createReadStream(path)) h.update(c);
  return h.digest("hex");
}
export async function safeFile(root, relative) {
  const base = await fs.realpath(root);
  const target = await fs.realpath(join(base, relative));
  if (!target.startsWith(base + "/"))
    throw Error("Project path escapes its root");
  const s = await fs.stat(target);
  if (!s.isFile()) throw Error("Expected regular file");
  return target;
}
export class Store {
  constructor(root = defaultRoot) {
    this.root = resolve(root);
    this.locks = new Set();
  }
  dir(id) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        id,
      )
    )
      throw Error("Invalid project ID");
    return join(this.root, id);
  }
  async init() {
    await fs.mkdir(this.root, { recursive: true });
  }
  async locked(id, fn) {
    if (this.locks.has(id))
      throw Error("Project is busy. Try again after the current operation.");
    const dir = this.dir(id);
    const lock = join(dir, ".write.lock");
    let handle;
    try {
      handle = await fs.open(lock, "wx", 0o600);
    } catch (e) {
      if (e.code === "EEXIST")
        throw Error(
          `Project is busy in another ${DISPLAY_NAMES.studio} operation. If a previous process crashed, follow README recovery.`,
        );
      throw e;
    }
    this.locks.add(id);
    try {
      await handle.writeFile(String(process.pid));
      return await fn();
    } finally {
      await handle.close();
      await fs.unlink(lock);
      this.locks.delete(id);
    }
  }
  async importMedia(
    path,
    {
      name = "Untitled demo",
      input = { kind: "import" },
      events = [],
      flow,
      timing,
      readyFramePath,
    } = {},
  ) {
    await this.init();
    const ext = extname(path).toLowerCase();
    if (![".mp4", ".mov", ".webm", ".mkv"].includes(ext))
      throw Error("Choose an MP4, MOV, WebM or MKV recording.");
    const st = await fs.lstat(path);
    if (!st.isFile() || st.size > 256 * 1024 * 1024)
      throw Error("Import must be a regular video file under 256 MB.");
    const id = randomUUID(),
      dir = this.dir(id),
      temp = join(this.root, ".import-" + id);
    await fs.mkdir(join(temp, "media"), { recursive: true });
    try {
      const relative = "media/original" + ext,
        media = join(temp, relative);
      await fs.copyFile(path, media);
      const meta = await probe(media);
      const studio = Studio.parse({
        schemaVersion: 1,
        id,
        name,
        createdAt: new Date().toISOString(),
        asset: { path: relative, sha256: await sha256(media), ...meta },
        input,
        revision: 0,
      });
      const timeline = defaultTimeline(studio);
      if (
        timing?.contentStartMs &&
        timing.contentStartMs < studio.asset.durationMs - 500
      )
        timeline.trim.startMs = Math.round(timing.contentStartMs);
      const firstClick = events.find((e) => e.type === "click");
      if (firstClick) {
        timeline.focus = {
          x: Math.max(0, Math.min(1, firstClick.x / meta.width)),
          y: Math.max(0, Math.min(1, firstClick.y / meta.height)),
        };
      }
      const bounded = events.slice(0, 10000).map((e) => Event.parse(e));
      await atomicJSON(join(temp, "state.json"), { studio, timeline });
      await atomicJSON(join(temp, "studio.json"), studio);
      await atomicJSON(join(temp, "timeline.json"), timeline);
      await fs.writeFile(
        join(temp, "events.ndjson"),
        bounded.map((e) => JSON.stringify(e) + "\n").join(""),
      );
      if (flow) await atomicJSON(join(temp, "flow.json"), flow);
      if (timing) await atomicJSON(join(temp, "capture-timing.json"), timing);
      if (readyFramePath)
        await fs.copyFile(readyFramePath, join(temp, "capture-ready.png"));
      await fs.rename(temp, dir);
      return this.get(id);
    } catch (e) {
      await fs.rm(temp, { recursive: true, force: true });
      throw e;
    }
  }
  async get(id) {
    const dir = this.dir(id);
    const statePath = await safeFile(this.root, id + "/state.json");
    const saved=JSON.parse(await fs.readFile(statePath,"utf8"));
    const {studio:raw,timeline:t}=saved;
    const studio = Studio.parse(raw);
    if (studio.id !== id) throw Error("Project identity mismatch");
    const timeline = validateTimeline(t, studio);
    await safeFile(dir, studio.asset.path);
    const ep = await safeFile(dir, "events.ndjson");
    const text = await fs.readFile(ep, "utf8");
    if (text.length > 2e6) throw Error("Event track too large");
    const events = text.trim()
      ? text
          .trim()
          .split("\n")
          .map((l) => Event.parse(JSON.parse(l)))
      : [];
    let exports = [];
    try {
      const r = JSON.parse(
        await fs.readFile(await safeFile(dir, "exports/receipt.json"), "utf8"),
      );
      exports = r.files || [];
      let stale=r.revision !== studio.revision;
      try {
        const {inspectionIdentity}=await import('../render/inspection.js');
        stale ||= r.binding?.identity !== (await inspectionIdentity({projectDir:dir,studio,timeline,events})).identity;
        for(const f of exports)if(!f.sha256 || await sha256(await safeFile(dir,'exports/'+f.name))!==f.sha256)stale=true;
      }catch{stale=true;}
      if(stale)exports=exports.map(f=>({...f,stale:true}));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    let inspection=null,recoveryAvailable=false;
    try{const r=JSON.parse(await fs.readFile(join(dir,'inspection.json'),'utf8'));const {inspectionIdentity}=await import('../render/inspection.js');inspection={...r,stale:r.identity!==(await inspectionIdentity({projectDir:dir,studio,timeline,events})).identity};}catch(e){if(e.code!=='ENOENT')inspection={stale:true,error:'Inspection could not be verified; inspect again.'};}
    let coverReview=null;
    try{const r=JSON.parse(await fs.readFile(join(dir,'cover-review.json'),'utf8'));const {inspectionIdentity}=await import('../render/inspection.js');coverReview={...r,stale:r.identity!==(await inspectionIdentity({projectDir:dir,studio,timeline,events})).identity};}catch(e){if(e.code!=='ENOENT')coverReview={stale:true};}
    recoveryAvailable=!!saved.previousTimeline;
    return { studio, timeline, events, exports, inspection, coverReview, recoveryAvailable, editing:saved.editing||{reviews:[]} };
  }
  async list() {
    await this.init();
    const files = await fs.readdir(this.root);
    const list = [];
    for (const id of files) {
      if (id.startsWith(".")) continue;
      try {
        const { studio } = await this.get(id);
        list.push({
          id,
          name: studio.name,
          createdAt: studio.createdAt,
          revision: studio.revision,
        });
      } catch {
        /* Invalid projects do not prevent listing healthy projects. */
      }
    }
    return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async save(id,revision,value){return this.edit(id,revision,()=>({timeline:value}));}
  async edit(id, revision, build) {
    return this.locked(id, async () => {
      const p=await this.get(id),dir=this.dir(id);
      if(p.studio.revision!==revision)throw Error('Project changed since opening. Reopen before saving.');
      const previous=JSON.parse(await fs.readFile(await safeFile(dir,'state.json'),'utf8'));
      const patch=await build(p),changed=patch.timeline!==undefined;
      const timeline=changed?validateTimeline(reconcileTrim(patch.timeline,p.timeline,p.studio.asset.durationMs),p.studio):p.timeline;
      const studio={...p.studio,revision:revision+(changed?1:0)};
      const editing=structuredClone(patch.editing??p.editing);
      if(JSON.stringify(timeline.captions)!==JSON.stringify(p.timeline.captions)&&!patch.alignedTranscript)delete editing.transcript;
      await atomicJSON(join(dir,'state.json'),{studio,timeline,editing,previousTimeline:changed?p.timeline:previous.previousTimeline});
      await atomicJSON(join(dir,'studio.json'),studio);await atomicJSON(join(dir,'timeline.json'),timeline);
      return this.get(id);
    });
  }
  async recover(id,revision) {
    return this.locked(id,async()=>{
      const p=await this.get(id),dir=this.dir(id);
      if(p.studio.revision!==revision)throw Error('Project changed since opening. Reopen before recovering.');
      const state=JSON.parse(await fs.readFile(await safeFile(dir,'state.json'),'utf8'));
      if(!state.previousTimeline)throw Error('No presentation checkpoint yet.');
      const timeline=validateTimeline(state.previousTimeline,p.studio),studio={...p.studio,revision:revision+1};
      const editing=structuredClone(p.editing);if(JSON.stringify(timeline.captions)!==JSON.stringify(p.timeline.captions))delete editing.transcript;
      await atomicJSON(join(dir,'state.json'),{studio,timeline,previousTimeline:p.timeline,editing});
      await atomicJSON(join(dir,'studio.json'),studio);await atomicJSON(join(dir,'timeline.json'),timeline);
      return this.get(id);
    });
  }
  async verify(id) {
    const p = await this.get(id);
    const actual = await sha256(
      await safeFile(this.dir(id), p.studio.asset.path),
    );
    if (actual !== p.studio.asset.sha256)
      throw Error(
        "Original media changed: restore the preserved source before rendering.",
      );
    return p;
  }
}
