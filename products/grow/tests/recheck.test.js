import test from 'node:test';
import assert from 'node:assert/strict';
import {compareAudits} from '../src/core/recheck.js';
const report=(score,extra={})=>({url:'https://example.com/',requestedUrl:'https://example.com/',version:'13.5.0',observations:[{id:'meta-description',title:'Description',score,scoreDisplayMode:'binary'}],...extra});
const audit=(id,score,extra={})=>({runId:id,status:'COMPLETE',lab:{reports:[report(score,{fetchTime:id==='before'?'2026-10-03T18:00:00Z':'2026-10-03T18:01:00Z',sha256:id,configSettings:{formFactor:'desktop'},...extra})]}});
test('recheck reports same-finding observed repair with bound run IDs',()=>{
 const r=compareAudits(audit('before',0),audit('after',1));assert.equal(r.status,'COMPARED');assert.equal(r.baselineRunId,'before');assert.equal(r.currentRunId,'after');assert.equal(r.changes[0].outcome,'RESOLVED');
});
test('recheck never treats null, absent, errors, or changed versions as proof of repair',()=>{
 for(const after of [audit('after',null),audit('after',1,{runtimeError:{code:'FAILED'}}),audit('after',1,{version:'14'}),audit('after',1,{url:'https://example.com/login'}),{runId:'after',status:'FAILED',lab:{reports:[]}}])assert.equal(compareAudits(audit('before',0),after).changes.length,0);
 assert.equal(compareAudits(null,audit('after',1)),null);
});

test('recheck rejects failed status, same run, stale hashes/times, changed or absent config and errored individual audits',()=>{
 const before=audit('before',0);
 for(const after of [audit('before',1),audit('after',1,{sha256:'before'}),audit('after',1,{fetchTime:'2026-10-03T17:00:00Z'}),audit('after',1,{configSettings:null}),audit('after',1,{configSettings:{formFactor:'mobile'}}),{...audit('after',1),status:'FAILED'},audit('after',1,{observations:[{id:'meta-description',score:1,scoreDisplayMode:'binary',errorMessage:'Collection failed'}]})]) assert.equal(compareAudits(before,after).changes.length,0);
});
