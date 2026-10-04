import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {chromium} from 'playwright';
import {Store,sha256} from '../../src/core/store.js';
import {renderProject} from '../../src/render/index.js';
import {inspectFrame} from '../../src/render/inspection.js';
import {qualifyFFmpeg,runNative} from '../../src/render/native.js';
import {startServer} from '../../src/server.js';
const evidence=path.resolve(process.env.LF_EVIDENCE_DIR||'tests/inspection-r5a/evidence');await fs.mkdir(evidence,{recursive:true});await fs.mkdir('.test-output',{recursive:true});
const root=await fs.mkdtemp(path.resolve('.test-output/inspection-r5a-'));const source=path.join(root,'wide.mp4');
const {binary,encoder}=await qualifyFFmpeg();
await runNative(binary,['-y','-f','lavfi','-i','testsrc2=size=1600x900:rate=30:duration=6','-f','lavfi','-i','sine=frequency=440:duration=6','-c:v',encoder,...(encoder==='h264_videotoolbox'?['-allow_sw','1']:[]),'-b:v','3M','-c:a','aac',source]);
const store=new Store(path.join(root,'projects'));await store.init();let p=await store.importMedia(source,{name:'Wide frame inspection'});const id=p.studio.id,dir=store.dir(id);const originalHash=await sha256(path.join(dir,p.studio.asset.path));
p=await store.save(id,0,{...p.timeline,title:'Wide recording: preserve both edges',subtitle:'Inspect every ratio before export.',zoom:1.45,focus:{x:0.8,y:0.45},captions:[{startMs:500,endMs:2000,text:'This deliberately long caption tests final-composition wrapping and readability across portrait and landscape frames.'},{startMs:2000,endMs:4700,text:'The next caption begins exactly at the two-second boundary.'}]});
const receipt={root,comparisons:[],errors:[],status:'RUNNING',tolerance:'SSIM All >= 0.98 between separately rendered/extracted final frames'};
let app,browser;
try{
 for(const mode of ['cover','fit']){
  p=await store.save(id,p.studio.revision,{...p.timeline,framing:{landscape:mode,vertical:mode}});
  // Separate render call produces actual export movies. Inspection uses its own isolated render.
  await renderProject({projectDir:dir,...p});
  for(const ratio of ['landscape','vertical'])for(const timeMs of [0,1500,2000,5600]){
   const r=await inspectFrame({projectDir:dir,...p,ratio,timeMs});
   const inspected=path.join(evidence,`${mode}-${ratio}-${timeMs}-inspection.png`),extracted=path.join(evidence,`${mode}-${ratio}-${timeMs}-final.png`);
   await fs.copyFile(path.join(dir,'inspection.png'),inspected);
   await runNative(binary,['-y','-i',path.join(dir,'exports',ratio+'.mp4'),'-vf',`select=eq(n\\,${Math.floor(timeMs*30/1000)})`,'-frames:v','1','-update','1',extracted]);
   const compare=await runNative(binary,['-i',inspected,'-i',extracted,'-lavfi','ssim','-f','null','-']);const score=Number(/All:([\d.]+)/.exec(compare.stderr)?.[1]);assert.ok(score>=0.98,compare.stderr);
   receipt.comparisons.push({mode,ratio,timeMs,score,inspectionHash:await sha256(inspected),finalHash:await sha256(extracted),identity:r.identity});
  }
  for(const ratio of ['landscape','vertical'])await runNative(binary,['-v','error','-xerror','-i',path.join(dir,'exports',ratio+'.mp4'),'-f','null','-']);
 }
 p=await store.save(id,p.studio.revision,{...p.timeline,title:'Changed title'});assert.equal(p.inspection.stale,true);
 const changedRev=p.studio.revision;p=await store.recover(id,changedRev);assert.equal(p.timeline.title,'Wide recording: preserve both edges');assert.equal(await sha256(path.join(dir,p.studio.asset.path)),originalHash);receipt.recovery={revision:p.studio.revision,sourceHash:originalHash};
 app=await startServer({port:0,root:store.root});browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1050}});page.on('pageerror',e=>receipt.errors.push(e.message));await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
 await page.goto(app.url);await page.locator('.project-item').filter({hasText:'Wide frame inspection'}).click();
 await page.locator('#captions-section summary').click();
 async function importSub(name,buffer){await page.locator('#subtitle-file').setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from(buffer)});const pending=page.waitForResponse(r=>r.url().endsWith('/subtitles'));await page.locator('#import-subtitles').click();return pending;}
 let response=await importSub('review.srt','1\n00:00:00,500 --> 00:00:02,000\nReviewed SRT subtitle\n');assert.ok(response.ok());await page.waitForFunction(()=>!document.querySelector('#import-subtitles').disabled);
 response=await importSub('review.vtt','WEBVTT\n\n00:00.500 --> 00:02.000\nReviewed VTT subtitle\n');assert.ok(response.ok());await page.waitForFunction(()=>!document.querySelector('#import-subtitles').disabled);
 const before=await store.get(id);response=await importSub('bad.srt','malformed');assert.equal(response.status(),400);assert.equal((await store.get(id)).studio.revision,before.studio.revision);await page.waitForFunction(()=>!document.querySelector('#import-subtitles').disabled);
 await page.locator('#inspect-ratio').selectOption('vertical');await page.locator('#inspect-time').fill('1.999');const inspect=page.waitForResponse(r=>r.url().endsWith('/inspect'),{timeout:180000});await page.locator('#inspect-frame').click();assert.ok((await inspect).ok());await page.waitForFunction(()=>!document.querySelector('#inspect-frame').disabled);await page.locator('#safe-guides').check();
 await page.locator('#inspection-section').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,'inspection-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.locator('#inspection-image').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,'inspection-mobile.png')});
 const cover=page.waitForResponse(r=>r.url().endsWith('/inspect'),{timeout:180000});await page.locator('#review-cover').click();assert.ok((await cover).ok());await page.waitForFunction(()=>!document.querySelector('#review-cover').disabled);
 p=await store.get(id);assert.equal(p.timeline.coverTimeMs,1999);assert.equal(p.coverReview.stale,false);await fs.copyFile(path.join(dir,'reviewed-cover.png'),path.join(evidence,'reviewed-cover.png'));
 await new Promise(r=>app.server.close(r));app=await startServer({port:0,root:store.root});await page.goto(app.url);await page.locator('.project-item').filter({hasText:'Wide frame inspection'}).click();await page.waitForFunction(()=>document.querySelector('#inspect-time').value==='1.999');assert.equal(await page.locator('#inspect-time').inputValue(),'1.999');assert.ok(await page.locator('#cover-download').isVisible());
 await renderProject({projectDir:dir,...p});await runNative(binary,['-i',path.join(dir,'reviewed-cover.png'),'-i',path.join(dir,'exports','vertical-thumbnail.png'),'-lavfi','ssim','-f','null','-']).then(r=>{receipt.coverSsim=Number(/All:([\d.]+)/.exec(r.stderr)?.[1]);assert.ok(receipt.coverSsim>=.98);});
 assert.deepEqual(receipt.errors,[]);receipt.status='PASS';receipt.project=id;receipt.subtitleUI=['srt','vtt','malformed-no-mutation'];receipt.restart=true;
}finally{if(browser)await browser.close();if(app)await new Promise(r=>app.server.close(r));await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');}
console.log(JSON.stringify({status:receipt.status,comparisons:receipt.comparisons.length,root}));
