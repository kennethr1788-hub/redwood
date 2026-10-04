import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {createCodexTransport, codexAnswerStream, codexEnvironment, runCodexProcess, sanitizeNativeFailure, codexArguments} from '../../integrations/advisor/codex.mjs';
import {askAdvisor} from '../../launcher/advisor-host.mjs';
import {supportDoctor} from '../../integrations/connectors/support-doctor.mjs';

const answer = {answer: 'Present is stale because the saved revision changed. Your source remains valid.',
  nextStep: 'Review the latest edits, then render again in Present.', navigateTo: 'studio'};
const question = {product: 'studio', projectId: 'synthetic', runtimeId: 'codex',
  question: 'Why is Present stale, and what should I do next?', intent: 'HELP', checkpoint: null};
const doctor = () => supportDoctor('2026-10-04T12:00:00.000Z');
const owner = async () => ({studio: {id: 'synthetic', revision: 7}, exports: [{stale: true}]});
const emit = (onEvent, value = answer) => {
  onEvent({type: 'thread.started'}); onEvent({type: 'turn.started'});
  onEvent({type: 'item.completed', item: {type: 'agent_message', text: JSON.stringify(value)}});
  onEvent({type: 'turn.completed'});
};
function nativeFixture({mode = 'success'} = {}) {
  const calls = []; let cwd; let context;
  const execute = async (executable, argv, options) => {
    calls.push(argv); cwd = options.cwd;
    if (argv[0] === '--version') return {exitCode: 0, stdout: 'codex-cli 0.159.2\n', stderr: ''};
    if (argv[0] === 'login') return {exitCode: 0, stdout: '', stderr: mode === 'api' ? 'Logged in using an API key' : 'Logged in using ChatGPT'};
    assert.equal(executable, 'codex');
    assert.equal(argv[argv.indexOf('--sandbox') + 1], 'read-only');
    assert.equal(argv[argv.indexOf('-a') + 1], 'never');
    assert.equal(argv[argv.indexOf('-C') + 1], cwd);
    for (const flag of ['--no-daemon','--ignore-user-config','--ignore-rules','--ephemeral','--output-schema']) assert.ok(argv.includes(flag));
    for (const value of ['web_search="disabled"','forced_login_method="chatgpt"','mcp_servers={}','shell_tool','apps','plugins','hooks','multi_agent']) assert.ok(argv.includes(value));
    assert.ok(!argv.some(value => value.startsWith('model_providers.openai.')), 'native built-in providers cannot be overridden');
    assert.ok(!cwd.includes('products/')); assert.ok(!existsSync(cwd + '/.git'));
    const schema = JSON.parse(readFileSync(cwd + '/answer.schema.json', 'utf8')); assert.equal(schema.additionalProperties, false);
    context = JSON.parse(options.input.slice(options.input.lastIndexOf('\n') + 1));
    if (mode === 'missing') throw Error('private native failure');
    if (mode === 'timeout') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')), {once: true}));
    emit(options.onEvent, mode === 'oversized' ? {...answer, answer: 'x'.repeat(2401)} : answer);
    return {exitCode: 0};
  };
  return {transport: createCodexTransport({execute, env: {HOME: '/synthetic-native-home', PATH: '/synthetic-bin', OPENAI_API_KEY: 'inert-canary'}}),
    calls, context: () => context, cwd: () => cwd};
}

test('Codex transport invokes one native request with current state, <=3 docs and separate read-only cwd', async () => {
  const fixture = nativeFixture(); const q = structuredClone(question); const before = JSON.stringify(q);
  const result = await askAdvisor(q, owner, doctor(), {transport: fixture.transport});
  assert.equal(fixture.calls.filter(a => a.includes('exec')).length, 1);
  assert.equal(result.reply.answerSource, 'CODEX'); assert.equal(result.reply.answer, answer.answer);
  assert.equal(fixture.context().currentState.completionState, 'STALE');
  assert.equal(fixture.context().currentState.revision, '7');
  assert.deepEqual(fixture.context().knowledge.map(d => d.id), ['studio.render-delivery','core.authority']);
  assert.equal(JSON.stringify(q), before); assert.equal(existsSync(fixture.cwd()), false);
  assert.equal(result.reply.sourceEditAuthority, 'NONE'); assert.equal(result.reply.executionAuthority, 'NONE');
});

