import { DISPLAY_NAMES, applyDisplayNames } from '../../../launcher/src/display-names.js';
import {freezePlan,observeResults,compareResults,reviewAdjustment,researchExport} from './measurement/workspace.js';
import {buildWorkspaceTopics,overrideWorkspaceTopics} from './content/topic-workspace.js';
import {addEvidence} from './evidence/workspace.js';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,mkdir,realpath,stat,copyFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import sharp from 'sharp';
import {createStore,atomicWrite} from './core/store.js';
import {auditSite} from './audit/index.js';
import {buildContent,validateMarkdown} from './content/index.js';
import {proposePatch,preparePatchHandoff} from './patch/index.js';
import {defaultCampaign} from './creative/index.js';
import {renderCampaign} from './render/index.js';
import {exportCampaign} from './delivery/index.js';
import {buildPlan,updatePlan,seedCampaign,planFiles,httpUrl} from './planner/index.js';
import {directPack,loadPack,installPack,reviewPack,exportPack,seedInputs,verifyPackAssets,invalidateInputs} from './intake/index.js';
import {validateSelection,preflight} from './preflight/index.js';
import {compareAudits} from './core/recheck.js';

const base=path.dirname(fileURLToPath(import.meta.url));
const fontFiles={
 '/fonts/dm-sans-400.woff2':'@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff2',
 '/fonts/dm-sans-500.woff2':'@fontsource/dm-sans/files/dm-sans-latin-500-normal.woff2',
 '/fonts/dm-sans-600.woff2':'@fontsource/dm-sans/files/dm-sans-latin-600-normal.woff2',
 '/fonts/instrument-serif-400.woff2':'@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2',
};
const mime={'.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/json','.md':'text/markdown','.txt':'text/plain','.csv':'text/csv','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.mp4':'video/mp4','.webm':'video/webm','.log':'text/plain','.mjs':'text/plain'};
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
async function body(req) { let chunks=[],size=0;for await (const c of req){size+=c.length;if(size>1024*1024)throw new Error('Request exceeds 1 MB');chunks.push(c);}return JSON.parse(Buffer.concat(chunks).toString()||'{}'); }
function text(value,max=1000){if(typeof value!=='string'||value.length>max)throw new Error(`Text must be shorter than ${max} characters`);return value;}

