import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  symlink,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store, atomicJSON, safeFile } from "../src/core/store.js";
import { validateTimeline, defaultTimeline } from "../src/core/schema.js";
const studio = {
  schemaVersion: 1,
  id: randomUUID(),
  name: "Synthetic",
  createdAt: new Date().toISOString(),
  asset: {
    path: "media/original.mp4",
    sha256: "0".repeat(64),
    width: 1280,
    height: 800,
    durationMs: 5000,
    hasAudio: false,
  },
  input: { kind: "import" },
  revision: 0,
};
test("timeline rejects lost source ranges, unknown code, invalid focus and captions", () => {
  const t = defaultTimeline(studio);
  assert.equal(validateTimeline(t, studio).zoom, 1.15);
  for (const invalid of [
    { ...t, trim: { startMs: 4000, endMs: 3000 } },
    { ...t, trim: { startMs: 0, endMs: 6000 } },
    { ...t, code: "execute()" },
    { ...t, focus: { x: 2, y: 0.5 } },
    { ...t, captions: [{ startMs: 1, endMs: 0, text: "Bad" }] },
  ])
    assert.throws(() => validateTimeline(invalid, studio));
});
test("atomic save reopens and rejects stale revision; missing originals fail clearly", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-store-"));
  const store = new Store(root);
  try {
    const dir = store.dir(studio.id);
    await mkdir(join(dir, "media"), { recursive: true });
    await writeFile(join(dir, studio.asset.path), "test bytes");
    await writeFile(join(dir, "events.ndjson"), "");
    const t = defaultTimeline(studio);
    await atomicJSON(join(dir, "state.json"), { studio, timeline: t });
    const next = await store.save(studio.id, 0, {
      ...t,
      title: "Saved title",
      zoom: 1.7,
    });
    assert.equal(next.studio.revision, 1);
    assert.equal(
      (await new Store(root).get(studio.id)).timeline.title,
      "Saved title",
    );
    await assert.rejects(store.save(studio.id, 0, t), /changed since opening/);
    assert.equal(
      JSON.parse(await readFile(join(dir, "timeline.json"))).zoom,
      1.7,
    );
    await assert.rejects(store.verify(studio.id), /Original media changed/);
    await rm(join(dir, studio.asset.path));
    await assert.rejects(store.get(studio.id), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("project ID and symlink traversal cannot escape project files", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-path-"));
  try {
    await mkdir(join(root, "project"));
    await writeFile(join(root, "outside"), "private");
    await symlink(join(root, "outside"), join(root, "project", "escape"));
    await assert.rejects(safeFile(join(root, "project"), "escape"), /escapes/);
    assert.throws(() => new Store(root).dir("../escape"), /Invalid project/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("invalid imported bytes and missing source are clear failures, never projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-invalid-"));
  const store = new Store(join(root, "projects"));
  try {
    await writeFile(join(root, "broken.mp4"), "this is not media");
    await assert.rejects(
      store.importMedia(join(root, "broken.mp4")),
      /Invalid or unreadable media/,
    );
    assert.deepEqual(await store.list(), []);
    await assert.rejects(
      store.importMedia(join(root, "missing.mp4")),
      /ENOENT/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("separate Store instances cannot concurrently mutate one project", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-lock-"));
  const a = new Store(root),
    b = new Store(root);
  try {
    await mkdir(a.dir(studio.id));
    await a.locked(studio.id, async () => {
      await assert.rejects(
        b.locked(studio.id, async () => {}),
        /busy in another/,
      );
    });
    await b.locked(studio.id, async () => {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
