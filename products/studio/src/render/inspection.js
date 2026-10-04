import {retainedDurationMs,timelineRanges} from '../timeline/project.js';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {renderProject} from './index.js';
import {qualifyFFmpeg,runNative} from './native.js';
import {sha256,atomicJSON,safeFile} from '../core/store.js';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function inspectionIdentity({projectDir,studio,timeline,events=[]}) {
 const sourceHash=await sha256(await safeFile(projectDir,studio.asset.path));
 if(sourceHash!==studio.asset.sha256)throw Error('Original media changed; inspection refused.');
 const sources=await Promise.all(['index.js','visual.js','camera.js','motion.js','native.js','../timeline/ranges.js','../timeline/project.js','../focus/blocks.js','../core/schema.js','../transcript/srt.js','../export/share.js'].map(async f=>[f,hash(await fs.readFile(new URL(f,import.meta.url),'utf8'))]));
 const native=await qualifyFFmpeg();
 const renderer={sources,ffmpeg:native.version,encoder:native.encoder};
 const settingsHash=hash({timeline,events});
 const identity=hash({revision:studio.revision,sourceHash,settingsHash,renderer});
 return {identity,revision:studio.revision,sourceHash,settingsHash,renderer};
}
export async function inspectFrame({projectDir,studio,timeline,events=[],ratio,timeMs,reviewCover=false}) {
 if(!['landscape','vertical'].includes(ratio))throw Error('Choose landscape or vertical.');
 const duration=retainedDurationMs(timelineRanges(timeline));
 if(!Number.isInteger(timeMs)||timeMs<0||timeMs>=duration)throw Error('Inspection time must be within the output duration.');
 const binding=await inspectionIdentity({projectDir,studio,timeline,events});
 const cache=path.join(projectDir,'.inspection-cache');let cached;
 try{cached=JSON.parse(await fs.readFile(path.join(cache,'binding.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(cached?.identity!==binding.identity){
  await fs.rm(cache,{recursive:true,force:true});await fs.mkdir(cache);
  // The exact final-film renderer, including camera, captions and closing card.
  // Isolated output root prevents changing the actual export receipt/files.
  await renderProject({projectDir,outputRoot:cache,studio,timeline,events});
  await atomicJSON(path.join(cache,'binding.json'),binding);
 }
 const {binary}=await qualifyFFmpeg();
 const filename=reviewCover?'reviewed-cover.png':'inspection.png';
 const selectedTimeMs=Math.floor(timeMs*30/1000)*1000/30;
 await runNative(binary,['-hide_banner','-y','-nostdin','-i',path.join(cache,'exports',ratio+'.mp4'),'-vf',`select=eq(n\\,${Math.floor(timeMs*30/1000)})`,'-frames:v','1','-update','1',path.join(projectDir,filename)]);
 const frameHash=await sha256(path.join(projectDir,filename));
 const result={...binding,ratio,timeMs,selectedTimeMs,frameHash,filename,reviewedCover:reviewCover,inspectedAt:new Date().toISOString(),status:reviewCover?'COVER_REVIEWED':'INSPECTED_FRAME',truth:'INSPECTED_FRAME != FINAL_VIDEO; safe-zone guides are local review overlays, not platform approval.'};
 await atomicJSON(path.join(projectDir,reviewCover?'cover-review.json':'inspection.json'),result);
 return result;
}
