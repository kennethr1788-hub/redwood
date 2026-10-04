import {resolveFocusAtSourceTime} from '../focus/blocks.js';
import {retainedDurationMs,timelineRanges,outputToSourceMs,sourceToOutputMs} from '../timeline/project.js';
import { motionTiming, piecewiseExpression } from "./motion.js";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

// A virtual canvas with the OUTPUT aspect ratio prevents zoompan from stretching
// a wide recording into portrait. Cover zoom excludes all of the padded pixels.
export function cameraGeometry(layout, asset) {
  const canvasWidth = layout.videoWidth * 2;
  const canvasHeight = layout.videoHeight * 2;
  const scale = Math.min(canvasWidth / asset.width, canvasHeight / asset.height);
  const sourceWidth = Math.max(2, Math.floor(asset.width * scale / 2) * 2);
  const sourceHeight = Math.max(2, Math.floor(asset.height * scale / 2) * 2);
  return {
    canvasWidth, canvasHeight, sourceWidth, sourceHeight,
    cover: Math.max(canvasWidth / sourceWidth, canvasHeight / sourceHeight),
  };
}

export async function cameraMotion(layout, asset, timeline) {
  const geometry = cameraGeometry(layout, asset);
  const fit=timeline.framing?.[layout.vertical?"vertical":"landscape"]==="fit";
  geometry.offsetX=fit?Math.floor((geometry.canvasWidth-geometry.sourceWidth)/4)*2:0;
  geometry.offsetY=fit?Math.floor((geometry.canvasHeight-geometry.sourceHeight)/4)*2:0;
  const { easeInOutCubic } = await motionTiming();
  const duration = retainedDurationMs(timelineRanges(timeline)) / 1000;
  const ramp = Math.min(1.6, duration * 0.3);
  // Short clips remain one uninterrupted move. Longer clips gently breathe out.
  const release = duration >= 4 ? Math.min(1.1, duration * 0.18) : 0;
  const ranges=timelineRanges(timeline);
  const blocks=timeline.focusBlocks||[];
  const ratio=layout.vertical?"9:16":"16:9";
  const sample = (time) => {
    if(fit)return {zoom:1,x:0,y:0,cropWidth:geometry.canvasWidth,cropHeight:geometry.canvasHeight};
    const sourceMs=outputToSourceMs(ranges,Math.max(0,Math.min(retainedDurationMs(ranges)-1,Math.floor(time*1000))));
    const block=blocks.length?resolveFocusAtSourceTime(blocks,sourceMs,{sourceDurationMs:ranges.sourceDurationMs,ratio}):null;
    const focus=blocks.length?(block?.target||{x:.5,y:.5}):timeline.focus;
    const savedZoom=blocks.length?(block?.zoom||1):timeline.zoom;
    const phase=block?clamp((sourceMs-block.sourceStartMs)/Math.min(600,(block.sourceEndMs-block.sourceStartMs)*.3),0,1):clamp(time/ramp,0,1);
    const enter = block?.easing==='linear'?phase:easeInOutCubic(phase);
    const leave = !blocks.length && release ? easeInOutCubic(clamp((time - duration + release) / release, 0, 1)) : 0;
    const strength = enter * (1 - leave * 0.65);
    const zoom = geometry.cover * (1 + (savedZoom - 1) * strength);
    // Small, deliberate pan to the SAVED focus, never a guessed vision target.
    const fx = focus.x + (0.5 - focus.x) * 0.12 * (1 - enter);
    const fy = focus.y + (0.5 - focus.y) * 0.12 * (1 - enter);
    const cropWidth = geometry.canvasWidth / zoom;
    const cropHeight = geometry.canvasHeight / zoom;
    return {
      zoom,
      x: clamp(geometry.sourceWidth * fx - cropWidth / 2, 0, Math.max(0, geometry.sourceWidth - cropWidth)),
      y: clamp(geometry.sourceHeight * fy - cropHeight / 2, 0, Math.max(0, geometry.sourceHeight - cropHeight)),
      cropWidth, cropHeight,
    };
  };
  const times = new Set([0, duration]);
  for (let i = 0; i <= 32; i++) {
    times.add(ramp * i / 32);
    if (release) times.add(duration - release + release * i / 32);
  }
  if(blocks.length){
    const add=t=>{if(t>=0&&t<=duration){times.add(t);if(t>0)times.add(Math.max(0,t-.000001));}};
    for(const r of ranges.ranges)add(sourceToOutputMs(ranges,r.startMs)/1000);
    for(const block of blocks){
      for(let i=0;i<=16;i++){
        const ms=Math.round(block.sourceStartMs+Math.min(600,(block.sourceEndMs-block.sourceStartMs)*.3)*i/16);
        const out=sourceToOutputMs(ranges,ms);if(out!==null)add(out/1000);
      }
      const out=sourceToOutputMs(ranges,block.sourceEndMs);if(out!==null)add(out/1000);
    }
  }
  const frames = [...times].sort((a, b) => a - b).map(t => [t, sample(t)]);
  const expressions = (variable) => Object.fromEntries(["zoom", "x", "y"].map(key => [
    key, piecewiseExpression(frames.map(([t, value]) => [+t.toFixed(6), +value[key].toFixed(6)]), variable),
  ]));
  return { ...geometry, sample, expressions };
}

export function coverTime(duration) {
  // Avoid the establishing move and the closing treatment in short previews.
  return Math.min(duration * 0.5, Math.max(1.7, duration * 0.35));
}
