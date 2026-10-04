// Optional native smoke: node tests/render-smoke.mjs. Artifacts are synthetic and ignored.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { qualifyFFmpeg, runNative } from "../src/render/native.js";
import { renderProject } from "../src/render/index.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const projectDir = path.join(root, ".test-output/render-smoke");
await mkdir(path.join(projectDir, "media"), { recursive: true });
const native = await qualifyFFmpeg();
await runNative(native.binary, [
  "-hide_banner",
  "-y",
  "-f",
  "lavfi",
  "-i",
  "testsrc2=size=1280x720:rate=30",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=440:sample_rate=48000",
  "-t",
  "4",
  "-c:v",
  native.encoder,
  ...(native.encoder === "h264_videotoolbox" ? ["-allow_sw", "1"] : []),
  "-b:v",
  "3M",
  "-c:a",
  "aac",
  path.join(projectDir, "media/original.mp4"),
]);
const studio = {
  revision: 1,
  asset: {
    path: "media/original.mp4",
    width: 1280,
    height: 720,
    hasAudio: true,
  },
};
const timeline = {
  trim: { startMs: 300, endMs: 3800 },
  title: "The next chapter of your product.",
  subtitle: "Clarity. Focus. A first impression that stays.",
  theme: "aurora",
  zoom: 1.35,
  focus: { x: 0.65, y: 0.4 },
  cursor: true,
  captions: [
    { startMs: 300, endMs: 2000, text: "A sharper story, in every format." },
    {
      startMs: 2000,
      endMs: 3800,
      text: "Bring the important details into focus.",
    },
  ],
};
const events = [
  { type: "move", timeMs: 0, x: 60, y: 70 },
  { type: "move", timeMs: 900, x: 640, y: 360 },
  { type: "click", timeMs: 1300, x: 740, y: 390 },
  { type: "move", timeMs: 2800, x: 1000, y: 280 },
];
await writeFile(
  path.join(projectDir, "synthetic-inputs.json"),
  JSON.stringify({ studio, timeline, events }, null, 2),
);
const result = await renderProject({
  projectDir,
  studio,
  timeline,
  events,
  onProgress: console.log,
});
const browser = await chromium.launch({ headless: true });
const playback = [];
try {
  const page = await browser.newPage({
    viewport: { width: 1300, height: 800 },
  });
  for (const name of ["landscape", "vertical"]) {
    await page.goto(
      pathToFileURL(path.join(projectDir, "exports", `${name}.mp4`)).href,
    );
    await page.locator("video").waitFor();
    await page.evaluate(async () => {
      const v = document.querySelector("video");
      v.muted = true;
      await v.play();
    });
    await page.waitForFunction(
      () => document.querySelector("video").currentTime > 0.35,
    );
    playback.push(
      await page.evaluate(() => {
        const v = document.querySelector("video");
        v.pause();
        return {
          file: location.pathname,
          duration: v.duration,
          currentTime: v.currentTime,
          width: v.videoWidth,
          height: v.videoHeight,
          error: v.error?.message || null,
        };
      }),
    );
    await runNative(native.binary, [
      "-hide_banner",
      "-y",
      "-ss",
      "1.3",
      "-i",
      path.join(projectDir, "exports", `${name}.mp4`),
      "-frames:v",
      "1",
      "-update",
      "1",
      path.join(projectDir, `${name}-inspected.png`),
    ]);
  }
  await page.goto(
    pathToFileURL(path.join(projectDir, "exports", "index.html")).href,
  );
  await page.screenshot({
    path: path.join(projectDir, "share-inspected.png"),
    fullPage: true,
  });
} finally {
  await browser.close();
}
await writeFile(
  path.join(projectDir, "playback.json"),
  JSON.stringify(playback, null, 2),
);
console.log(JSON.stringify({ projectDir, result, playback }, null, 2));