test('native child environment excludes API keys, billing overrides, shell hooks and SSH agents', () => {
  assert.deepEqual(codexEnvironment({HOME:'/native-home',PATH:'/bin',OPENAI_API_KEY:'inert',CODEX_HOME:'/other',
    NODE_OPTIONS:'inert',HTTPS_PROXY:'inert',SSH_AUTH_SOCK:'inert'}), {HOME:'/native-home',PATH:'/bin'});
});

for (const mode of ['missing','api','oversized','timeout']) test(`${mode} native runtime returns useful local help without a second provider`, async () => {
  const f = nativeFixture({mode});
  const result = await askAdvisor(question, owner, doctor(), {transport:f.transport, timeoutMs:30});
  assert.equal(result.reply.answerSource, 'LOCAL'); assert.equal(result.reply.currentState.completionState, 'STALE');
  assert.match(result.reply.answer, /local Advisor help/i); assert.match(result.reply.answer, /stale/i);
  assert.ok(f.calls.filter(a => a.includes('exec')).length <= 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(f.cwd()), false);
});

test('fix this prepares a structured Build handoff; how do I fix this stays advice', async () => {
  const f = nativeFixture();
  const handoff = await askAdvisor({...question, question:'Can you fix this?'}, owner, doctor(), {transport:f.transport});
  assert.equal(handoff.reply.status,'HANDOFF_PREPARED'); assert.equal(handoff.reply.modelCalls,0); assert.equal(f.calls.length,0);
  for (const heading of ['OBJECTIVE','CURRENT EVIDENCE','OBSERVED FAILURE','CHANGE','PRESERVE','CONSTRAINTS','ACCEPTANCE','STOP CONDITIONS','OUTPUT']) assert.ok(handoff.reply.codingPrompt.includes(heading));
  assert.match(handoff.reply.codingPrompt,/STALE/); assert.match(handoff.reply.answer,/Build task/);
  const advice = await askAdvisor({...question, question:'How do I fix this stale Present render?'},owner,doctor(),{transport:f.transport});
  assert.equal(advice.reply.status,'ANSWERED'); assert.equal(advice.reply.codingPrompt,null);
});

test('native answer does not enter continuity; reopen rereads owner state and keeps one role', async () => {
  const f = nativeFixture();
  const first = await askAdvisor(question,owner,doctor(),{transport:f.transport});
  assert.ok(!first.checkpoint.includes(answer.answer)); assert.ok(!first.checkpoint.includes('STALE'));
  const reopened = await askAdvisor({...question,checkpoint:first.checkpoint},async()=>({studio:{id:'synthetic',revision:8},exports:[]}),doctor(),{transport:f.transport});
  assert.equal(reopened.reply.roleId,'advisor'); assert.equal(reopened.reply.conversationId,first.reply.conversationId);
  assert.equal(reopened.reply.currentState.completionState,'NOT_RUN');
});

test('native stream drops reasoning and rejects invalid shape, oversized answers and implementation events', () => {
  const stream=codexAnswerStream(); stream.consume({type:'item.completed',item:{type:'reasoning',text:'inert hidden canary'}}); emit(stream.consume,answer);
  assert.deepEqual(stream.finish(),answer);
  for (const value of [{...answer,tool_calls:[]},{...answer,answer:'x'.repeat(2401)}]) assert.throws(()=>emit(codexAnswerStream().consume,value));
  assert.throws(()=>codexAnswerStream().consume({type:'item.started',item:{type:'command_execution',command:'inert'}}));
});

test('real process supervisor times out, reaps its own PID and returns no late answer', async () => {
  let failed;
  try { await runCodexProcess(process.execPath,['-e','setTimeout(()=>{},30000)'],{cwd:process.cwd(),env:{},timeoutMs:50}); }
  catch(e) { failed=e; }
  assert.equal(failed.code,'TIMED_OUT'); assert.ok(failed.process.pid>0);
  assert.throws(()=>process.kill(failed.process.pid,0),{code:'ESRCH'});
});

