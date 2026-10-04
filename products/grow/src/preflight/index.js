import {hash,json,readContained} from '../export/index.js';
import {CONCEPTS} from '../creative/index.js';
import {SOCIAL_SIZES} from '../render/layout.js';
import {inputTracking} from '../intake/index.js';

// Local compositor policy only. No current platform specification is inferred.
export const LOCAL_RULE={id:'grow-r4-compositor-1',reviewedAt:'2026-10-03',kind:'LOCAL_RENDERER_RULE',geometry:'1080 square, 1080x1350 portrait, 1080x1920 story',readability:'Measured font ink, 4.5:1 text contrast and non-overlap',safeZone:'Local conservative margins, not a platform overlay guarantee'};
export function validateSelection(input,p){
 if(!input||Object.keys(input).some(k=>!['concept','ratios','trackedUrl','altText','reviewed'].includes(k))||!CONCEPTS.includes(input.concept)||!p.campaign?.variants.some(v=>v.concept===input.concept))throw new Error('Choose an existing concept');
 if(!Array.isArray(input.ratios)||!input.ratios.length||input.ratios.length>3||new Set(input.ratios).size!==input.ratios.length||input.ratios.some(r=>!SOCIAL_SIZES.some(s=>s.name===r)))throw new Error('Choose one or more supported ratios');
 if(typeof input.altText!=='string'||!input.altText.trim()||input.altText.length>700||typeof input.trackedUrl!=='string'||input.trackedUrl.length>2048)throw new Error('Review the selected asset description and tracked URL');
 return {concept:input.concept,ratios:[...input.ratios].sort(),trackedUrl:input.trackedUrl,altText:input.altText,reviewed:input.reviewed===true};
}
export function expectedTracking(p,concept){return p.campaign?.inputRevision?inputTracking(p,concept):p.growthPlan?.utm.find(row=>row.concept===concept)?.destination||p.campaign?.url;}
export function preflightBinding(p){return hash(json({campaign:p.campaign,render:p.render?.files.map(f=>({name:f.name,sha256:f.sha256})),inputRevision:p.productPack?.revision,review:p.productPack?.review,plan:p.growthPlan?.revision,selection:p.selection}));}
export async function preflight(p){
 const s=p.selection;if(!s)throw new Error('Choose a concept and ratios first');
 const blockers=[],notes=[];const variantIndex=p.campaign.variants.findIndex(v=>v.concept===s.concept),variant=p.campaign.variants[variantIndex];
 if(!p.campaign.confirmed||p.campaign.stale||p.render?.stale)blockers.push('Creative or render is stale/unreviewed. Review and render current inputs.');
 if(p.campaign.inputRevision&&p.productPack?.review?.revision!==p.campaign.inputRevision)blockers.push('Product/Brand review does not match the campaign input revision.');
 if(!s.reviewed)blockers.push('Review selected copy, accessibility description, unknown platform requirements and silent-motion use.');
 if(p.campaign.inputRevision){if(variant.cta!==p.productPack.cta.label)blockers.push(`CTA mismatch: selected “${variant.cta}”; reviewed inputs “${p.productPack.cta.label}”.`);if(p.campaign.url!==p.productPack.cta.destination)blockers.push(`Destination mismatch: ${p.campaign.url} != ${p.productPack.cta.destination}`);}
 if(!p.campaign.inputRevision&&p.growthPlan){const planned=p.growthPlan.creative.angles.find(a=>a.concept===s.concept);if(planned?.cta&&variant.cta!==planned.cta)blockers.push(`CTA mismatch: selected “${variant.cta}”; saved growth plan “${planned.cta}”.`);}
 const expected=expectedTracking(p,s.concept);if(s.trackedUrl!==expected)blockers.push(`Destination/UTM mismatch: expected ${expected}; selected ${s.trackedUrl}`);
 let quality=null,renderVerified=false;
 if(p.render?.status!=='RENDERED')blockers.push('Render the reviewed campaign first.');
 else {
  try{for(const f of p.render.files){const bytes=await readContained(p.render.outputDir,f.name);if(hash(bytes)!==f.sha256)throw new Error(`Rendered bytes changed: ${f.name}`);if(f.name==='quality.json')quality=JSON.parse(bytes);}renderVerified=true;}catch(e){blockers.push(e.message);}
 }
 const ratios=s.ratios.map(ratio=>{
  const size=SOCIAL_SIZES.find(s=>s.name===ratio),asset=p.render?.files.find(f=>f.type==='image'&&f.variant===variantIndex+1&&f.width===size.width&&f.height===size.height),check=quality?.checks.find(c=>c.name===asset?.name.replace(/\.png$/,''));

  return {ratio,width:size.width,height:size.height,status:'REVIEW',geometry:asset&&renderVerified?'READY':'UNKNOWN',readability:renderVerified&&check?.status==='PASS'?'READY':'UNKNOWN',platformRule:'UNKNOWN',platformNote:'No current official placement/safe-zone profile is qualified. Review on the target platform.',localRule:LOCAL_RULE.id,asset:asset?{name:asset.name,relativePath:asset.relativePath,sha256:asset.sha256}:null,copy:{...variant,url:s.trackedUrl},altText:s.altText};
 });
 if(ratios.some(r=>!r.asset||r.readability!=='READY'))blockers.push('Selected geometry/readability is not backed by a current render.');
 const motion=p.render?.files.find(f=>f.type==='video');
 notes.push('Geometry/readability READY refers only to the local renderer; platform approval and performance remain UNKNOWN.');
 if(motion?.audio===false)notes.push(`Silent ${motion.duration}-second motion. Review audio and intended placement before use; no platform approval claimed.`);
 if(variantIndex!==0)notes.push('Existing motion uses the first concept (spotlight). It remains in source assets but is excluded from this selected-concept handoff.');
 return {version:1,status:'REVIEW',binding:preflightBinding(p),stale:false,selection:s,ratios,blockers,notes,localRule:LOCAL_RULE,platformRules:{status:'UNKNOWN',reason:'No current official rule admitted; no platform PASS is possible.'},motion:{name:motion?.name||null,concept:p.campaign.variants[0]?.concept,duration:motion?.duration??null,audio:motion?.audio??null,selected:variantIndex===0},localExportReady:blockers.length===0,publication:'NOT_PUBLISHED'};
}
