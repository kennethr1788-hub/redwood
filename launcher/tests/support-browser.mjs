import {promises as fs} from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../', import.meta.url)), build = path.join(root,'products/build');
const {chromium, expect} = createRequire(path.join(build,'package.json'))('@playwright/test');
const out = process.env.LF_EVIDENCE_DIR || path.join(root,'launcher/tests/evidence/support-r1a'); await fs.mkdir(out,{recursive:true});
await fs.mkdir(path.join(root,'launcher/.local'),{recursive:true});
const workspace = await fs.mkdtemp(path.join(root,'launcher/.local/browser-'));
const freePort = () => new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
const bp=await freePort(), lp=await freePort(), sp=await freePort();
const origin='http://127.0.0.1:'+lp, owner='http://127.0.0.1:'+bp;
let backend, launcher, browser;
// Reserved product sources are not executed or edited: list-response fixtures only.
const fixture=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end('[]');});
await new Promise(r=>fixture.listen(sp,'127.0.0.1',r));
async function start(kind) {
 const child=spawn(process.execPath,kind==='build'?['--import','tsx','src/backend/server.ts']:['server.mjs'],{cwd:kind==='build'?build:path.join(root,'launcher'),env:{...process.env,LF_PORT:String(bp),LF_WORKSPACE:workspace,LF_LAUNCHER_PORT:String(lp),LF_BUILD_PORT:String(bp),LF_STUDIO_PORT:String(sp),LF_GROW_PORT:String(sp),LF_CONNECTIONS_DIR:path.join(workspace,'.connections')},stdio:'pipe'});
 let log=''; child.stderr.on('data',b=>{log=(log+b).slice(-2000);}); child.stdout.on('data',()=>{});
 for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(kind+' exited: '+log);try{if((await fetch(kind==='build'?owner:origin)).ok)return child;}catch{}await new Promise(r=>setTimeout(r,100));}
 child.kill('SIGTERM'); throw Error(kind+' did not become ready');
}
async function stop(child){if(child&&child.exitCode===null)await new Promise(r=>{child.once('exit',r);child.kill('SIGTERM');});}
async function api(base, route, body){const response=await fetch(base+'/api/'+route,{method:body?'POST':'GET',headers:{'X-LaunchForge':'1','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;}
const receipt={status:'RUNNING', checks:[], browserErrors:[], externalRequests:[], reservedProducts:'READ_ONLY_ADAPTER_FIXTURES; LIST_RESPONSE_STUBS_ONLY', providerCalls:0};
try {
 backend=await start('build');launcher=await start('launcher');browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:390,height:844}});
 await context.route('**/*', async route=>{const u=new URL(route.request().url());if(!['127.0.0.1'].includes(u.hostname)){receipt.externalRequests.push(u.origin);await route.abort();}else await route.continue();});
 const page=await context.newPage();page.on('pageerror',e=>receipt.browserErrors.push(e.message));
 await page.goto(origin+'/#setup');await page.getByLabel('Project name',{exact:true}).fill('Support Journey');await page.getByLabel('Desired outcome').fill('Create a useful milestone tracker and preserve existing source.');
 await page.getByLabel('Audience (optional)').fill('Local teams');
 await page.getByRole('button',{name:'Check setup',exact:true}).click();await expect(page.getByTestId('setup-state')).toHaveText('READY');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.evaluate(() => window.scrollTo(0, 0));await page.screenshot({path:path.join(out,'onboarding-390.png'),fullPage:true});receipt.checks.push('390px zero-connector fresh manual setup READY');
 await page.getByLabel('Coding tool',{exact:true}).selectOption('codex');await page.getByRole('button',{name:'Check setup',exact:true}).click();await expect(page.getByTestId('setup-state')).toHaveText('UNKNOWN');
 await page.getByRole('button',{name:'Use manual handoff instead'}).click();await expect(page.getByTestId('setup-state')).toHaveText('READY');receipt.checks.push('unprobed provider UNKNOWN and manual fallback READY');
 const setup={projectName:'Route fixture',desiredOutcome:'Keep the independent baseline usable.',selectedAgentAdapterId:'manual'};
 for(const [startingPoint,product] of [['IDEA','build'],['REPO','build'],['APP_OR_RECORDING','studio'],['GROW_INPUTS','grow']]){const result=await api(origin,'setup',{...setup,startingPoint});assert.equal(result.setup.product,product);assert.equal(result.setup.readiness.state,'READY');assert.equal(result.setup.connectors.length,0);}
 receipt.checks.push('four starting-point routes; Studio/Grow list fixtures only');
 const rejected=await fetch(origin+'/api/setup',{method:'POST',headers:{'X-LaunchForge':'1','Content-Type':'application/json'},body:JSON.stringify({...setup,startingPoint:'IDEA',desiredOutcome:'api_key=synthetic-sensitive-do-not-export'})});assert.equal(rejected.status,400);assert.ok(!(await rejected.text()).includes('synthetic-sensitive'));assert.equal((await fetch(origin+'/api/status')).status,403);assert.equal((await fetch(origin+'/api/status',{headers:{'X-LaunchForge':'1',Origin:'https://invalid.example'}})).status,403);receipt.checks.push('secret canary and cross-origin/missing-header API rejection');
 await page.getByRole('link',{name:'Continue to Build',exact:true}).click();await expect(page.getByLabel('Project name',{exact:true})).toHaveValue('Support Journey');
 assert.equal(await page.locator('#product-brief').inputValue(),'Create a useful milestone tracker and preserve existing source.\n\nAudience: Local teams');
 await page.getByRole('button',{name:'Create project',exact:true}).click();await expect(page.getByTestId('resume-state')).toHaveText('NOT_RUN');
 await expect(page.getByRole('button',{name:'Prepare agent task',exact:true})).toBeDisabled();await page.getByLabel(/I reviewed the brief for sensitive data/).check();await page.getByRole('button',{name:'Prepare agent task',exact:true}).click();await expect(page.getByTestId('prepared-task')).toContainText('MANUAL_HANDOFF');
 await page.locator('.brief-body textarea').fill('Unsaved revision must not be handed off.');
 await expect(page.getByRole('button',{name:'Prepare agent task',exact:true})).toBeDisabled();await expect(page.getByTestId('prepared-task')).toHaveCount(0);
 await page.locator('.brief-body textarea').fill('Create a useful milestone tracker and preserve existing source.\n\nAudience: Local teams');await expect(page.getByTestId('prepared-task')).toBeVisible();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(out,'build-handoff-390.png'),fullPage:true});
 const list=await api(owner,'projects'), id=list.projects[0].id, folder=path.join(workspace,id);
 const packet=JSON.parse(await fs.readFile(path.join(folder,'.launchforge/agent-task.json'),'utf8'));assert.equal(packet.product,'build');assert.ok(packet.inputs.some(i=>i.path==='.launchforge/resume.json'));receipt.checks.push('setup prefill, create, reviewed task write/readback, unsaved-brief gate and 390px Build handoff');
 await page.goto(origin+'/#recent');await page.getByRole('button',{name:'Read current projects'}).click();await page.getByRole('button',{name:'Resume Support Journey'}).click();await expect(page.getByTestId('recent-state')).toHaveText('NOT_RUN');
 const pointers=await page.evaluate(()=>localStorage.getItem('launchforge-recent-v1'));assert.deepEqual(JSON.parse(pointers),{schemaVersion:1,projects:[{product:'build',id}]});
 await stop(launcher);await stop(backend);backend=await start('build');launcher=await start('launcher');await page.reload();await page.getByRole('button',{name:'Resume Support Journey'}).click();await expect(page.getByTestId('recent-state')).toHaveText('NOT_RUN');
 await page.getByRole('link',{name:'Open current Build project'}).click();await expect(page.getByTestId('resume-state')).toHaveText('NOT_RUN');assert.equal((await api(owner,'projects/'+id)).trusted,false);receipt.checks.push('launcher and Build restart/reopen; pointer survives; product trust remains session-only');
 const old=JSON.parse(await fs.readFile(path.join(folder,'.launchforge/resume.json'),'utf8'));await fs.appendFile(path.join(folder,'src/main.tsx'),'\n// post-restart source change\n');
 const fresh=await api(owner,'projects/'+id+'/resume');assert.notEqual(old.sourceIdentity,fresh.sourceIdentity);assert.equal(fresh.completionState,'NOT_RUN');
 await fs.writeFile(path.join(folder,'.launchforge/provider-result.json'),JSON.stringify({success:true,completionState:'CURRENT_PASS'}));assert.equal((await api(owner,'projects/'+id+'/resume')).completionState,'NOT_RUN');receipt.checks.push('fresh source identity overrides saved resume; provider success cannot complete Build');
 await stop(backend);backend=null;const offline=await api(origin,'setup',{...setup,startingPoint:'IDEA'});assert.equal(offline.setup.readiness.state,'NEEDS_SETUP');receipt.checks.push('offline core NEEDS_SETUP, no cached READY');
 assert.deepEqual(receipt.browserErrors,[]);assert.deepEqual(receipt.externalRequests,[]);receipt.status='PASS';
} finally {
 await browser?.close();await stop(launcher);await stop(backend);await new Promise(r=>fixture.close(r));fixture.closeAllConnections();
 await fs.writeFile(path.join(out,'support-browser.json'),JSON.stringify(receipt,null,2)+'\n');
}
console.log(JSON.stringify(receipt));
