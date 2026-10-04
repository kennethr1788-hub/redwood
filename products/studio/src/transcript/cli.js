#!/usr/bin/env node
// Transcript-only commands; saved timeline captions are the editable authority.
import { readFile } from "node:fs/promises";
import { Store } from "../core/store.js";
import { parseSrt, parseVtt, serializeSrt, serializeVtt } from "./srt.js";
import { silenceCandidates } from "./captions.js";

const [command, id, format, filename, revision] = process.argv.slice(2);
try {
  if (!["export", "import", "gaps"].includes(command) || !id ||
      (command !== "gaps" && !["srt", "vtt"].includes(format)) ||
      (command === "import" && (!filename || !/^\d+$/.test(revision || ""))))
    throw Error("Usage: node src/transcript/cli.js export <id> srt|vtt | import <id> srt|vtt <file> <base-revision> | gaps <id>");
  const store = new Store(process.env.STUDIO_PROJECTS_DIR);
  const p = await store.get(id);
  const durationMs = p.studio.asset.durationMs;
  if (command === "export") {
    process.stdout.write((format === "srt" ? serializeSrt : serializeVtt)(p.timeline.captions, { trim: p.timeline.trim, durationMs }));
  } else if (command === "import") {
    const captions = (format === "srt" ? parseSrt : parseVtt)(await readFile(filename, "utf8"), durationMs);
    const saved = await store.save(id, Number(revision), { ...p.timeline, captions });
    console.log(JSON.stringify(saved, null, 2));
  } else {
    console.log(JSON.stringify({ reviewRequired: true, candidates: silenceCandidates(p.timeline.captions, durationMs) }, null, 2));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
