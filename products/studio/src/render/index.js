import { DISPLAY_NAMES } from "../../../../launcher/src/display-names.js";
import {resolveFocusAtSourceTime} from '../focus/blocks.js';
import {timelineRanges,retainedDurationMs,outputEvents,outputCaptions} from '../timeline/project.js';
import {
  access,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createVisualAssets } from "./visual.js";
import { cursorExpressions } from "./motion.js";
import { cameraMotion, coverTime } from "./camera.js";
import { qualifyFFmpeg, runNative } from "./native.js";
import { writeShare, writeCaptions } from "../export/share.js";

export async function renderProject({
  projectDir,
  outputRoot = projectDir,
  studio,
  timeline,
  events = [],
  onProgress = () => {},
}) {
  if (!studio?.asset || !timeline?.trim)
    throw new Error(`A valid ${DISPLAY_NAMES.studio} project and timeline are required.`);
  const rangeSet=timelineRanges(timeline,studio.asset.durationMs);
  const duration = retainedDurationMs(rangeSet) / 1000;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 180)
    throw new Error("Render trim must be between 1 ms and 180 seconds.");
  if (!Number.isFinite(timeline.zoom) || timeline.zoom < 1 || timeline.zoom > 2)
    throw new Error("Zoom must be between 1 and 2.");
  if (timeline.captions.length > 40)
    throw new Error("This local render supports up to 40 caption segments.");
  if(outputCaptions(timeline).length>128)throw Error("This local render supports at most 128 caption fragments; simplify cuts or captions.");
  const media = path.resolve(projectDir, studio.asset.path);
  if (!media.startsWith(path.resolve(projectDir) + path.sep))
    throw new Error(`Original media must be inside the ${DISPLAY_NAMES.studio} project.`);
  try {
    await access(media);
  } catch {
    throw new Error(
      "Original media is missing. Re-import the recording before rendering.",
    );
  }
  onProgress("Qualifying native media tools");
  const { binary, encoder, version, licenseProfile, distribution } =
    await qualifyFFmpeg();
  const workDir = await mkdtemp(path.join(outputRoot, ".render-"));
  const outputDir = path.join(workDir, "exports");
  await mkdir(outputDir);
  let publicationComplete=false;
  try {
    onProgress("Composing premium frames and captions");
    const { variants, cursor, ring } = await createVisualAssets(
      workDir,
      timeline,
      studio,
    );
    for (const variant of variants) {
      const { name, layout, shell, captions, closing } = variant;
      const { width, height, videoWidth: vw, videoHeight: vh, x, y } = layout;
      onProgress(`Rendering ${name} film`);
      const camera = await cameraMotion(layout, studio.asset, timeline);
      const zoompan = camera.expressions("on/30");
      const view = camera.expressions("t");
      const projectX = (sourceX) => `((${sourceX})+${camera.offsetX}-(${view.x}))*${vw}*(${view.zoom})/${camera.canvasWidth}`;
      const projectY = (sourceY) => `((${sourceY})+${camera.offsetY}-(${view.y}))*${vh}*(${view.zoom})/${camera.canvasHeight}`;
      const cursorPath = await cursorExpressions(events, studio, timeline, camera.sourceWidth, camera.sourceHeight, layout.vertical?"9:16":"16:9");
      const args = [
        "-hide_banner",
        "-y",
        "-nostdin",
        "-i",
        media,
        "-loop",
        "1",
        "-framerate",
        "30",
        "-i",
        shell,
      ];
      const clicks = outputEvents(timeline,events).filter(e=>{
        const policy=resolveFocusAtSourceTime(timeline.focusBlocks||[],e.sourceTimeMs,{sourceDurationMs:rangeSet.sourceDurationMs,ratio:layout.vertical?'9:16':'16:9'})?.cursorPolicy||'preserve';
        return e.type==='click'&&Number.isFinite(e.x)&&Number.isFinite(e.y)&&policy!=='off'&&(policy!=='preserve'||timeline.cursor);
      }).slice(0,40);
      let nextIndex = 2,
        cursorIndex = null,
        ringIndex = null;
      if (cursorPath) {
        cursorIndex = nextIndex++;
        args.push("-loop", "1", "-framerate", "30", "-i", cursor);
      }
      if (clicks.length) {
        ringIndex = nextIndex++;
        args.push("-loop", "1", "-framerate", "30", "-i", ring);
      }
      for (const caption of captions) {
        caption.index = nextIndex++;
        args.push("-loop", "1", "-framerate", "30", "-i", caption.file);
      }
      const closingIndex = nextIndex++;
      args.push("-loop", "1", "-framerate", "30", "-i", closing);
      const graph = [];
      const ranges=rangeSet.ranges,n=ranges.length;
      if(n>1){
        graph.push(`[0:v]split=${n}${ranges.map((_,i)=>`[vs${i}]`).join('')}`);
        if(studio.asset.hasAudio)graph.push(`[0:a]asplit=${n}${ranges.map((_,i)=>`[as${i}]`).join('')}`);
      }
      for(const [i,r] of ranges.entries()){
        graph.push(`[${n>1?'vs'+i:'0:v'}]trim=start=${r.startMs/1000}:end=${r.endMs/1000},setpts=PTS-STARTPTS[vt${i}]`);
        if(studio.asset.hasAudio)graph.push(`[${n>1?'as'+i:'0:a'}]atrim=start=${r.startMs/1000}:end=${r.endMs/1000},asetpts=PTS-STARTPTS[at${i}]`);
      }
      graph.push(`${ranges.map((_,i)=>`[vt${i}]${studio.asset.hasAudio?'[at'+i+']':''}`).join('')}concat=n=${n}:v=1:a=${studio.asset.hasAudio?1:0}[retained]${studio.asset.hasAudio?'[joinedAudio]':''}`);
      if(studio.asset.hasAudio)graph.push('[joinedAudio]apad[audio]');
      graph.push(
        `[retained]fps=30,scale=${camera.sourceWidth}:${camera.sourceHeight}:flags=lanczos,setsar=1,pad=${camera.canvasWidth}:${camera.canvasHeight}:${camera.offsetX}:${camera.offsetY},zoompan=z='${zoompan.zoom}':x='${zoompan.x}':y='${zoompan.y}':d=1:s=${vw}x${vh}:fps=30[source]`,
      );
      let source = "source";
      for (const [i, event] of clicks.entries()) {
        const start = event.timeMs / 1000;
        const ringX = projectX((event.x / studio.asset.width) * camera.sourceWidth) + "-36",
          ringY = projectY((event.y / studio.asset.height) * camera.sourceHeight) + "-36";
        graph.push(
          `[${ringIndex}:v]crop=72:72:x='72*min(7,max(0,floor((t-${start})*8/.45)))':y=0[ring${i}]`,
        );
        graph.push(
          `[${source}][ring${i}]overlay=x='${ringX}':y='${ringY}':enable='gte(t,${start})*lt(t,${event.endMs/1000})':shortest=1[pulse${i}]`,
        );
        source = `pulse${i}`;
      }
      if (cursorPath) {
        graph.push(
          `[${source}][${cursorIndex}:v]overlay=x='${projectX(`(${cursorPath.x})+5`)}-5':y='${projectY(`(${cursorPath.y})+4`)}-4':enable='${cursorPath.enable || `gte(t,${cursorPath.start})`}':shortest=1[cursorvideo]`,
        );
        source = "cursorvideo";
      }
      graph.push(`[${source}]pad=${width}:${height}:${x}:${y}:black[base]`);
      graph.push("[base][1:v]overlay=0:0:shortest=1[framed]");
      let previous = "framed";
      for (const [index, caption] of captions.entries()) {
        const label = `caption${index}`;
        graph.push(
          `[${previous}][${caption.index}:v]overlay=0:0:enable='gte(t,${caption.start})*lt(t,${caption.end})':shortest=1[${label}]`,
        );
        previous = label;
      }
      const closingStart = Math.max(0, duration - 1.2);
      if (duration >= 4) {
        graph.push(`[${closingIndex}:v]format=rgba,fade=t=in:st=${closingStart}:d=0.4:alpha=1[closing]`);
        graph.push(`[${previous}][closing]overlay=0:0:shortest=1[finished]`);
        previous = "finished";
      }
      graph.push(`[${previous}]format=yuv420p[video]`);
      const filterPath=path.join(workDir,`${name}-filter.txt`);await writeFile(filterPath,graph.join(";"));
      args.push(
        "-filter_complex_threads",
        "2",
        "-filter_complex_script",
        filterPath,
        "-map",
        "[video]",
      );
      if (studio.asset.hasAudio)
        args.push(
          "-map",
          "[audio]",
          "-c:a",
          "aac",
          "-b:a",
          "160k",
        );
      args.push("-t", String(duration), "-r", "30", "-c:v", encoder);
      if (encoder === "h264_videotoolbox") args.push("-allow_sw", "1");
      args.push(
        "-b:v",
        layout.vertical ? "5M" : "6M",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-metadata",
        "comment=LaunchForge Studio; native FFmpeg local execution; Motion Canvas timing",
        path.join(outputDir, `${name}.mp4`),
      );
      await runNative(binary, args, {
        timeoutMs: Math.max(180000, duration * 12000),
      });
    }
    onProgress("Creating cover image and animated preview");
    const landscape = path.join(outputDir, "landscape.mp4");
    for (const name of ["landscape", "vertical"]) {
      await runNative(binary, [
        "-hide_banner", "-y", "-nostdin",
        ...(timeline.coverTimeMs==null
          ? ["-ss",String(coverTime(duration)),"-i",path.join(outputDir,`${name}.mp4`)]
          : ["-i",path.join(outputDir,`${name}.mp4`),"-vf",`select=eq(n\\,${Math.floor(timeline.coverTimeMs*30/1000)})`]),
        "-frames:v", "1", "-update", "1",
        path.join(outputDir, name === "landscape" ? "thumbnail.png" : "vertical-thumbnail.png"),
      ]);
    }
    await runNative(binary, [
      "-hide_banner",
      "-y",
      "-nostdin",
      "-i",
      landscape,
      "-t",
      String(Math.min(duration, 8)),
      "-filter_complex",
      "fps=15,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle",
      "-loop",
      "0",
      path.join(outputDir, "demo.gif"),
    ]);
    await writeShare(outputDir, timeline.title, timeline.subtitle);
    await writeCaptions(outputDir, timeline);
    const files = [
      { name: "landscape.mp4", kind: "landscape", width: 1280, height: 720 },
      { name: "vertical.mp4", kind: "vertical", width: 720, height: 1280 },
      { name: "thumbnail.png", kind: "thumbnail", width: 1280, height: 720 },
      { name: "demo.gif", kind: "gif", width: 480, height: 270 },
      { name: "index.html", kind: "share" },
      { name: "portrait.html", kind: "share" },
      { name: "vertical-thumbnail.png", kind: "thumbnail", width: 720, height: 1280 },
      { name: "captions.vtt", kind: "captions" },
      { name: "captions.srt", kind: "captions" },
    ];
    const {inspectionIdentity}=await import("./inspection.js");
    const {sha256}=await import("../core/store.js");
    for(const file of files)file.sha256=await sha256(path.join(outputDir,file.name));
    const result = {
      binding:await inspectionIdentity({projectDir,studio,timeline,events}),
      files,
      renderedAt: new Date().toISOString(),
      revision: studio.revision,
      durationMs: Math.round(duration * 1000),
      engine: {
        motion: "@motion-canvas/core easing and interpolation",
        compositor: "native FFmpeg with browser Canvas2D frame assets",
        encoder,
        ffmpeg: version,
        licenseProfile,
        distribution,
      },
      composition: {
        version: "unified-r2",
        rangeSet,
        framing: timeline.framing||{landscape:"cover",vertical:"cover"},
        framingSemantics: "Cover uses eased saved focus; fit preserves the entire recording with centered letterboxing and no focus zoom.",
        layouts: variants.map(({ name, layout }) => ({ name, ...layout })),
        thumbnailTimeSeconds: timeline.coverTimeMs==null?coverTime(duration):Math.floor(timeline.coverTimeMs*30/1000)/30,
        gifFps: 15,
        preview: "Static share player uses the exact exported MP4; editor preview remains approximate",
      },
      limitations: [
        "Focus blocks use reviewed source-time targets, not automatic subject tracking; cover can crop surrounding content.",
        "Cursor smoothing uses captured interaction samples only; original recorded pointers cannot be removed.",
        "Local static share folder has no hosted collaboration or analytics.",
      ],
    };
    await writeFile(
      path.join(outputDir, "render.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    // Publish only complete renders. Keep the previous output intact on failure.
    const exportsDir = path.join(outputRoot, "exports"),
      backupDir = path.join(workDir, "previous-exports");
    let oldMoved = false;
    try {
      await rename(exportsDir, backupDir);
      oldMoved = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(outputDir, exportsDir);
    } catch (error) {
      if (oldMoved) await rename(backupDir, exportsDir);
      throw error;
    }
    publicationComplete=true;
    onProgress("Export complete");
    return result;
  } finally {
    // A failed rollback can leave the only prior exports in this staging folder.
    // On ambiguous I/O errors preserve it for explicit local recovery as well.
    let backupMayExist=false;
    try{await access(path.join(workDir,'previous-exports'));backupMayExist=true;}catch(error){if(error.code!=='ENOENT')backupMayExist=true;}
    if(publicationComplete||!backupMayExist)await rm(workDir, { recursive: true, force: true });
  }
}
