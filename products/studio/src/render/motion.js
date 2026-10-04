import {resolveFocusAtSourceTime} from '../focus/blocks.js';
import {timelineRanges,mapSourceIntervalToOutput} from '../timeline/project.js';
import { build } from "esbuild";

let timing;
/** Use upstream Motion Canvas easing, bundled because its ESM uses extensionless imports. */
export async function motionTiming() {
  timing ??= build({
    stdin: {
      contents:
        "export {easeInOutCubic} from '@motion-canvas/core/lib/tweening/timingFunctions.js'",
      resolveDir: new URL("../../", import.meta.url).pathname,
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  }).then(
    async (result) =>
      import(
        `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
      ),
  );
  return timing;
}

export function piecewiseExpression(points, variable = "t") {
  if (!points.length) return "0";
  let value = String(points[0][1]);
  for (let i = 0; i < points.length - 1; i++) {
    const [t0, v0] = points[i],
      [t1, v1] = points[i + 1];
    if (t1 <= t0 || v0 === v1) continue;
    value += `+(${v1 - v0})*clip((${variable}-${t0})/${t1 - t0},0,1)`;
  }
  return value;
}

export async function zoomExpression(zoom, durationSeconds) {
  const { easeInOutCubic } = await motionTiming();
  const ramp = Math.min(1.4, Math.max(0.25, durationSeconds * 0.35));
  return piecewiseExpression(
    Array.from({ length: 17 }, (_, i) => [
      Number(((i * ramp) / 16).toFixed(4)),
      Number((1 + (zoom - 1) * easeInOutCubic(i / 16)).toFixed(6)),
    ]),
    "on/30",
  );
}

export async function cursorExpressions(
  events,
  studio,
  timeline,
  width,
  height,
  ratio="16:9",
) {
  if(timeline.rangeSet){
    const ranges=timelineRanges(timeline),segments=[];
    for(const retained of ranges.ranges){
      const boundaries=[retained.startMs,retained.endMs,...(timeline.focusBlocks||[]).filter(b=>b.enabled).flatMap(b=>[b.sourceStartMs,b.sourceEndMs]).filter(t=>t>retained.startMs&&t<retained.endMs)].sort((a,b)=>a-b);
      for(let i=1;i<boundaries.length;i++){
        const range={startMs:boundaries[i-1],endMs:boundaries[i]};if(range.endMs<=range.startMs)continue;
        const focus=resolveFocusAtSourceTime(timeline.focusBlocks||[],range.startMs,{sourceDurationMs:ranges.sourceDurationMs,ratio});
        const policy=focus?.cursorPolicy||'preserve';
        if(policy==='off'||(policy==='preserve'&&timeline.cursor===false))continue;
        const selected=events.filter(e=>e.timeMs>=retained.startMs&&e.timeMs<range.endMs);
        const local=await cursorExpressions(selected,studio,{...timeline,rangeSet:undefined,trim:range,rawCursor:policy==='raw'},width,height);
        if(!local)continue;
        const mapped=mapSourceIntervalToOutput(ranges,range.startMs,range.endMs)[0];
        const offset=mapped.outputStartMs/1000;
        segments.push({local,offset,start:offset+local.start,end:mapped.outputEndMs/1000});
      }
    }
    if(!segments.length)return null;
    const gate=s=>`gte(t,${s.start})*lt(t,${s.end})`;
    return {start:segments[0].start,enable:segments.map(gate).join('+'),...Object.fromEntries(['x','y'].map(key=>[key,segments.map(s=>`(${s.local[key].replace(/\bt\b/g,`(t-${s.offset})`)})*(${gate(s)})`).join('+')]))};
  }
  const { easeInOutCubic } = await motionTiming();
  const ordered = events
    .filter(
      (e) =>
        ["move", "click"].includes(e.type) &&
        Number.isFinite(e.timeMs) &&
        Number.isFinite(e.x) &&
        Number.isFinite(e.y),
    )
    .sort((a, b) => a.timeMs - b.timeMs);
  // Trim before bounding telemetry so discarded clicks cannot evict visible
  // events. At duplicate timestamps the latest event wins.
  const byTime = new Map(ordered.map(e => [e.timeMs, e]));
  const unique = [...byTime.values()];
  const prior = unique.findLast(e => e.timeMs <= timeline.trim.startMs);
  const positions = [
    ...(prior ? [{ ...prior, timeMs: timeline.trim.startMs }] : []),
    ...unique.filter(e => e.timeMs > timeline.trim.startMs && e.timeMs <= timeline.trim.endMs),
  ];
  if (!positions.length) return null;
  const stride = Math.max(1, Math.ceil(positions.length / 45));
  const clicks = new Set(positions.filter(e => e.type === "click").slice(0, 40));
  const keyframes = positions
    .filter((e, i) => i % stride === 0 || i === positions.length - 1 || clicks.has(e))
    .map(e => [
      (e.timeMs - timeline.trim.startMs) / 1000,
      (e.x / studio.asset.width) * width,
      (e.y / studio.asset.height) * height,
    ]);
  const points = [keyframes[0]];
  for (let i = 1; i < keyframes.length; i++) {
    const previous = keyframes[i - 1],
      current = keyframes[i];
    if (current[0] <= previous[0]) continue;
    // Dense capture samples are already eased; avoid stop/start at each sample.
    const steps = !timeline.rawCursor && current[0] - previous[0] > 0.15 ? 12 : 1;
    for (let j = 1; j <= steps; j++) {
      const k = steps === 1 ? 1 : easeInOutCubic(j / steps);
      points.push([
        previous[0] + ((current[0] - previous[0]) * j) / steps,
        previous[1] + (current[1] - previous[1]) * k,
        previous[2] + (current[2] - previous[2]) * k,
      ]);
    }
  }
  return {
    start: Math.max(0, keyframes[0][0]),
    x: piecewiseExpression(
      points.map((p) => [
        +p[0].toFixed(4),
        +(Math.max(0, Math.min(width, p[1])) - 5).toFixed(2),
      ]),
    ),
    y: piecewiseExpression(
      points.map((p) => [
        +p[0].toFixed(4),
        +(Math.max(0, Math.min(height, p[2])) - 4).toFixed(2),
      ]),
    ),
  };
}
