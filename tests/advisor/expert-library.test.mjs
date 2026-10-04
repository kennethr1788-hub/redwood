import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createConversation} from '../../integrations/advisor/engine.mjs';
import {retrieveHelp} from '../../integrations/advisor/knowledge.mjs';
import {parseCheckpoint} from '../../integrations/advisor/continuity.mjs';
import {KNOWLEDGE_DOCUMENTS,LEGACY_TOPIC_ALIASES} from '../../docs/advisor/knowledge.mjs';

const config={projectId:'synthetic-expert',runtimeId:'codex'};
const paths=['core/authority','core/decision','core/handoff','build/verification-debug','build/ux-accessibility',
  'build/performance-security','build/coding-source','studio/story-editing','studio/framing-captions',
  'studio/audio-accessibility','studio/render-delivery','grow/market-principles','grow/paid-acquisition',
  'grow/search-discovery','grow/conversion-retention','grow/learning-measurement','operations/connections','operations/continuity'];

test('the 18 expert cards have compact decision fields, real owner paths, dated scope and no indexed source register',()=>{
  assert.deepEqual(KNOWLEDGE_DOCUMENTS.map(d=>d.path),paths.map(p=>p+'.md'));
  for(const doc of KNOWLEDGE_DOCUMENTS){
    const body=readFileSync(new URL('../../docs/advisor/'+doc.path,import.meta.url),'utf8');
    for(const field of ['TOPIC:','PURPOSE:','WHEN TO USE:','REQUIRED FACTS:','STABLE PRINCIPLES','DECISION TREE',
      'COMMON FAILURE MODES','STOP CONDITIONS','WHAT NOT TO CLAIM','NEXT ACTION / OUTPUT SHAPE','SOURCE STATUS','LAST VERIFIED:','RECHECK TRIGGER:']) assert.ok(body.includes(field),doc.id+': '+field);
    assert.ok(Buffer.byteLength(body)<=6000);assert.ok(!doc.path.startsWith('sources/'));
    for(const source of doc.sourcePaths)assert.ok(existsSync(new URL('../../'+source,import.meta.url)),source);
  }
});

test('all legacy topic IDs reopen in bounded schema-1 continuity without saved answers or state',()=>{
  const original={schemaVersion:1,...config,conversationId:'synthetic-conversation',style:'concise',lastTopicIds:[],unresolvedTopicIds:[]};
  assert.equal(Object.keys(LEGACY_TOPIC_ALIASES).length,18);
  for(const [oldId,id] of Object.entries(LEGACY_TOPIC_ALIASES)){
    const checkpoint=parseCheckpoint(JSON.stringify({...original,lastTopicIds:[oldId],unresolvedTopicIds:[oldId]}),config.projectId);
    assert.deepEqual(checkpoint.lastTopicIds,[id]);assert.deepEqual(checkpoint.unresolvedTopicIds,[id]);
    assert.deepEqual(retrieveHelp('Tell me more',[oldId]).map(d=>d.id),[id]);
  }
  assert.deepEqual(parseCheckpoint(JSON.stringify({...original,lastTopicIds:['integrations.codex','integrations.claude','onboarding.connections']}),config.projectId).lastTopicIds,['operations.connections']);
  assert.throws(()=>parseCheckpoint(JSON.stringify({...original,lastTopicIds:['../../private']}),config.projectId));
});

const cases=[
  ['Why did verification fail?','build','build.verification-debug',/MODEL_FINISHED != BUILD_VERIFIED/],
  ['Is this accessible?','build','build.ux-accessibility',/ACCESSIBILITY_CHECK != LEGAL_COMPLIANCE_CERTIFICATION/],
  ['Why is my site slow?','build','build.performance-security',/SECURITY_GUIDANCE != SECURITY_AUDIT/],
  ['Can you fix this?','build','core.handoff',/Build.*implementation/],
  ['Should I reset Git?','build','build.coding-source',/SOURCE_RESTORE != EXTERNAL_EFFECT_ROLLBACK/],
  ['Why does my demo feel boring?','studio','studio.story-editing',/hypothesis/],
  ['Should I cut the first five seconds?','studio','studio.story-editing',/No universal magic-second/],
  ['Why does portrait crop badly?','studio','studio.framing-captions',/inspect/i],
  ['Are my captions readable?','studio','studio.framing-captions',/accuracy/i],
  ['Is this ready to publish?','studio','studio.render-delivery',/publication/i],
  ['I have $500 for Meta. What should I do?','grow','grow.paid-acquisition',/not spending permission/],
  ['Should I use Google Search or Performance Max?','grow','grow.paid-acquisition',/not the automatic choice/],
  ['What SEO page should I work on next?','grow','grow.search-discovery',/guarantee/i],
  ['How can I improve this landing page?','grow','grow.conversion-retention',/hypothes/i],
  ['CTR rose but conversions are flat. What does that mean?','grow','grow.learning-measurement',/ASSOCIATION != CAUSATION/],
  ['Should I increase budget?','grow','grow.learning-measurement',/does not by itself.*justify more spend/],
  ['Where did I leave off?',null,'operations.continuity',/fresh owner evidence/],
  ['Is Higgsfield connected?',null,'operations.connections',/AUTHENTICATED is not VERIFIED/],
  ['Did export mean this was published?',null,'core.authority',/EXPORTED != PUBLISHED/],
];
for(const [question,product,expected,principle] of cases)test('expert evaluation: '+question,async()=>{
  let request; let calls=0;
  const session=createConversation(config,{transport:{runtimeId:'codex',complete:async value=>{
    calls++;request=value;return {answer:'Synthetic advice: the cause is unverified; inspect the current owner evidence.',nextStep:'Check the supplied current state.',navigateTo:product};
  }}});
  const state=product?{projectId:config.projectId,product,revision:'7',freshness:'UNKNOWN',completionState:'UNKNOWN'}:null;
  const input={question,state,intent:'HELP'};const before=JSON.stringify(input);
  const result=await session.ask(input);
  assert.ok(result.topicIds.includes(expected),JSON.stringify(result.topicIds));
  assert.ok(result.topicIds.length>=1&&result.topicIds.length<=3);
  const docs=retrieveHelp(question,[],{state,supportIntent:result.supportIntent});
  assert.match(docs.find(d=>d.id===expected).body,principle);
  if(question==='Can you fix this?'){
    assert.equal(result.status,'HANDOFF_PREPARED');assert.equal(calls,0);assert.match(result.codingPrompt,/CURRENT EVIDENCE/);
  }else{
    assert.equal(result.status,'ANSWERED');assert.equal(calls,1);
    assert.deepEqual(request.context.currentState,state);assert.equal(request.context.question,question);
    assert.deepEqual(request.context.knowledge.map(d=>d.id),result.topicIds);
    assert.ok(request.context.knowledge.every(d=>!d.path.startsWith('sources/')));
    assert.match(request.system,/separate evidence\s+from hypothesis/);
    assert.match(request.system,/Build owns implementation/);
    assert.match(request.system,/current product state; current matching receipts/);
    assert.match(request.system,/what evidence would change/);
    assert.ok(request.context.knowledge.every(d=>!d.id.includes('elevenlabs')));
    for(const d of request.context.knowledge)if(/ElevenLabs/.test(d.body))assert.match(d.body,/ElevenLabs is (?:not required competition functionality|outside required competition functionality)/);
  }
  assert.equal(result.executionAuthority,'NONE');assert.equal(result.sourceEditAuthority,'NONE');
  assert.equal(JSON.stringify(input),before);
  assert.ok(!session.checkpoint().includes(question));
});

// Distribution scope excludes internal maintenance-provenance verification.