test('real process supervisor aborts and refuses oversized streams without leaking raw output', async () => {
  const controller = new AbortController();
  const pending = runCodexProcess(process.execPath,['-e','setTimeout(()=>{},30000)'],{cwd:process.cwd(),env:{},signal:controller.signal});
  controller.abort(); await assert.rejects(pending,{code:'CANCELLED'});
  await assert.rejects(runCodexProcess(process.execPath,['-e','process.stdout.write("x".repeat(140000))'],{cwd:process.cwd(),env:{}}),{code:'OUTPUT_LIMIT'});
});

test('only one native process can be active across launcher requests', async () => {
  const f=nativeFixture({mode:'timeout'});
  const first=askAdvisor(question,owner,doctor(),{transport:f.transport,timeoutMs:40});
  await new Promise(resolve=>setTimeout(resolve,10));
  const second=await askAdvisor(question,owner,doctor(),{transport:f.transport});
  assert.equal(second.reply.answerSource,'LOCAL');
  await first; assert.equal(f.calls.filter(a=>a.includes('exec')).length,1);
});

test('qualified startup flags use the canonical feature and suppress only the known unstable-feature warning', () => {
  const argv = codexArguments('/synthetic-session');
  assert.ok(!argv.includes('imagegenext'));
  for (const flag of ['image_generation', 'features.skip_host_skill_discovery=true', 'suppress_unstable_features_warning=true']) assert.ok(argv.includes(flag));
});

test('native failure sanitizer keeps useful classification, removes sensitive fields and strictly bounds bytes', () => {
  const failure = sanitizeNativeFailure({type:'turn.failed', error:{code:'unsupported_feature',
    message:'skip_host_skill_discovery failed at /Users/private-user/.codex/config.toml C:\\Users\\private\\file token=short-secret Authorization: Bearer private-token https://example.invalid/signed?key=private-key wss://example.invalid/private api_key="private-key" '+ '界'.repeat(500)},
    reasoning:'hidden reasoning', context:'hidden context', env:{HOME:'private home'}});
  assert.equal(failure.kind,'TURN_FAILED');
  assert.match(failure.message,/unsupported_feature.*skip_host_skill_discovery/);
  assert.ok(Buffer.byteLength(failure.message)<=768);
  assert.doesNotMatch(JSON.stringify(failure),/private|hidden|example\.invalid|Users|config\.toml/);
  assert.deepEqual(Object.keys(failure),['kind','message']);
  const secretPrompt='Why is my private synthetic project stale?';
  assert.equal(sanitizeNativeFailure({message:'Rejected: '+secretPrompt},secretPrompt).message,'[CONTEXT_ECHO_WITHHELD]');
  for (const event of [{type:'error',message:'Unsupported setting'}, {type:'turn.failed',error:{message:'Unsupported setting'}},
    {type:'item.completed',item:{type:'error',message:'Unsupported setting'}}]) {
    assert.throws(()=>codexAnswerStream().consume(event), e=>e.code==='NATIVE_ERROR'&&e.nativeFailure.message==='Unsupported setting');
  }
});

test('sanitized native failure survives group-signal failure and child teardown', async t => {
  const stream=codexAnswerStream();
  const original=process.kill;
  t.mock.method(process,'kill',()=>{throw Error('synthetic group signal failure');});
  let failed;
  try {
    await runCodexProcess(process.execPath,['-e',`process.on('SIGTERM',()=>{}); console.log(JSON.stringify({type:'error',message:'Invalid setting at /private/secret'})); setTimeout(()=>{},30000);`],
      {cwd:process.cwd(),env:{},onEvent:stream.consume,timeoutMs:2000});
  }catch(e){failed=e;}finally{t.mock.restoreAll();}
  assert.equal(failed.code,'INVALID_NATIVE_OUTPUT');
  assert.deepEqual(failed.nativeFailure,{kind:'NATIVE_ERROR',message:'Invalid setting at [PATH]'});
  assert.ok(failed.process.pid>0); assert.equal(failed.process.signal,'SIGKILL');
  assert.throws(()=>original(failed.process.pid,0),{code:'ESRCH'});
});
