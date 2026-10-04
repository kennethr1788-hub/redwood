import {createHash} from 'node:crypto';
import {createCampaignSnapshot,createCampaignObservation,compareCampaign} from './compare.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const definitions={paidSpendCents:{unit:'cents',meaning:'Reported paid spend in the declared currency',allowNegative:false},revenueCents:{unit:'cents',meaning:'Reported attributed revenue in the declared currency',allowNegative:false},impressions:{unit:'count',meaning:'Reported impressions',allowNegative:false},clicks:{unit:'count',meaning:'Reported clicks',allowNegative:false},conversions:{unit:'count',meaning:'Reported attributed conversions; may be fractional',allowNegative:false}};
export const metricDefinitions=Object.fromEntries(Object.entries(definitions).map(([key,def])=>[key,{...def,sourceKey:key}]));
function state(p){return p.learning??{campaignId:p.id,snapshots:[],observations:[],proposalReviews:[]};}
export function reportingWindow(start,end,timezone='UTC'){
 if(timezone!=='UTC')throw Error('Learning requires an explicitly normalized UTC report. Other reporting zones are not automatically converted.');
 for(const d of [start,end])if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||new Date(d).toISOString().slice(0,10)!==d)throw Error('Invalid reporting date.');
 return {start:start+'T00:00:00.000Z',end:new Date(Date.parse(end)+86400000).toISOString(),timezone};
}
function cohort(input,account,geography){
 const result={id:input?.id,source:input?.source,account,report:input?.report,attribution:input?.attribution,filters:input?.filters,geography};
 for(const [key,value] of Object.entries(result))if(typeof value!=='string'||!value.trim()||/^(unknown|not supplied|not provided|unspecified|n\/a)$/i.test(value.trim()))throw Error(`Provide explicit known reporting context for ${key}; unknown cohorts cannot be compared.`);
 return result;
}
export function freezePlan(p,b){
 if(b.reviewed!==true||!p.growthPlan)throw Error('Save and review the current R5 plan before freezing a baseline.');
 const learning=state(p);if(learning.snapshots.length>=50)throw Error('Snapshot history limit reached. Use another workspace.');
 const creativeRevisions=p.campaign&&!p.campaign.stale?Object.fromEntries(p.campaign.variants.map(v=>[`${p.id}:${v.concept}`,hash({campaign:p.campaign,variant:v})])):{};
 const snapshot=createCampaignSnapshot(p.growthPlan,{campaignId:learning.campaignId,window:reportingWindow(b.start,b.end),cohort:cohort(b.cohort,b.account,b.geography),metricDefinitions,creativeRevisions});
 if(learning.snapshots.some(s=>s.snapshotId===snapshot.snapshotId))throw Error('This exact baseline is already frozen.');
 p.learning={...learning,snapshots:[...learning.snapshots,snapshot]};return p;
}
function money(metric,currency){
 if(metric?.status!=='PRESENT')return null;
 if(metric.currency!==currency)throw Error('Imported money needs the same explicit currency as the historical plan.');
 const s=metric.value;if(!/^\d+(?:\.\d{1,2})?$/.test(s))throw Error('Money must be a nonnegative exact decimal with at most two fractional digits.');
 let n;
 if(metric.unit==='cents'){if(s.includes('.'))throw Error('Cents must be integral.');n=BigInt(s);}
 else if(metric.unit==='currency'){const [a,b='']=s.split('.');n=BigInt(a)*100n+BigInt(b.padEnd(2,'0'));}
 else throw Error('Declare imported money units as cents or currency.');
 if(n>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Imported money exceeds safe cents.');return Number(n);
}
export function observeResults(p,b){
 const learning=state(p),snapshot=learning.snapshots.find(s=>s.snapshotId===b.snapshotId),entry=p.evidenceImports?.find(e=>e.id===b.importId),row=entry?.normalized.rows.find(r=>r.rowId===b.rowId);
 if(!snapshot||!row||b.reviewed!==true)throw Error('Review a historical baseline and an exact imported source row.');
 if(learning.observations.length>=1000)throw Error('Observation limit reached.');
 const imported=entry.normalized,actual={};
 for(const key of Object.keys(metricDefinitions)){const metric=row.metrics[key];if(metric?.status==='INVALID')throw Error(`Invalid imported ${key}; correct the source import.`);if(key.endsWith('Cents'))actual[key]=money(metric,imported.currency);else{if(metric?.status==='PRESENT'&&metric.unit!=='count')throw Error(`Declare ${key} as count.`);actual[key]=metric?.status==='PRESENT'?metric.value:null;}}
 const observationId=hash({snapshotId:snapshot.snapshotId,sourceHash:imported.sourceFileSha256,row:row.provenance.sourceRow});
 if(learning.observations.some(o=>o.observationId===observationId))throw Error('This source row is already admitted for this snapshot.');
 const observation=createCampaignObservation({observationId,campaignId:learning.campaignId,planRevision:snapshot.planRevision,sourceImportIds:[entry.id],sourceRowId:row.rowId,sourceFileSha256:imported.sourceFileSha256,sourceMetrics:row.metrics,coverage:b.coverage,grain:'CAMPAIGN',currency:imported.currency??null,window:reportingWindow(imported.observedWindow.start,imported.observedWindow.end,imported.observedWindow.timezone),cohort:cohort(imported.cohort,imported.accountScope,imported.geography),planned:snapshot.planned,actual,metricDefinitions,caveats:['User-selected campaign-total row; membership and coverage are supplied assertions.',...imported.warnings.map(w=>w.code)]});
 p.learning={...learning,observations:[...learning.observations,observation],comparison:null};return p;
}
export function compareResults(p,b){
 const learning=state(p),snapshot=learning.snapshots.find(s=>s.snapshotId===b.snapshotId);
 if(!snapshot||!Array.isArray(b.observationIds)||!b.observationIds.length||new Set(b.observationIds).size!==b.observationIds.length)throw Error('Choose one baseline and explicit observations.');
 const observations=b.observationIds.map(id=>{const o=learning.observations.find(o=>o.observationId===id);if(!o)throw Error('Unknown observation.');return o;});
 const result=compareCampaign(snapshot,observations,b.adjustment?{adjustment:b.adjustment}:{});
 p.learning={...learning,comparison:result};return p;
}
export function reviewAdjustment(p,b){
 const learning=state(p),previous=learning.comparison,proposal=previous?.proposedAdjustment;
 if(b.reviewed!==true||!proposal||b.proposalId!==proposal.proposalId)throw Error('Review the exact displayed allocation proposal.');
 const snapshot=learning.snapshots.find(s=>s.snapshotId===proposal.snapshotId),observations=learning.observations.filter(o=>proposal.sourceObservationIds.includes(o.observationId));
 const fresh=compareCampaign(snapshot,observations,{adjustment:{...proposal.remainingAllocation,explanation:proposal.explanation}});
 if(fresh.proposedAdjustment?.proposalId!==proposal.proposalId)throw Error('Proposal evidence changed. Compare again.');
 const review={proposalId:proposal.proposalId,snapshotId:proposal.snapshotId,reviewedAt:new Date().toISOString(),status:'REVIEWED_PROPOSAL_ONLY',execution:'NONE',proposal};
 p.learning={...learning,proposalReviews:[...learning.proposalReviews.filter(r=>r.proposalId!==proposal.proposalId),review].slice(-100)};return p;
}
export function researchExport(p){return {schemaVersion:1,truth:'EXPORTED != PUBLISHED; PLANNED != ACTUAL; imported observations are not independently verified.',currentPlanningContext:p.growthPlan||null,evidenceImports:(p.evidenceImports||[]).map(e=>({id:e.id,normalized:e.normalized,conflicts:e.conflicts})),topicMap:p.topicMap||null,learning:p.learning||null};}
