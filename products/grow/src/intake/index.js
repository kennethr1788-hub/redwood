import path from 'node:path';
import {lstat, mkdir, rename, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {hash, json, safePath, readBounded, durableWrite} from '../export/index.js';
import {httpUrl, trackingUrl} from '../planner/index.js';
import {CONCEPTS} from '../creative/index.js';

const MAX_ASSET=10*1024*1024, MAX_TOTAL=25*1024*1024;
function object(v,keys,label){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new Error(`Invalid ${label} fields`);return v;}
function text(v,max=500,required=false){if(typeof v!=='string'||v.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)||(required&&!v.trim()))throw new Error('Invalid or oversized pack text');return v;}
function list(v,max){if(!Array.isArray(v)||v.length>max)throw new Error('Invalid or oversized pack list');return v;}
export function validatePack(input){
 object(input,['version','identity','claims','cta','brand','article','rightsNotes','assets','revision','reviewHistory'],'pack');
 if(input.version!==1)throw new Error('Unsupported Product/Brand Pack version');
 const identity=object(input.identity,['name','audience','geography','language'],'identity');
 for(const key of ['name','audience','geography','language'])text(identity[key],key==='name'?64:300,true);
 const claims=list(input.claims,30).map(c=>{object(c,['id','text','status','provenance'],'claim');text(c.id,64,true);text(c.text,240,true);text(c.provenance,1000);if(!['USER_SUPPLIED','SOURCE_BACKED','UNSUPPORTED'].includes(c.status))throw new Error('Invalid claim status');if(c.status==='SOURCE_BACKED'&&!c.provenance.trim())throw new Error('Source-backed claim needs provenance');return {...c};});
 if(new Set(claims.map(c=>c.id)).size!==claims.length)throw new Error('Duplicate claim ID');
 object(input.cta,['label','destination','utm'],'CTA');text(input.cta.label,32,true);const destination=httpUrl(input.cta.destination);if(!destination)throw new Error('A destination is required');
 object(input.cta.utm,['source','medium','campaign'],'UTM');for(const v of Object.values(input.cta.utm))text(v,120,true);for(const key of ['source','medium','campaign'])text(input.cta.utm[key],120,true);
 object(input.brand,['color','style'],'brand');if(!/^#[0-9a-f]{6}$/i.test(input.brand.color))throw new Error('Invalid brand color');text(input.brand.style,500);
 text(input.article,50000);text(input.rightsNotes,2000);
 let total=0;const seen=new Set();const assets=list(input.assets,8).map(a=>{
  object(a,['path','sha256','bytes','mime','width','height','duration','altText','rights','provenance'],'asset');safePath(a.path);
  if(!/^assets\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)$/.test(a.path)||seen.has(a.path.toLowerCase()))throw new Error('Invalid or duplicate relative asset path');seen.add(a.path.toLowerCase());
  if(!/^[a-f0-9]{64}$/.test(a.sha256)||!Number.isSafeInteger(a.bytes)||a.bytes<1||a.bytes>MAX_ASSET)throw new Error('Invalid asset hash/size');total+=a.bytes;
  if(!['image/png','image/jpeg','image/webp'].includes(a.mime)||!Number.isInteger(a.width)||!Number.isInteger(a.height)||a.width<1||a.height<1||a.width*a.height>16000000||a.duration!==null)throw new Error('Only bounded still-image assets are supported; duration must be null');
  text(a.altText,500,true);text(a.rights,1000,true);text(a.provenance,1000);return {...a};
 });
 if(total>MAX_TOTAL)throw new Error('Pack assets exceed 25 MB');
 const reviewHistory=list(input.reviewHistory||[],10).map(h=>{object(h,['revision','at','note'],'review history');text(h.revision,64);text(h.at,80);text(h.note,300);return {...h};});
 const pack={version:1,identity:{...identity},claims,cta:{label:input.cta.label,destination,utm:{...input.cta.utm}},brand:{...input.brand},article:input.article,rightsNotes:input.rightsNotes,assets};
 const revision=hash(json(pack));if(input.revision!==undefined&&input.revision!==revision)throw new Error('Pack revision mismatch');return {...pack,revision,reviewHistory};
}
// Reject every symlink component, including links which happen to remain inside the root.
export async function readLocal(file,max=MAX_ASSET){
 const absolute=path.resolve(file);let cursor=path.parse(absolute).root;
 for(const part of absolute.slice(cursor.length).split(path.sep)){cursor=path.join(cursor,part);if((await lstat(cursor)).isSymbolicLink())throw new Error('Symlinks are not accepted in portable pack paths');}
 return readBounded(absolute,max);
}
async function inspect(bytes){const m=await sharp(bytes,{limitInputPixels:16000000,animated:false}).metadata();if(!['png','jpeg','webp'].includes(m.format)||(m.pages||1)>1)throw new Error('Use a single PNG/JPEG/WebP image');return {sha256:hash(bytes),bytes:bytes.length,mime:`image/${m.format}`,width:m.width,height:m.height,duration:null};}
async function checkedAsset(root,a){const bytes=await readLocal(path.join(root,a.path));const meta=await inspect(bytes);for(const key of Object.keys(meta))if(meta[key]!==a[key])throw new Error(`Asset ${key} mismatch: ${a.path}`);return bytes;}
export async function loadPack(file){
 const input=JSON.parse((await readLocal(file,128*1024)).toString());const pack=validatePack(input),bytes=new Map();
 for(const a of pack.assets)bytes.set(a.path,await checkedAsset(path.dirname(file),a));return {pack,bytes};
}
export async function directPack(input){
 object(input,['identity','claims','cta','brand','article','rightsNotes','localAssets'],'direct input');const bytes=new Map(),assets=[];
 for(const [index,a] of list(input.localAssets||[],8).entries()){
  object(a,['file','altText','rights','provenance'],'local asset');text(a.file,2048,true);const data=await readLocal(a.file),meta=await inspect(data);const rel=`assets/asset-${index+1}.${meta.mime==='image/jpeg'?'jpg':meta.mime.split('/')[1]}`;
  assets.push({path:rel,...meta,altText:a.altText,rights:a.rights,provenance:a.provenance||''});bytes.set(rel,data);
 }
 return {pack:validatePack({version:1,identity:input.identity,claims:input.claims,cta:input.cta,brand:input.brand,article:input.article||'',rightsNotes:input.rightsNotes||'',assets}),bytes};
}
export function invalidateInputs(p){if(p.productPack){p.productPack.review=null;p.productPack.status='STALE';}if(p.campaign){p.campaign.stale=true;p.campaign.confirmed=false;}if(p.render)p.render.stale=true;if(p.preflight){p.preflight.stale=true;p.preflight.status='REVIEW';p.preflight.localExportReady=false;}p.exports=(p.exports||[]).map(e=>({...e,stale:true}));}
export async function installPack(p,dir,{pack,bytes},imported=false){
 const relative=`inputs/${randomUUID()}`,target=path.join(dir,relative);await mkdir(target,{recursive:true});
 try{for(const [name,data] of bytes)await durableWrite(path.join(target,name),data);await durableWrite(path.join(target,'product-brand-pack.json'),json(pack));}catch(e){await rm(target,{recursive:true,force:true});throw e;}
 invalidateInputs(p);
 p.inputHistory=[...(p.inputHistory||[]),...(p.productPack?[{revision:p.productPack.revision,root:p.productPack.root,review:p.productPack.review}]:[])].slice(-20);
 p.productPack={...pack,root:relative,review:null,status:'REVIEW',imported,notice:imported?'Imported review history is provenance only. Review this exact revision here.':'User supplied inputs require local review.'};
 p.article=pack.article;p.content={status:'USER_INPUT_DRAFT_REQUIRES_REVIEW',faq:[],suggestions:[],schemaNote:'No facts independently verified.'};
 await durableWrite(path.join(dir,'content','article.md'),pack.article);
}
export async function verifyPackAssets(p,dir){const pack=p.productPack;if(!pack)throw new Error('Save product inputs first');for(const a of pack.assets)await checkedAsset(path.join(dir,pack.root),a);return pack;}
export async function reviewPack(p,dir,revision){const pack=await verifyPackAssets(p,dir);if(revision!==pack.revision)throw new Error('Inputs changed. Review the current revision.');pack.review={revision,at:new Date().toISOString(),scope:'LOCAL_OPERATOR_REVIEW_NOT_INDEPENDENT_FACT_VERIFICATION'};pack.status='REVIEWED_FOR_THIS_REVISION';}
export async function exportPack(p,dir){
 const pack=await verifyPackAssets(p,dir),relative=`portable-packs/${randomUUID()}`,target=path.join(dir,relative),staging=target+'.building';
 const portable=validatePack(Object.fromEntries(['version','identity','claims','cta','brand','article','rightsNotes','assets','revision','reviewHistory'].map(k=>[k,pack[k]])));
 if(pack.review)portable.reviewHistory=[...portable.reviewHistory,{revision:pack.revision,at:pack.review.at,note:'Asserted local review; receiving project must review again.'}].slice(-10);
 await mkdir(staging,{recursive:true});try{for(const a of pack.assets)await durableWrite(path.join(staging,a.path),await checkedAsset(path.join(dir,pack.root),a));await durableWrite(path.join(staging,'product-brand-pack.json'),json(portable));await rename(staging,target);}catch(e){await rm(staging,{recursive:true,force:true});throw e;}
 p.packExport={path:path.join(target,'product-brand-pack.json'),relativePath:`${relative}/product-brand-pack.json`,revision:pack.revision,files:['product-brand-pack.json',...pack.assets.map(a=>a.path)].map(name=>({name,relativePath:`${relative}/${name}`})),notice:'Copy this folder with its relative assets. Review history never transfers authority.'};
}
export async function seedInputs(p,dir){
 const pack=await verifyPackAssets(p,dir);if(pack.review?.revision!==pack.revision)throw new Error('Review the current Product/Brand inputs first');
 const claims=pack.claims.filter(c=>c.status!=='UNSUPPORTED');if(!claims.length)throw new Error('At least one reviewed supplied/source-backed claim is required. Unsupported claims are excluded.');
 const copy=claims[0].text;const campaign={brandName:pack.identity.name,headline:pack.identity.name,body:copy,summary:copy,cta:pack.cta.label,url:pack.cta.destination,color:pack.brand.color,confirmed:false,inputRevision:pack.revision,provenance:{kind:'locally reviewed user inputs, not independently verified',claimIds:claims.map(c=>c.id),excludedClaimIds:pack.claims.filter(c=>c.status==='UNSUPPORTED').map(c=>c.id)},variants:CONCEPTS.map(concept=>({concept,headline:pack.identity.name,body:copy,cta:pack.cta.label}))};
 // Keep an optional saved budget plan bound to the same reviewed campaign/render.
 // Plan edits already invalidate these outputs; reseeding must bind the new revision.
 if(p.growthPlan)campaign.planRevision=p.growthPlan.revision;
 if(pack.assets[0])campaign.assetPath=path.join(dir,pack.root,pack.assets[0].path);
 p.campaign=campaign;p.render=null;p.selection=null;p.preflight=null;p.exports=(p.exports||[]).map(e=>({...e,stale:true}));
 return campaign;
}
export function inputTracking(p,concept){return trackingUrl(p.productPack.cta.destination,p.productPack.cta.utm,concept);}
