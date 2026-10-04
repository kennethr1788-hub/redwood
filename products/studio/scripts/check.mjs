import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
async function walk(dir) {
  const files = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = dir + "/" + d.name;
    if (d.isDirectory()) files.push(...(await walk(p)));
    else if (/\.(js|mjs)$/.test(p)) files.push(p);
  }
  return files;
}
for (const file of [
  ...(await walk("src")),
  ...(await walk("tests")),
  ...(await walk("scripts")),
]) {
  const r = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (r.status) {
    console.error(r.stderr);
    process.exit(r.status);
  }
}
console.log("All Studio JavaScript parses.");
