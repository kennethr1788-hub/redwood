import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createApp} from '../src/server.js';
import {verifyExport,extractBundle} from '../src/delivery/index.js';
import {expectedTracking} from '../src/preflight/index.js';

test('reviewed owned inputs export their current bound budget plan and reject changed plans', {timeout:180000}, async()=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'grow-owned-plan-')));
  const app=createApp({dataDir:path.join(root,'data')});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${app.server.address().port}`;let p;
  async function post(action,input,expected=200){
    const r=await fetch(origin+(action==='create'?'/api/projects':`/api/projects/${p.id}/${action}`),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
    const body=await r.json();assert.equal(r.status,expected,JSON.stringify(body));if(r.ok)p=body;return body;
  }
  try{
    await post('create',{name:'Benchline',planOnly:true},201);
    await post('product-inputs',{identity:{name:'Benchline',audience:'Single repair operators',geography:'US',language:'English'},claims:[{id:'queue',text:'Keep a local fictional repair queue.',status:'USER_SUPPLIED',provenance:'Synthetic fixture'}],cta:{label:'Explore Benchline',destination:'https://example.com/benchline',utm:{source:'organic',medium:'social',campaign:'benchline'}},brand:{color:'#192d3b',style:'Existing synthetic fixture'},article:'# Benchline\n\nA fictional local repair queue.',rightsNotes:'Owned synthetic fixture; no customer data',localAssets:[]});
    await post('review-product-pack',{revision:p.productPack.revision,confirmed:true});
    const input={totalBudget:100,currency:'USD',days:7,goal:'LEADS',businessName:'Benchline',category:'Local repair software demo',geography:'US',audience:'Single repair operators',specialCategory:'NONE',url:'https://example.com/benchline',offer:'Explore the local repair workflow',remarketingAudience:'NO',customerList:'NO'};
    await post('growth-plan',input);const planRevision=p.growthPlan.revision;
    await post('seed-inputs',{});await post('campaign',{confirmed:true});await post('render',{});
    await post('select-concept',{concept:'spotlight',ratios:['square','portrait','story'],trackedUrl:expectedTracking(p,'spotlight'),altText:'Benchline local repair queue demonstration',reviewed:true});
    assert.equal(p.preflight.localExportReady,true);await post('export',{scheduledAt:'2026-10-05T12:00:00Z'});
    const output=p.exports.at(-1);assert.equal(output.status,'EXPORTED');assert.equal(output.publishedAt,null);
    const names=output.files.map(f=>f.name);console.log(JSON.stringify({scope:'real-local-api-render-export',planRevision,exportPlanRevision:output.planRevision,exportFiles:names}));
    for(const file of ['growth-plan.json','growth-plan.md','budget-plan.csv','utm-plan.csv','source-registry.json','organic-checklist.md','paid-social-brief.md'])assert.ok(names.includes(file),`Owned-input export omitted ${file}`);
    assert.equal(output.planRevision,planRevision);assert.equal(p.campaign.planRevision,planRevision);assert.equal(p.render.planRevision,planRevision);
    const plan=JSON.parse(await readFile(path.join(output.directory,'growth-plan.json'),'utf8'));assert.equal(plan.revision,planRevision);assert.equal(plan.budget.totalCents,10000);assert.equal(plan.budget.reserveCents,1000);
    const verified=await verifyExport(output.directory,output.integritySha256);await extractBundle(output.bundlePath,path.join(root,'extracted'));assert.deepEqual(await verifyExport(path.join(root,'extracted'),output.integritySha256),verified);
    // Identical save retains exact revision; a material plan edit invalidates all dependent outputs.
    await post('growth-plan',input);assert.equal(p.growthPlan.revision,planRevision);assert.notEqual(p.campaign.stale,true);
    await post('growth-plan',{...input,totalBudget:120});assert.equal(p.campaign.stale,true);assert.equal(p.render.stale,true);assert.equal(p.exports.at(-1).stale,true);
    assert.equal(p.exports.at(-1).status,'EXPORTED');assert.equal(p.exports.at(-1).publishedAt,null);
    await post('render',{},400);await post('export',{scheduledAt:'2026-10-05T12:00:00Z'},400);
    await post('seed-inputs',{});assert.equal(p.campaign.planRevision,p.growthPlan.revision);assert.notEqual(p.campaign.planRevision,planRevision);assert.equal(p.render,null);
  }finally{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));await rm(root,{recursive:true,force:true});}
});
