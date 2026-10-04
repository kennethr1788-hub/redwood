import { DISPLAY_NAMES } from "../../../../launcher/src/display-names.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { serializeSrt, serializeVtt } from "../transcript/srt.js";
export const escapeHTML = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export async function writeShare(outputDir, title, subtitle) {
  for (const portrait of [false, true]) {
    const orientation = portrait ? "vertical" : "landscape";
    await writeFile(path.join(outputDir, portrait ? "portrait.html" : "index.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(title)} · ${escapeHTML(DISPLAY_NAMES.umbrella)} ${escapeHTML(DISPLAY_NAMES.studio)}</title>
<style>
*{box-sizing:border-box}body{margin:0;color:#f5f2ff;background:radial-gradient(ellipse at top,#34285a,#111018 65%);font:16px system-ui;padding:48px 6vw;min-height:100vh}main{max-width:1120px;margin:auto}.brand{font-size:11px;letter-spacing:.18em;color:#bba8f5;text-transform:uppercase}h1{font-size:clamp(32px,5vw,64px);letter-spacing:-.04em;margin:24px 0 12px;overflow-wrap:anywhere}p{color:#beb6cc;font-size:18px;line-height:1.6;overflow-wrap:anywhere}.player{display:flex;justify-content:center;margin:28px 0}video{display:block;width:100%;max-height:80vh;aspect-ratio:16/9;border:1px solid #81729344;border-radius:18px;box-shadow:0 30px 100px #0008;background:#100e1a}video.portrait{aspect-ratio:9/16;width:auto;max-width:100%}nav{display:flex;flex-wrap:wrap;gap:10px}a{color:#e7ddff;text-decoration:none;padding:11px 16px;border:1px solid #81729366;border-radius:99px;font-size:14px}a[aria-current]{background:#d7c3ff;color:#201333;border-color:transparent}a:hover{border-color:#d7c3ff}a:focus-visible{outline:3px solid #e4d5ff;outline-offset:4px}.note,footer{font-size:12px;color:#a99cb9}footer{margin-top:32px;line-height:1.8}@media(max-width:600px){body{padding:32px 5vw}h1{font-size:36px}video{border-radius:10px}}
</style></head><body><main>
<div class="brand">${escapeHTML(DISPLAY_NAMES.umbrella)} ${escapeHTML(DISPLAY_NAMES.studio)} / product story</div><h1>${escapeHTML(title)}</h1><p>${escapeHTML(subtitle)}</p>
<nav aria-label="Preview format"><a href="index.html"${portrait ? "" : ' aria-current="page"'}>Landscape · 16:9</a><a href="portrait.html"${portrait ? ' aria-current="page"' : ""}>Portrait · 9:16</a></nav>
<div class="player"><video class="${portrait ? "portrait" : "landscape"}" aria-label="${orientation} product film" controls playsinline preload="metadata" poster="${portrait ? "vertical-thumbnail.png" : "thumbnail.png"}" src="${orientation}.mp4"></video></div>
<p class="note">You are previewing the final exported film. Captions are included in the picture.</p>
<nav aria-label="Download exports"><a href="landscape.mp4" download>Landscape film</a><a href="vertical.mp4" download>Portrait film</a><a href="${portrait ? "vertical-thumbnail.png" : "thumbnail.png"}" download>Cover image</a><a href="demo.gif" download>Animated preview</a><a href="captions.vtt" download>Captions · VTT</a><a href="captions.srt" download>Captions · SRT</a></nav>
<footer>Copy this entire folder to share the films and previews together.<br>A local, portable demo. No analytics. No hosted account required.</footer>
</main></body></html>`);
  }
}

export async function writeCaptions(outputDir, timeline) {
  const options = { trim: timeline.trim, rangeSet: timeline.rangeSet };
  await writeFile(path.join(outputDir, "captions.vtt"), serializeVtt(timeline.captions, options));
  await writeFile(path.join(outputDir, "captions.srt"), serializeSrt(timeline.captions, options));
}
