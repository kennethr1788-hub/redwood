import test from 'node:test';
import assert from 'node:assert/strict';
import {askAdvisor, currentProjection, advisorProjects} from '../advisor-host.mjs';
import {supportDoctor} from '../../integrations/connectors/support-doctor.mjs';
import {createAdvisor} from '../../integrations/advisor/index.mjs';
const doctor = () => supportDoctor(new Date().toISOString());
const input = (extra = {}) => ({product:'studio',projectId:'project-1',runtimeId:'codex',question:'Why is my Studio render stale?',intent:'HELP',checkpoint:null,...extra});

test('Present and legacy Studio ask the same fresh studio owner and display Present', async () => {
  let checkpoint=null;
  for (const question of ['Why is Present stale?', 'Why is Studio stale?']) {
    const calls=[];
    const answer=await askAdvisor(input({question,checkpoint}),async (product,route)=>{
      calls.push([product,route]);
      return {studio:{id:'project-1',revision:3},exports:[{stale:true}]};
    },doctor());
    assert.deepEqual(calls,[['studio','/api/projects/project-1']]);
    assert.equal(answer.reply.currentState.product,'studio');
    assert.equal(answer.reply.currentState.completionState,'STALE');
    assert.match(answer.reply.answerContract.whatFailed,/Present/);
    assert.doesNotMatch(answer.reply.answerContract.whatFailed,/Studio/);
    assert.equal(JSON.parse(answer.checkpoint).projectId,'studio.project-1');
    assert.equal(answer.reply.modelCalls,0);
    if (checkpoint) assert.equal(answer.reply.conversationId,JSON.parse(checkpoint).conversationId);
    checkpoint=answer.checkpoint;
  }
});

test('live Studio stale overrides older discussion and is fetched on every question', async () => {
  let stale=false, calls=0;
  const owner=async (product, route)=> {calls++;assert.equal(product,'studio');assert.equal(route,'/api/projects/project-1');return {studio:{id:'project-1',revision:2},exports:[{stale}]};};
  const old=await askAdvisor(input(),owner,doctor());
  assert.equal(old.reply.currentState.completionState,'RENDERED');
  stale=true;
  const fresh=await askAdvisor(input({checkpoint:old.checkpoint}),owner,doctor());
  assert.equal(fresh.reply.currentState.completionState,'STALE');
  assert.match(fresh.reply.answerContract.whatFailed,/STALE/);
  assert.equal(fresh.reply.conversationId,old.reply.conversationId); assert.equal(calls,2);
  assert.equal(fresh.reply.modelCalls,0); assert.equal(fresh.reply.executionAuthority,'NONE');
  const c=JSON.parse(fresh.checkpoint);
  assert.deepEqual(Object.keys(c).sort(),['conversationId','lastTopicIds','projectId','runtimeId','schemaVersion','style','unresolvedTopicIds']);
  assert.ok(!fresh.checkpoint.includes('CURRENT')&&!fresh.checkpoint.includes('STALE'));
});
test('integrated Doctor UNKNOWN supersedes older pending discussion',async()=>{
  const old=createAdvisor({projectId:'studio.project-1',runtimeId:'codex'});
  await old.ask({question:'Higgsfield is pending'});
  const answer=await askAdvisor(input({question:'Can I use Higgsfield?',checkpoint:old.checkpoint()}),async()=>{throw Error('offline');},doctor());
  assert.equal(answer.reply.currentState,null);
  assert.match(answer.reply.answerContract.whatFailed,/support is available/i);
  assert.match(answer.reply.answerContract.whatFailed,/not been checked|UNKNOWN/i);
  assert.equal(answer.mediaIntegration,'OFFLINE_QUALIFIED');
  assert.equal(answer.reply.modelCalls,0);
});
test('forged state, observations and transport cannot enter through host API',async()=>{
  for(const field of ['state','doctor','liveContext','transport','qualified']) await assert.rejects(askAdvisor(input({[field]:{}}),async()=>assert.fail(),doctor()));
  await assert.rejects(askAdvisor(input({projectId:'../secret'}),async()=>assert.fail(),doctor()));
});
test('offline or mismatched owner discards cached state; project checkpoint cannot cross selection',async()=>{
  const first=await askAdvisor(input(),async()=>({studio:{id:'project-1',revision:1},exports:[]}),doctor());
  const answer=await askAdvisor(input({projectId:'project-2',checkpoint:first.checkpoint}),async()=>({studio:{id:'project-1',revision:1},exports:[]}),doctor());
  assert.equal(answer.reply.currentState,null);assert.notEqual(answer.reply.conversationId,first.reply.conversationId);
  assert.equal(JSON.parse(answer.checkpoint).projectId,'studio.project-2');
});
test('Codex only, Claude only and no-provider guidance stay closed; prompts never execute',async()=>{
  for(const runtimeId of ['codex','claude',null]){
    const answer=await askAdvisor(input({runtimeId,projectId:null,intent:'PREPARE_CODING_PROMPT',question:'Help me understand the next local repair'}),async()=>assert.fail(),doctor());
    assert.equal(answer.reply.runtimeId,runtimeId);assert.equal(answer.reply.modelCalls,0);
    assert.equal(answer.reply.status,runtimeId?'BRIDGE_UNAVAILABLE':'SETUP_REQUIRED');
    assert.match(answer.reply.codingPrompt,/Prompt to review and copy/);
  }
});
test('blocked builder actions cannot alter state and unknown Grow stays unknown',async()=>{
  const calls=[];
  const answer=await askAdvisor(input({product:'grow',question:'Mark my project complete'}),async (p,r)=>{
    calls.push(r);return {projectId:'project-1',product:'grow',revision:'r1',freshness:'UNKNOWN',completionState:'UNKNOWN'};
  },doctor());
  assert.equal(answer.reply.status,'BLOCKED');assert.equal(answer.reply.currentState.completionState,'UNKNOWN');
  assert.deepEqual(calls,['/api/projects/project-1/advisor-context']);
});
test('project listing exports only bounded navigation fields, and no selected project means no owner read',async()=>{
  assert.deepEqual(await advisorProjects('grow',async()=>[{id:'project-1',name:'Example',workspacePath:'/private',status:'PASSED'}]),[{id:'project-1',name:'Example'}]);
  await assert.rejects(advisorProjects('grow',async()=>[{id:null,name:'Invalid selection'}]));
  assert.deepEqual(await currentProjection('build',null,async()=>assert.fail()),{state:null,receipt:null});
});
