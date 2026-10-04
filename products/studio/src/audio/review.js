import {createHash} from 'node:crypto';
import {safeFile,sha256} from '../core/store.js';
import {qualifyFFmpeg,runNative} from '../render/native.js';
import {parseSilenceDiagnostics,normalizeCaptionGaps,createSilenceProposals,isStaleSource} from './silence-proposals.js';
import {silenceCandidates} from '../transcript/captions.js';
import {editInterval,retainedDurationMs} from '../timeline/project.js';
export function silenceIdentity(p){return {sourceSha256:p.studio.asset.sha256,sourceDurationMs:p.studio.asset.durationMs,timelineRevision:p.studio.revision,transcriptRevision:p.editing.transcript?.revision??p.studio.revision};}
export async function detectSilence(p){
 const sourceIdentity=silenceIdentity(p),detectorSettings={noiseDb:-35,minimumDurationMs:700},file=await safeFile(p.projectDir,p.studio.asset.path);
 if(await sha256(file)!==sourceIdentity.sourceSha256)throw Error('Original source changed; silence evidence refused.');
 const native=await qualifyFFmpeg();
 const diagnostics=p.studio.asset.hasAudio?(await runNative(native.binary,['-hide_banner','-nostdin','-nostats','-i',file,'-vn','-af',`atrim=end=${sourceIdentity.sourceDurationMs/1000},asetpts=PTS-STARTPTS,silencedetect=noise=-35dB:d=0.7`,'-f','null','-'],{timeoutMs:30000,completeStderr:true})).stderr:'NO_AUDIO';
 const parsed=parseSilenceDiagnostics(diagnostics,{sourceIdentity,detectorSettings,hasAudio:p.studio.asset.hasAudio});
 const gaps=normalizeCaptionGaps(silenceCandidates(p.timeline.captions,sourceIdentity.sourceDurationMs),{sourceIdentity});
 const observations=[...parsed.observations,...gaps];
 return {...parsed,observations,proposals:[...createSilenceProposals(parsed.observations,{sourceIdentity}),...createSilenceProposals(gaps,{sourceIdentity})],diagnosticsSha256:createHash('sha256').update(diagnostics).digest('hex'),diagnostics,ffmpeg:native.version,reviewed:{}};
}
export function reviewSilence(p,b){
 if(b.reviewed!==true||!['KEEP','SHORTEN','REMOVE'].includes(b.action))throw Error('Audition and review a KEEP, SHORTEN or REMOVE decision.');
 const batch=p.editing.silence,sourceIdentity=silenceIdentity(p);
 if(!batch||isStaleSource(batch.sourceIdentity,sourceIdentity))throw Error('Silence evidence is stale; detect again.');
 const observation=batch.observations.find(o=>o.observationId===b.observationId);
 if(!observation)throw Error('Unknown silence observation.');
 const observations=batch.observations.filter(o=>o.evidenceKind===observation.evidenceKind);
 const proposal=createSilenceProposals(observations,{sourceIdentity,suggestedAction:b.action}).find(p=>p.observationId===b.observationId);
 if(proposal.suggestedAction!==b.action)throw Error(`This evidence must KEEP: ${proposal.reason}`);
 let timeline;
 if(b.action!=='KEEP'){
   const pause=proposal.suggestedRetainMs,left=Math.floor(pause/2),right=pause-left;
   timeline=editInterval(p.timeline,'remove',proposal.sourceStartMs+left,proposal.sourceEndMs-right);
   if(retainedDurationMs(timeline.rangeSet)===retainedDurationMs(p.timeline.rangeSet))throw Error('That interval is already removed.');
 }
 const decision={kind:'SILENCE',action:b.action,proposal,reviewedAt:new Date().toISOString(),revision:p.studio.revision};
 return {editing:{...p.editing,silence:{...batch,reviewed:{...batch.reviewed,[b.observationId]:decision}},reviews:[...(p.editing.reviews||[]).slice(-99),decision]},...(timeline?{timeline}:{})};
}