export function createApp({dataDir=path.resolve('.grow-data'),allowedLocalOrigin,auditRunner=auditSite}={}) {
 const store=createStore(dataDir); let queue=Promise.resolve();
 const serialize=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;};
 const persistPlan=async(dir,p)=>{for(const [name,data] of Object.entries(planFiles(p.growthPlan)))await atomicWrite(path.join(dir,'growth-plan',name),data);};
 // Applicability is a fresh projection; persisted handoff/legacy receipts remain history.
 const projectView=async p=>{
  if(!p.patchHandoff)return p;
  try {
   await preparePatchHandoff(p.sourceDir,p.patch,{approvedHash:p.patchHandoff.proposalHash});
   return p;
  } catch(e) {
   return {...p,patchHandoff:{...p.patchHandoff,status:'STALE',prompt:null,message:e.message}};
  }
 };
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; media-src 'self'; frame-ancestors 'none'; base-uri 'none'");
  try {
   const host=req.headers.host;
   if(!host||!/^127\.0\.0\.1:\d+$/.test(host)) return json(res,{error:'Use the displayed 127.0.0.1 address'},403);
   if(req.headers.origin && req.headers.origin!==`http://${host}`) return json(res,{error:'Cross-origin request rejected'},403);
   const url=new URL(req.url,`http://${host}`), parts=url.pathname.split('/').filter(Boolean);
   if(req.method==='GET' && url.pathname==='/api/projects') return json(res,await store.list());
   if(req.method==='POST'&&url.pathname==='/api/projects') {const input=await body(req);return json(res,await serialize(()=>store.create({name:text(input.name||'',100),url:text(input.url||'',2048),planOnly:input.planOnly===true,sourceDir:input.sourceDir?text(input.sourceDir,2048):undefined,trustedSite:input.trustedSite===true,renderDom:input.renderDom===true,readinessSelector:text(input.readinessSelector||'',200)})),201);}
   if(parts[0]==='api'&&parts[1]==='projects'&&parts[2]) {
    const id=parts[2],dir=store.projectDir(id);
    if(req.method==='GET'&&parts.length===4&&parts[3]==='advisor-context') {
     // Read-only projection: unlike the editor GET, this never verifies/invalidates/saves inputs.
     const p=await serialize(()=>store.get(id));
     const stale=(p.exports||[]).some(e=>e.stale===true)||p.campaign?.stale===true;
     return json(res,{projectId:p.id,product:'grow',revision:typeof p.updatedAt==='string'?'revision-'+Date.parse(p.updatedAt):null,
      freshness:stale?'STALE':'UNKNOWN',completionState:stale?'STALE':'UNKNOWN'});
    }
    if(req.method==='POST'&&parts[3]==='apply-patch') return json(res,{error:'Grow prepares source proposals. Build or your coding tool implements them. Grow has not changed the source.'},410);
    if(req.method==='GET'&&parts.length===3) return json(res,await serialize(async()=>{const p=await store.get(id);if(p.productPack){try{await verifyPackAssets(p,dir);}catch(e){invalidateInputs(p);p.productPack.notice=`Input assets changed or are unavailable: ${e.message}`;await store.save(p);}}return projectView(p);}));
    if(req.method==='GET'&&parts[3]==='files') {
     const rel=decodeURIComponent(parts.slice(4).join('/')); const file=await realpath(path.resolve(dir,rel));const root=await realpath(dir);
     if(!file.startsWith(root+path.sep))throw new Error('File is outside project');
     const ext=path.extname(file); if(!mime[ext]||ext==='.html'||ext==='.js'||ext==='.css')throw new Error('Unsupported download type');
     const info=await stat(file);if(!info.isFile())throw new Error('Not a file');
     res.writeHead(200,{'Content-Type':mime[ext],'Content-Length':info.size,'Cache-Control':'no-store'});createReadStream(file).pipe(res);return;
    }
    if(req.method==='POST') {
     const input=await body(req);
     const project=await serialize(async()=>{
      const p=await store.get(id); const action=parts[3];
      if(action==='freeze-plan'){freezePlan(p,input);
      }else if(action==='observe-results'){observeResults(p,input);
      }else if(action==='compare-results'){compareResults(p,input);
      }else if(action==='review-allocation'){reviewAdjustment(p,input);
      }else if(action==='topic-map'){buildWorkspaceTopics(p,input);
      }else if(action==='topic-override'){overrideWorkspaceTopics(p,input);
      }else if(action==='import-evidence'){await addEvidence(p,dir,input);
      }else if(action==='product-inputs' || action==='import-product-pack') {
       const loaded=action==='product-inputs'?await directPack(input):await loadPack(text(input.file,2048));
       validateMarkdown(loaded.pack.article);
       await installPack(p,dir,loaded,action==='import-product-pack');
      } else if(action==='review-product-pack') {
       if(input.confirmed!==true)throw new Error('Confirm local review of the exact inputs and rights');
       await reviewPack(p,dir,input.revision);
      } else if(action==='export-product-pack') {
       await exportPack(p,dir);
      } else if(action==='seed-inputs') {
       await seedInputs(p,dir);await atomicWrite(path.join(dir,'campaigns','campaign.json'),p.campaign);
      } else if(action==='select-concept') {
       p.selection=validateSelection(input,p);p.preflight=await preflight(p);p.exports=(p.exports||[]).map(e=>({...e,stale:true}));
      } else if(action==='preflight') {
       p.preflight=await preflight(p);
      } else if(action==='growth-plan') {
       updatePlan(p,buildPlan(input,p.audit));
       await persistPlan(dir,p);
      } else if(action==='seed-creative') {
       if(!p.growthPlan)throw new Error('Save a growth plan first');
       p.campaign=seedCampaign(p.growthPlan,p.campaign||{});p.render=null;
       p.exports=(p.exports||[]).map(e=>({...e,stale:true}));
       await atomicWrite(path.join(dir,'campaigns','campaign.json'),p.campaign);
       if(!p.content){p.content={status:'USER_INPUT_DRAFT_REQUIRES_REVIEW',faq:[],suggestions:[],schemaNote:'No structured data inferred from planner inputs.'};p.article=`# ${p.growthPlan.input.businessName}\n\n${p.growthPlan.input.offer||'Add factual offer details here.'}\n\n## Questions to answer\n\n- What does the offering include?\n- Who is it for?\n- What are the price, availability and next steps?\n\nDraft from user input; verify every claim before external use.\n`;await atomicWrite(path.join(dir,'content','article.md'),p.article);}
      } else if(action==='audit') {
       if(!p.url)throw new Error('This planning-only project has no audit URL.');
       if(input.trustedSite===true)p.auditOptions={...p.auditOptions,trustedSite:true};
       if(!p.auditOptions?.trustedSite)throw new Error('Confirm that you own or trust this site before running its browser audit.');
       const before=p.audit;
       let sourceRevision='URL_ONLY';
       if(p.sourceDir) {try {const file=path.join(p.sourceDir,'index.html');if((await stat(file)).size<=1_000_000)sourceRevision='sha256:'+createHash('sha256').update(await readFile(file)).digest('hex');}catch{/* Source is optional; crawl can still report URL evidence. */}}
       p.audit=await auditRunner(p.url,{maxPages:3,allowedLocalOrigin,outputDir:path.join(dir,'audits'),renderDom:p.auditOptions.renderDom===true,readinessSelector:p.auditOptions.readinessSelector||undefined,sourceRevision});
       p.audit.recheck=compareAudits(before,p.audit);
       p.audit.artifacts=(p.audit.artifacts||[]).map(f=>({...f,relativePath:path.relative(dir,f.path)}));
       if(p.audit.lab?.reports)p.audit.lab.reports=p.audit.lab.reports.map(r=>({...r,relativeArtifact:r.artifact?path.relative(dir,r.artifact):null}));
       await atomicWrite(path.join(dir,'audits',`${randomUUID()}.json`),p.audit);
       if(p.audit.pages?.some(page=>page.status>=200&&page.status<400)) {
        const firstDraft=!p.content;
        p.content=buildContent(p.audit);
        if(firstDraft) {
         p.article=p.content.markdown;
         await atomicWrite(path.join(dir,'content','article.md'),p.article);
        }
        if(!p.campaign) p.campaign=defaultCampaign(p.audit,{conceptCount:3});
       }
       if(p.growthPlan){updatePlan(p,buildPlan(p.growthPlan.input,p.audit));await persistPlan(dir,p);}
      } else if(action==='article') {
       p.article=text(input.markdown,50000); validateMarkdown(p.article); await atomicWrite(path.join(dir,'content','article.md'),p.article);
      } else if(action==='campaign') {
       if(!p.campaign)throw new Error('Seed from a growth plan or run an audit first');
       if(p.campaign.stale)throw new Error('Plan changed. Seed creative from the current plan before reviewing.');
       const c={...p.campaign};for(const key of ['brandName','summary','headline','body','cta','color'])if(input[key]!==undefined)c[key]=text(input[key],key==='body'||key==='summary'?500:120);
       if(!/^#[0-9a-fA-F]{6}$/.test(c.color))throw new Error('Use a six-digit brand color');
       if(input.url!==undefined)c.url=httpUrl(input.url);
       if(p.growthPlan && !c.inputRevision && c.url!==p.growthPlan.creative.destination)throw new Error('Change the destination in Growth Plan, save and reseed so the plan and UTM records stay aligned.');
       c.confirmed=input.confirmed===true;
       // Regenerate all three concepts from the explicitly reviewed copy.
       if(c.planRevision || c.inputRevision){
        if(input.variants!==undefined){if(!Array.isArray(input.variants)||input.variants.length!==3)throw new Error('Review exactly three creative angles');c.variants=input.variants.map((v,i)=>({concept:['spotlight','editorial','signal'][i],headline:text(v.headline,92),body:text(v.body,240),cta:text(v.cta,32)}));}
        else c.variants=c.variants.map((v,i)=>i===0?{...v,headline:c.headline,body:c.body,cta:c.cta}:v);
        c.headline=c.variants[0].headline;c.body=c.variants[0].body;c.cta=c.variants[0].cta;
       }else c.variants=[{concept:'spotlight',headline:c.headline,body:c.body,cta:c.cta},{concept:'editorial',headline:`Meet ${c.brandName}`,body:c.summary.trim()||c.body,cta:c.cta},{concept:'signal',headline:c.headline,body:c.body,cta:c.cta}];
       if(input.assetPath){
        if(c.inputRevision)throw new Error('Change the image in Owned inputs, then review and seed again.');
        const asset=await realpath(text(input.assetPath,2048));const s=await stat(asset);if(!s.isFile()||s.size>10*1024*1024)throw new Error('Choose a PNG/JPEG/WebP image under 10 MB');
        const meta=await sharp(asset,{limitInputPixels:16000000}).metadata();if(!['png','jpeg','webp'].includes(meta.format))throw new Error('Choose a PNG/JPEG/WebP image');
        await mkdir(path.join(dir,'brand'),{recursive:true});const target=path.join(dir,'brand',`asset.${meta.format==='jpeg'?'jpg':meta.format}`);await copyFile(asset,target);c.assetPath=target;
       }
       p.campaign=c;p.render=null;p.exports=(p.exports||[]).map(e=>({...e,stale:true})); await atomicWrite(path.join(dir,'campaigns','campaign.json'),c);
      } else if(action==='render') {
       if(p.campaign?.stale || (!p.campaign?.inputRevision && p.growthPlan && p.campaign?.planRevision!==p.growthPlan.revision))throw new Error('Seed creative from the current growth plan first');
       if(!p.campaign?.confirmed)throw new Error('Confirm brand, copy and asset rights first');
       if(p.campaign.inputRevision){try{await verifyPackAssets(p,dir);}catch(e){invalidateInputs(p);p.productPack.review=null;await store.save(p);throw e;}if(p.productPack.review?.revision!==p.campaign.inputRevision)throw new Error('Review and seed current Product/Brand inputs first');}
       p.render=await renderCampaign(p.campaign,path.join(dir,'renders',randomUUID()));
       p.render.planRevision=p.campaign.planRevision||null;p.render.inputRevision=p.campaign.inputRevision||null;
       p.render.files=p.render.files.map(f=>({...f,relativePath:path.relative(dir,f.path||path.join(p.render.outputDir||'',f.name))}));
      } else if(action==='export') {
       if(p.render?.stale || p.campaign?.stale || (!p.campaign?.inputRevision && p.growthPlan && p.render?.planRevision!==p.growthPlan.revision))throw new Error('Plan changed. Seed, review and render again before export.');
       if(!p.render)throw new Error('Render the reviewed campaign first');
       if(p.campaign.inputRevision){try{await verifyPackAssets(p,dir);}catch(e){invalidateInputs(p);p.productPack.review=null;await store.save(p);throw e;}if(!p.selection)throw new Error('Select a concept and review placement preflight before export');}
       if(p.selection){p.preflight=await preflight(p);if(!p.preflight.localExportReady)throw new Error(p.preflight.blockers.join(' '));}
       const when=text(input.scheduledAt,100);if(!Number.isFinite(Date.parse(when)))throw new Error('Choose a valid calendar time');
       const result=await exportCampaign({campaign:p.campaign,render:p.render,content:p.article,growthPlan:p.growthPlan,productPack:p.productPack,selection:p.selection,preflight:p.preflight,research:researchExport(p),scheduledAt:when},dir);p.exports.push(result);
      } else if(action==='propose-patch') {
       if(!p.sourceDir)throw new Error('This URL-only project has no selected source checkout');
       if(!p.audit?.pages?.length)throw new Error('Audit first');
       const rawPage=p.audit.pages.map(page=>page.rawEvidence||page).find(page=>['/','/index.html'].includes(new URL(page.url).pathname));
       let sourceHash;
       try {const file=path.join(p.sourceDir,'index.html');if((await stat(file)).size<=2_000_000)sourceHash=createHash('sha256').update(await readFile(file)).digest('hex');}catch{/* The source adapter reports the exact refusal. */}
       const evidencePage=rawPage?.evidenceKind==='RAW_HTML'&&rawPage.evidenceHash===sourceHash?rawPage:undefined;
       p.patch=await proposePatch(p.sourceDir,{title:text(input.title,200),description:text(input.description,500),canonical:text(input.canonical,2048),jsonLd:input.includeJsonLd?p.content?.jsonLd:undefined},{evidencePage});
       p.patchHandoff=null;
       await atomicWrite(path.join(dir,'patches',`${p.patch.id||randomUUID()}.json`),p.patch);
      } else if(action==='prepare-patch-handoff') {
       if(!p.patch||!p.sourceDir)throw new Error('Create and review a source proposal first');
       p.patchHandoff=await preparePatchHandoff(p.sourceDir,p.patch,{approvedHash:input.approvedHash,proposalPath:path.join(dir,'patches',`${p.patch.id}.json`)});
      } else throw new Error('Unknown operation');
      if(['campaign','article','growth-plan','seed-creative','render'].includes(action)&&p.selection)p.selection.reviewed=false;
      if(action==='article')p.exports=(p.exports||[]).map(e=>({...e,stale:true}));
      if(['campaign','article','growth-plan','seed-creative','render'].includes(action)&&p.preflight){p.preflight.stale=true;p.preflight.localExportReady=false;}
      if(['freeze-plan','observe-results','compare-results','review-allocation'].includes(action))p.exports=(p.exports||[]).map(e=>({...e,stale:true}));
      return store.save(p);
     });
     return json(res,await projectView(project));
    }
   }
   if(req.method==='GET') {
    const font=fontFiles[url.pathname];
    if(font){res.writeHead(200,{'Content-Type':'font/woff2'});res.end(await readFile(path.join(base,'../node_modules',font)));return;}
    const files={'/':'ui/index.html','/app.js':'ui/app.js','/styles.css':'styles/main.css','/planner.js':'ui/planner.js','/inputs.js':'ui/inputs.js','/research.js':'ui/research.js','/learning.js':'ui/learning.js'}; const rel=files[url.pathname];
    if(rel){res.writeHead(200,{'Content-Type':mime[path.extname(rel)]});res.end(rel==='ui/index.html'?applyDisplayNames(await readFile(path.join(base,rel),'utf8')):await readFile(path.join(base,rel)));return;}
   }
   json(res,{error:'Not found'},404);
  }catch(e){json(res,{error:e.message||'Operation failed'},400);}
 });
 return {server,store};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const port=Number(process.env.PORT||4383);const {server}=createApp({dataDir:process.env.GROW_DATA_DIR||path.resolve('.grow-data'),allowedLocalOrigin:process.env.GROW_ALLOWED_LOCAL_ORIGIN});
 server.listen(port,'127.0.0.1',()=>console.log(`${DISPLAY_NAMES.umbrella} ${DISPLAY_NAMES.grow}: http://127.0.0.1:${server.address().port}`));
 server.on('error',e=>{console.error(e.message);process.exitCode=1;});
}
