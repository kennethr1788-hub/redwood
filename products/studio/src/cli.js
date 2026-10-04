#!/usr/bin/env node
import { DISPLAY_NAMES } from "../../../launcher/src/display-names.js";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Store, atomicJSON } from "./core/store.js";
import { Timeline, Studio } from "./core/schema.js";
import { captureFlow } from "./capture/index.js";
import { renderProject } from "./render/index.js";
const [command, ...args] = process.argv.slice(2);
const store = new Store(process.env.STUDIO_PROJECTS_DIR);
try {
  let result;
  if (command === "list") result = await store.list();
  else if (command === "import") {
    if (!args[0])
      throw Error("Usage: studio import <recording> [project name]");
    result = await store.importMedia(args[0], {
      name: args[1] || "Untitled demo",
    });
  } else if (command === "inspect") result = await store.get(args[0]);
  else if (command === "validate")
    result = { valid: true, ...(await store.verify(args[0])) };
  else if (command === "apply") {
    const p = await store.get(args[0]);
    result = await store.save(
      args[0],
      Number(args[2]),
      JSON.parse(await readFile(args[1], "utf8")),
    );
  } else if (command === "capture") {
    const flow = JSON.parse(await readFile(args[0], "utf8"));
    await store.init();
    const dir = await mkdtemp(join(store.root, ".capture-"));
    try {
      const c = await captureFlow({
        url: flow.url,
        steps: flow.steps,
        outputDir: dir,
      });
      result = await store.importMedia(c.mediaPath, {
        name: flow.name || "Web demo",
        input: { kind: "url", url: flow.url },
        events: c.events,
        flow: c.flow,
        timing: c.timing,
        readyFramePath: c.readyFramePath,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } else if (command === "captions") {
    const { parseSrt } = await import("./transcript/srt.js");
    const p = await store.get(args[0]);
    result = await store.save(args[0], Number(args[2]), {
      ...p.timeline,
      captions: parseSrt(await readFile(args[1], "utf8")),
    });
  } else if (command === "transcribe") {
    const p = await store.verify(args[0]);
    const { transcribeProject } = await import("./transcript/index.js");
    const t = await transcribeProject({ projectDir: store.dir(args[0]), ...p });
    if (!t.captions.length)
      throw Error("No speech found. Existing captions were left unchanged.");
    result = await store.save(args[0], Number(args[1]), {
      ...p.timeline,
      captions: t.captions,
    });
    await atomicJSON(join(store.dir(args[0]), "transcript.json"), {
      ...t.transcript,
      revision: result.studio.revision,
    });
  } else if (command === "render") {
    result = await store.locked(args[0], async () => {
      const p = await store.verify(args[0]);
      const r = await renderProject({
        projectDir: store.dir(args[0]),
        ...p,
        onProgress: (v) => console.error(v),
      });
      await atomicJSON(join(store.dir(args[0]), "exports", "receipt.json"), {
        ...r,
        revision: p.studio.revision,
      });
      return r;
    });
  } else if (command === "schema") {
    const { z } = await import("zod");
    result = {
      studio: z.toJSONSchema(Studio),
      timeline: z.toJSONSchema(Timeline),
    };
  } else
    throw Error(
      "Commands: list | import <media> [name] | capture <flow.json> | inspect <id> | validate <id> | apply <id> <timeline.json> <base-revision> | captions <id> <file.srt> <base-revision> | transcribe <id> <base-revision> | render <id> | schema",
    );
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(`${DISPLAY_NAMES.studio}: ` + e.message);
  process.exitCode = 1;
}
