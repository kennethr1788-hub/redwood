import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {recordLocalObservation} from '../../integrations/connectors/local-observations.mjs';

// One browser integration case, seven named checkpoints. The supplied observation
// is explicitly synthetic. This never qualifies a real account or calls a provider.
const repo=fileURLToPath(new URL('../../',import.meta.url));
const {chromium,expect}=createRequire(path.join(repo,'products/build/package.json'))('@playwright/test');
const evidence=path.resolve(process.env.LF_EVIDENCE_DIR||path.join(repo,'launcher/.local/e2e-r1/connections-browser'));
await fs.mkdir(evidence,{recursive:true});
const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'redwood-connections-ui-')));
const directory=path.join(root,'observations'),canary=path.join(root,'unexpected-provider-execution'),bin=path.join(root,'bin');
await fs.mkdir(bin,{mode:0o700});
for(const name of ['codex','claude','cursor','gemini','higgsfield','elevenlabs'])await fs.writeFile(path.join(bin,name),'#!/bin/sh\nprintf invoked > "$REDWOOD_PROVIDER_CANARY"\nexit 97\n',{mode:0o700});
const sha=b=>createHash('sha256').update(b).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function freePort(){const s=net.createServer();await new Promise((r,j)=>{s.once('error',j);s.listen(0,'127.0.0.1',r);});const p=s.address().port;await new Promise(r=>s.close(r));return p;}
const port=await freePort(),unused=await freePort(),origin=`http://127.0.0.1:${port}`;
let launcher,browser,serverLog='';
const receipt={schemaVersion:1,status:'RUNNING',testCases:1,scope:'normal launcher server and actual Connections UI; synthetic trusted-local observation only',providerCalls:0,providerAuthenticationClaim:'SYNTHETIC_TEST_DATA_ONLY',checkpoints:[],browserErrors:[],externalRequests:[],browserApiRequests:[],publicWriteAttempts:[]};
async function api(route,method='GET',body){const r=await fetch(origin+route,{method,headers:{'X-LaunchForge':'1','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};}
async function start(){
 const env=Object.fromEntries(['HOME','TMPDIR','LANG','LC_ALL','LC_CTYPE'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
 launcher=spawn(process.execPath,['server.mjs'],{cwd:path.join(repo,'launcher'),env:{...env,PATH:bin+path.delimiter+process.env.PATH,LF_LAUNCHER_PORT:String(port),LF_BUILD_PORT:String(unused),LF_STUDIO_PORT:String(unused),LF_GROW_PORT:String(unused),LF_CONNECTIONS_DIR:directory,REDWOOD_PROVIDER_CANARY:canary},stdio:['ignore','pipe','pipe']});
 launcher.stdout.on('data',b=>serverLog=(serverLog+b).slice(-12000));launcher.stderr.on('data',b=>serverLog=(serverLog+b).slice(-12000));
 for(let i=0;i<100;i++){if(launcher.exitCode!==null)throw Error('Normal launcher exited before readiness: '+serverLog);try{if((await api('/api/status')).status===200)return;}catch{}await sleep(100);}throw Error('Normal launcher readiness timeout');
}
async function stop(){if(!launcher||launcher.exitCode!==null||launcher.signalCode!==null)return;const child=launcher;await new Promise(r=>{const timer=setTimeout(()=>child.kill('SIGKILL'),3000);child.once('exit',()=>{clearTimeout(timer);r();});child.kill('SIGTERM');});launcher=null;}
const observedRow=d=>d.rows.find(r=>r.connectorId==='codex');
const noAuthorization=d=>{assert.equal(d.actionAuthorization,'NOT_GRANTED');assert.ok(d.rows.every(r=>r.actionAuthorization==='NOT_GRANTED'));assert.equal(d.productCompletion,'NOT_ASSESSED');assert.equal(d.baseline,'UNAFFECTED_BY_CONNECTORS');};
try{
 await start();browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1050}});
 await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==origin){receipt.externalRequests.push(u.origin);return route.abort();}if(u.pathname.startsWith('/api/'))receipt.browserApiRequests.push({method:route.request().method(),path:u.pathname});return route.continue();});
 const page=await context.newPage();page.on('pageerror',e=>receipt.browserErrors.push(e.message));
 await page.goto(origin+'/#connections');await page.locator('#doctor-rows .connection-row').first().waitFor();
 let doctor=(await api('/api/status')).body.doctor;noAuthorization(doctor);assert.ok(doctor.rows.every(r=>r.status==='UNKNOWN'&&r.capabilityStates.every(c=>c.state!=='VERIFIED')));assert.equal(doctor.providerRuntimeQualification,'NOT_RUN');
 const row=page.locator('.connection-row').filter({has:page.getByText(observedRow(doctor).displayName,{exact:true})});await row.locator('summary').click();await expect(row.locator('summary')).toContainText('UNKNOWN');await page.screenshot({path:path.join(evidence,'zero-connections.png')});
 receipt.checkpoints.push({name:'zero baseline',rows:doctor.rows.length,providerRuntimeQualification:doctor.providerRuntimeQualification,actionAuthorization:doctor.actionAuthorization});

 const label='SYNTHETIC TEST ONLY; no provider executed; owned Connections UI fixture';
 const state=recordLocalObservation(directory,{connectorId:'codex',mode:'OFFICIAL_CLIENT',detected:true,authenticated:true,billingMode:'SUBSCRIPTION',verifiedCapabilities:['AGENT_EXECUTION'],evidenceDigest:sha('explicit synthetic fixture; no provider executed'),label,ttlMs:15000});
 const observationFile=path.join(directory,'observations.json'),saved=await fs.readFile(observationFile);assert.equal((await fs.stat(directory)).mode&0o077,0);assert.equal((await fs.stat(observationFile)).mode&0o077,0);
 await page.reload();await row.locator('summary').click();doctor=(await api('/api/status')).body.doctor;const current=observedRow(doctor);noAuthorization(doctor);
 assert.equal(current.status,'VERIFIED');assert.equal(current.freshness,'CURRENT');assert.equal(current.mode,'OFFICIAL_CLIENT');assert.equal(current.authenticated,true);assert.equal(current.billingMode,'SUBSCRIPTION');assert.equal(current.qualificationScope,label);assert.equal(current.costEstimate,null);assert.equal(current.capabilityStates.find(c=>c.capability==='AGENT_EXECUTION').state,'VERIFIED');
 await expect(row).toContainText('OFFICIAL_CLIENT');await expect(row).toContainText('AGENT_EXECUTION: VERIFIED');await expect(row).toContainText(label);await expect(row).toContainText(/NONE granted|NOT_GRANTED/);await expect(row).toContainText('YES');
 await page.screenshot({path:path.join(evidence,'synthetic-current.png')});receipt.checkpoints.push({name:'trusted writer observed exact scoped UI',row:current,scopeOnly:doctor.providerRuntimeQualification});

 await stop();await start();await page.reload();await row.locator('summary').click();doctor=(await api('/api/status')).body.doctor;noAuthorization(doctor);assert.equal(observedRow(doctor).freshness,'CURRENT');assert.equal(observedRow(doctor).qualificationScope,label);await expect(row).toContainText('AGENT_EXECUTION: VERIFIED');assert.deepEqual(await fs.readFile(observationFile),saved);
 receipt.checkpoints.push({name:'process restart and reopen retain current scoped observation',stateUnmodified:true});

 // These are ordinary HTTP writes against the real server, never an injected host adapter.
 for(const route of ['/api/status','/api/connections','/api/observations','/api/connections/observations']){const response=await api(route,'POST',{observations:[{connectorId:'codex',state}],scopeIdentity:state.scopeIdentity});assert.equal(response.status,404);receipt.publicWriteAttempts.push({method:'POST',path:route,status:response.status});}
 assert.deepEqual(await fs.readFile(observationFile),saved);receipt.checkpoints.push({name:'public API cannot write observations',attempts:receipt.publicWriteAttempts.length,stateUnmodified:true});

 // Real wall-clock expiry, using the supported writer's short bounded TTL.
 const remaining=Date.parse(state.expiresAt)-Date.now();assert.ok(remaining>0,'Fixture TTL expired before current/restart checkpoint');await sleep(remaining+100);
 await page.reload();await row.locator('summary').click();doctor=(await api('/api/status')).body.doctor;const expired=observedRow(doctor);noAuthorization(doctor);assert.equal(expired.status,'UNKNOWN');assert.equal(expired.freshness,'STALE_OR_UNBOUND');assert.equal(expired.detected,null);assert.equal(expired.authenticated,null);assert.ok(expired.capabilityStates.every(c=>c.state!=='VERIFIED'));assert.equal(doctor.providerRuntimeQualification,'STALE_OR_UNBOUND');
 await expect(row.locator('summary')).toContainText('UNKNOWN');await expect(row).toContainText('AGENT_EXECUTION: UNKNOWN');await expect(row).toContainText(label);await page.screenshot({path:path.join(evidence,'synthetic-expired.png')});
 receipt.checkpoints.push({name:'real TTL expiry removes current auth and capability claims',row:expired,providerRuntimeQualification:doctor.providerRuntimeQualification});
 assert.deepEqual(await fs.readFile(observationFile),saved);receipt.checkpoints.push({name:'observation storage remains read-only through reopen and expiry',sha256:sha(saved)});
 assert.ok(receipt.browserApiRequests.every(r=>r.method==='GET'),'Connections initiated an action');assert.deepEqual(receipt.externalRequests,[]);assert.deepEqual(receipt.browserErrors,[]);await assert.rejects(fs.access(canary),{code:'ENOENT'});
 receipt.checkpoints.push({name:'no provider action or egress occurred',browserMethods:[...new Set(receipt.browserApiRequests.map(r=>r.method))],providerCanary:'NOT_INVOKED',externalRequests:0});receipt.status='PASS';
}catch(e){receipt.status='FAIL';receipt.error={name:e.name,message:e.message};throw e;}
finally{await browser?.close();await stop();receipt.cleanup={launcherStopped:true};await fs.writeFile(path.join(evidence,'connections-observations-browser.json'),JSON.stringify(receipt,null,2)+'\n');await fs.writeFile(path.join(evidence,'server.log'),serverLog);await fs.rm(root,{recursive:true,force:true});}
console.log(JSON.stringify(receipt,null,2));
