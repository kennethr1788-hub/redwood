import {createHash} from 'node:crypto';
import {wordsFromTranscript,createTranscriptCutProposal,compareProposalProvenance} from '../transcript/cut-proposals.js';
import {editInterval} from './project.js';
export function transcriptContext(p){
 const saved=p.editing.transcript;
 if(!saved)throw Error('No current aligned transcript. Transcribe source audio locally; SRT/VTT and text corrections are caption-only.');
 return {transcript:saved.raw,sourceSha256:p.studio.asset.sha256,sourceDurationMs:p.studio.asset.durationMs,transcriptRevision:saved.revision,timelineRevision:p.studio.revision,timelineIdentity:createHash('sha256').update(JSON.stringify(p.timeline)).digest('hex')};
}
export function transcriptView(p){
 try{const context=transcriptContext(p);return {words:wordsFromTranscript(context.transcript,context.sourceDurationMs),proposal:p.editing.transcriptProposal||null,stale:p.editing.transcriptProposal?compareProposalProvenance(p.editing.transcriptProposal,context):null,revision:p.studio.revision};}
 catch(e){return {words:[],unavailable:e.message,proposal:p.editing.transcriptProposal||null,stale:{stale:true},revision:p.studio.revision};}
}
export function proposeTranscript(p,b){
 const proposal=createTranscriptCutProposal({...transcriptContext(p),wordRange:{startWordId:b.startWordId,endWordId:b.endWordId},paddingMs:{before:0,after:0}});
 return {editing:{...p.editing,transcriptProposal:proposal}};
}
export function reviewTranscript(p,b){
 if(!['accept','reject'].includes(b.action)||b.reviewed!==true)throw Error('Review the word selection and choose accept or reject.');
 const proposal=p.editing.transcriptProposal;
 if(!proposal||proposal.proposalId!==b.proposalId)throw Error('Proposal changed; reopen review.');
 if(compareProposalProvenance(proposal,transcriptContext(p)).stale)throw Error('Transcript proposal is stale. Select words and propose again.');
 const editing={...p.editing,transcriptProposal:null,reviews:[...(p.editing.reviews||[]).slice(-99),{kind:'TRANSCRIPT',action:b.action,proposal,reviewedAt:new Date().toISOString(),revision:p.studio.revision}]};
 return {editing,...(b.action==='accept'?{timeline:editInterval(p.timeline,'remove',proposal.sourceStartMs,proposal.sourceEndMs)}:{})};
}
