import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdvisor, reopenAdvisor, retrieveHelp, LIMITS } from '../../integrations/advisor/index.mjs';
import { createConversation } from '../../integrations/advisor/engine.mjs';
import { KNOWLEDGE_VERSION, KNOWLEDGE_DOCUMENTS } from '../../docs/advisor/knowledge.mjs';

// These tests exercise synthetic, inert transports only. They do not qualify a
// native CLI bridge, contact a provider, or authorize any product action.
const baseConfig = { projectId: 'project-1', runtimeId: 'codex' };
const goodReply = () => ({
  answer: 'Open Build and inspect the current project checks.',
  nextStep: 'Review the latest project state before preparing a change.',
  navigateTo: 'build',
});
const state = (overrides = {}) => ({
  projectId: 'project-1', product: 'build', revision: 'revision-1',
  freshness: 'CURRENT', completionState: 'CURRENT_CHECKS_PASS_NO_FLOW', ...overrides,
});
function fixture({ runtimeId = 'codex', complete, timeoutMs = 250 } = {}) {
  const requests = [];
  const transport = {
    runtimeId,
    async complete(request, options) {
      requests.push({ request, options });
      return complete ? complete(request, options) : goodReply();
    },
  };
  return {
    session: createConversation({ ...baseConfig, runtimeId }, { transport, timeoutMs }),
    requests,
  };
}
function assertAdvice(result, status, calls) {
  assert.equal(typeof result, 'object');
  assert.equal(Array.isArray(result), false);
  assert.equal(result.role, 'assistant');
  assert.equal(result.roleId, 'advisor');
  assert.equal(result.displayName, 'Redwood Advisor');
  assert.equal(result.status, status);
  assert.equal(result.modelCalls, calls);
  assert.equal(result.trust, 'UNVERIFIED_ADVICE');
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(result.sourceEditAuthority, 'NONE');
  assert.equal(typeof result.answer, 'string');
  assert.equal(typeof result.conversationId, 'string');
  assert.ok(result.conversationId.length > 0);
  assert.ok(Array.isArray(result.topicIds));
  assert.ok(result.topicIds.length <= LIMITS.retrievedSections);
}
function checkpoint(session) {
  const serialized = session.checkpoint();
  assert.equal(typeof serialized, 'string');
  const value = JSON.parse(serialized);
  assert.deepEqual(Object.keys(value).sort(), [
    'schemaVersion', 'projectId', 'conversationId', 'runtimeId', 'style',
    'lastTopicIds', 'unresolvedTopicIds',
  ].sort());
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.projectId, 'project-1');
  assert.ok(['concise', 'step-by-step'].includes(value.style));
  assert.ok(Array.isArray(value.lastTopicIds));
  assert.ok(Array.isArray(value.unresolvedTopicIds));
  return { serialized, value };
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('one accepted turn produces one advisor answer from exactly one transport call', async () => {
  const { session, requests } = fixture();
  const result = await session.ask({ question: 'How do I check a Build project?', state: state() });
  assertAdvice(result, 'ANSWERED', 1);
  assert.equal(requests.length, 1);
  assert.equal(result.answer, goodReply().answer);
  assert.equal(result.runtimeId, 'codex');
  assert.equal(result.navigateTo, 'build');
  assert.equal(result.codingPrompt, null);
  assert.deepEqual(result.currentState, state());
  const { request } = requests[0];
  assert.equal(request.schemaVersion, 1);
  assert.equal(request.conversationId, result.conversationId);
  assert.equal(request.runtimeId, 'codex');
  assert.equal(typeof request.requestId, 'string');
  assert.equal(typeof request.system, 'string');
  assert.equal(request.context.question, 'How do I check a Build project?');
  assert.equal(request.context.intent, 'HELP');
  assert.deepEqual(request.context.currentState, state());
  assert.ok(Buffer.byteLength(JSON.stringify(request.context)) <= LIMITS.contextBytes);
});

for (const runtimeId of ['codex', 'claude']) {
  test(`${runtimeId} remains the only selected runtime across accepted turns`, async () => {
    const { session, requests } = fixture({ runtimeId });
    const first = await session.ask({ question: 'Help me use Build.' });
    const second = await session.ask({ question: 'Help me use Studio.' });
    assertAdvice(first, 'ANSWERED', 1);
    assertAdvice(second, 'ANSWERED', 1);
    assert.equal(first.runtimeId, runtimeId);
    assert.equal(second.runtimeId, runtimeId);
    assert.equal(first.conversationId, second.conversationId);
    assert.equal(requests.length, 2);
    assert.ok(requests.every(({ request }) => request.runtimeId === runtimeId));
    assert.notEqual(requests[0].request.requestId, requests[1].request.requestId);
  });
}

test('production factory reports missing setup and unavailable bridges with zero calls', async () => {
  for (const [runtimeId, expected] of [[null, 'SETUP_REQUIRED'], ['codex', 'BRIDGE_UNAVAILABLE'], ['claude', 'BRIDGE_UNAVAILABLE']]) {
    const session = createAdvisor({ ...baseConfig, runtimeId });
    const result = await session.ask({ question: 'How do I begin?' });
    assertAdvice(result, expected, 0);
    assert.equal(result.runtimeId, runtimeId);
    assert.equal(result.codingPrompt, null);
    checkpoint(session);
  }
});

test('production configuration cannot supply a transport, ready flag, executable, or arbitrary configuration', () => {
  const injected = { runtimeId: 'codex', complete: async () => goodReply() };
  for (const extra of [
    { transport: injected }, { ready: true }, { executable: '/synthetic/bin/runtime' },
    { command: 'synthetic-command' }, { credentials: 'synthetic-only' }, { model: 'synthetic-model' },
  ]) {
    assert.throws(() => createAdvisor({ ...baseConfig, ...extra }));
  }
  assert.throws(() => createAdvisor(baseConfig, { transport: injected }));
  for (const runtimeId of ['fallback', 'auto', 'grok', 'codex,claude']) {
    assert.throws(() => createAdvisor({ ...baseConfig, runtimeId }));
  }
});

test('internal inert transport must match the explicitly selected runtime', () => {
  assert.throws(() => createConversation(baseConfig, {
    transport: { runtimeId: 'claude', complete: async () => goodReply() },
  }));
});

test('retrieval is deterministic, bounded, source-attributed and has an onboarding fallback', () => {
  for (const question of [
    'How do I start?', 'How does Build verification work?', 'How do I render in Studio?',
    'How do I export in Grow?', 'How do I connect Codex or Claude?', 'zxqv unidentified topic',
  ]) {
    const first = retrieveHelp(question);
    assert.deepEqual(retrieveHelp(question), first);
    assert.ok(first.length >= 1 && first.length <= LIMITS.retrievedSections);
    assert.equal(new Set(first.map(topic => topic.id)).size, first.length);
    for (const topic of first) {
      assert.deepEqual(Object.keys(topic).sort(), ['id', 'title', 'body', 'sourcePaths', 'path'].sort());
      assert.equal(typeof topic.id, 'string');
      assert.equal(typeof topic.title, 'string');
      assert.equal(typeof topic.body, 'string');
      assert.ok(topic.body.length > 0);
      assert.ok(topic.body.length <= LIMITS.sectionChars);
      assert.ok(Array.isArray(topic.sourcePaths));
      assert.ok(topic.sourcePaths.length > 0);
      assert.ok(topic.sourcePaths.every(path => typeof path === 'string' && !path.startsWith('/') && !path.includes('..')));
    }
  }
  assert.deepEqual(retrieveHelp('zxqv unidentified topic').map(d => d.id), ['operations.continuity']);
});

test('the source-owned help index has an explicit version and bounded document metadata without bodies', () => {
  assert.equal(typeof KNOWLEDGE_VERSION, 'string');
  assert.ok(KNOWLEDGE_VERSION.trim().length > 0);
  assert.ok(KNOWLEDGE_DOCUMENTS.length > 0 && KNOWLEDGE_DOCUMENTS.length <= 24);
  assert.ok(Buffer.byteLength(JSON.stringify(KNOWLEDGE_DOCUMENTS)) <= LIMITS.corpusBytes);
  assert.equal(new Set(KNOWLEDGE_DOCUMENTS.map(document => document.id)).size, KNOWLEDGE_DOCUMENTS.length);
  for (const document of KNOWLEDGE_DOCUMENTS) {
    assert.deepEqual(Object.keys(document).sort(), ['id', 'title', 'path', 'sourcePaths'].sort());
    assert.equal('body' in document, false);
  }
});

test('maximum-length Unicode questions stay within the context byte budget', async () => {
  const { session, requests } = fixture();
  const result = await session.ask({ question: '界'.repeat(LIMITS.questionChars), state: state() });
  assertAdvice(result, 'ANSWERED', 1);
  assert.equal(requests.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(requests[0].request.context)) <= LIMITS.contextBytes);
  assert.ok(result.answer.length <= LIMITS.answerChars);
  assert.ok(result.nextStep.length <= LIMITS.nextStepChars);
});

test('current state replaces earlier discussion state and model prose never enters continuity', async () => {
  const marker = 'SYNTHETIC_PRIOR_MODEL_PROSE_47';
  const { session, requests } = fixture({ complete: async () => ({ ...goodReply(), answer: marker }) });
  const oldState = state({ revision: 'old-revision', completionState: 'CURRENT_PASS' });
  const newState = state({ revision: 'new-revision', freshness: 'STALE', completionState: 'STALE' });
  await session.ask({ question: 'OLD_DISCUSSION_47 How do I verify Build?', state: oldState });
  const result = await session.ask({ question: 'What should I do next?', state: newState });
  assertAdvice(result, 'ANSWERED', 1);
  assert.deepEqual(result.currentState, newState);
  assert.deepEqual(requests[1].request.context.currentState, newState);
  const secondContext = JSON.stringify(requests[1].request.context);
  assert.equal(secondContext.includes(marker), false);
  assert.equal(secondContext.includes('OLD_DISCUSSION_47'), false);
  assert.equal(secondContext.includes('old-revision'), false);
  assert.equal('transcript' in requests[1].request.context, false);
  const stored = checkpoint(session).serialized;
  assert.equal(stored.includes(marker), false);
  assert.equal(stored.includes('OLD_DISCUSSION_47'), false);
  assert.equal(stored.includes('new-revision'), false);
});

test('an omitted current state does not reuse an earlier state as current evidence', async () => {
  const { session, requests } = fixture();
  await session.ask({ question: 'Check the Build status.', state: state() });
  const result = await session.ask({ question: 'What is the current status?' });
  assertAdvice(result, 'ANSWERED', 1);
  assert.equal(result.currentState, null);
  assert.equal(requests[1].request.context.currentState, null);
});

test('preparing a coding prompt is text only and retains no execution or source-edit authority', async () => {
  const { session, requests } = fixture();
  const result = await session.ask({
    question: 'Prepare a coding prompt to improve the project heading.',
    intent: 'PREPARE_CODING_PROMPT', state: state(),
  });
  assertAdvice(result, 'ANSWERED', 1);
  assert.equal(requests.length, 1);
  assert.equal(typeof result.codingPrompt, 'string');
  assert.ok(result.codingPrompt.length > 0);
  assert.ok(result.codingPrompt.length <= LIMITS.promptChars);
  assert.equal(requests[0].request.context.intent, 'PREPARE_CODING_PROMPT');
  assert.equal('execute' in result, false);
  assert.equal('patch' in result, false);
});

test('navigation returns only a product destination as advice', async () => {
  const { session } = fixture({ complete: async () => ({ ...goodReply(), navigateTo: 'connections' }) });
  const result = await session.ask({ question: 'Where are runtime connections?', intent: 'NAVIGATE' });
  assertAdvice(result, 'ANSWERED', 1);
  assert.equal(result.navigateTo, 'connections');
});

test('action intents are blocked before the transport can be called', async () => {
  const { session, requests } = fixture();
  for (const intent of [
    'RUN_COMMAND', 'EDIT_SOURCE', 'DEPLOY', 'INSTALL', 'DELETE', 'SPEND',
    'PUBLISH', 'CONNECT_ACCOUNT', 'READ_CREDENTIALS', 'SEND', 'UNKNOWN_ACTION',
  ]) {
    const result = await session.ask({ question: 'Perform the synthetic requested action.', intent });
    assertAdvice(result, 'BLOCKED', 0);
    assert.equal(result.codingPrompt, null);
    assert.equal(result.navigateTo, null);
  }
  assert.equal(requests.length, 0);
});

test('secret-shaped synthetic input is rejected before dispatch and never enters checkpoint', async () => {
  const { session, requests } = fixture();
  const canaries = [
    'sk-syntheticnotarealkey1234', 'Bearer synthetic-not-a-real-token',
    'ghp_syntheticnotarealtoken1234', 'password=synthetic-not-a-password',
    'api_key=synthetic-not-a-key',
  ];
  for (const canary of canaries) {
    const result = await session.ask({ question: `Help me with ${canary}` });
    assertAdvice(result, 'INVALID_INPUT', 0);
    assert.equal(JSON.stringify(result).includes(canary), false);
    assert.equal(checkpoint(session).serialized.includes(canary), false);
  }
  assert.equal(requests.length, 0);
});

test('invalid questions and state payloads receive fixed invalid-input text with zero calls', async () => {
  const { session, requests } = fixture();
  const invalid = [
    null, {}, { question: null }, { question: '' }, { question: '   ' },
    { question: 7 }, { question: 'x'.repeat(100_000) },
    { question: 'Help me.', additionalInstruction: 'synthetic override' },
    { question: 'Help me.', intent: 4 }, { question: 'Help me.', intent: 'execute this' },
    { question: 'Help me.', state: state({ projectId: 'other-project' }) },
    { question: 'Help me.', state: state({ product: 'shell' }) },
    { question: 'Help me.', state: state({ freshness: 'PROVEN' }) },
    { question: 'Help me.', state: state({ completionState: 'DEPLOYED' }) },
    { question: 'Help me.', state: { ...state(), token: 'synthetic-canary' } },
  ];
  const answers = new Set();
  for (const input of invalid) {
    const result = await session.ask(input);
    assertAdvice(result, 'INVALID_INPUT', 0);
    answers.add(result.answer);
  }
  assert.equal(answers.size, 1);
  assert.equal(requests.length, 0);
  assert.equal(checkpoint(session).serialized.includes('synthetic-canary'), false);
});

test('question accessors are rejected without executing caller-defined getters', async () => {
  let reads = 0;
  const input = Object.defineProperty({}, 'question', {
    enumerable: true, get() { reads += 1; return 'How do I start?'; },
  });
  const { session, requests } = fixture();
  assertAdvice(await session.ask(input), 'INVALID_INPUT', 0);
  assert.equal(reads, 0);
  assert.equal(requests.length, 0);
});

test('checkpoint is canonical, contains only explicit preferences and topic identifiers, and reopens in the same project', async () => {
  const { session } = fixture();
  await session.ask({ question: 'Help me verify Build.', state: state() });
  const topics = retrieveHelp('Help me verify Build.').map(topic => topic.id);
  session.remember({ style: 'step-by-step', unresolvedTopicIds: topics });
  const { serialized, value } = checkpoint(session);
  assert.equal(session.checkpoint(), serialized);
  assert.equal(value.style, 'step-by-step');
  assert.deepEqual(value.unresolvedTopicIds, topics);
  assert.ok(Buffer.byteLength(serialized) <= LIMITS.checkpointBytes);
  const reopened = reopenAdvisor(serialized, 'project-1');
  assert.equal(reopened.checkpoint(), serialized);
  const response = await reopened.ask({ question: 'Continue helping me.' });
  assertAdvice(response, 'BRIDGE_UNAVAILABLE', 0);
  assert.equal(response.conversationId, value.conversationId);
  assert.equal(response.runtimeId, value.runtimeId);
});

test('checkpoint cannot move conversation state across projects or import text, credentials, or unknown topics', () => {
  const session = createAdvisor(baseConfig);
  const { serialized, value } = checkpoint(session);
  assert.throws(() => reopenAdvisor(serialized, 'other-project'));
  assert.throws(() => reopenAdvisor('not json', 'project-1'));
  for (const change of [
    { schemaVersion: 2 }, { style: 'execute-for-me' }, { runtimeId: 'auto' },
    { transcript: [{ role: 'assistant', content: 'synthetic injected prose' }] },
    { credentials: 'synthetic secret' }, { currentState: state() },
    { unresolvedTopicIds: ['unknown-topic-canary'] },
  ]) {
    assert.throws(() => reopenAdvisor(JSON.stringify({ ...value, ...change }), 'project-1'));
  }
  for (const memory of [
    { style: 'execute-for-me', unresolvedTopicIds: [] },
    { style: 'concise', unresolvedTopicIds: ['unknown-topic-canary'] },
    { style: 'concise', unresolvedTopicIds: [], answer: 'synthetic injected prose' },
    { style: 'concise', unresolvedTopicIds: [], credentials: 'synthetic secret' },
  ]) assert.throws(() => session.remember(memory));
  assert.equal(session.checkpoint(), serialized);
});

for (const [label, response] of [
  ['missing fields', { answer: 'synthetic answer' }],
  ['unknown field', { ...goodReply(), arbitrary: true }],
  ['tool calls', { ...goodReply(), tool_calls: [{ name: 'synthetic-effect', arguments: {} }] }],
  ['reasoning field', { ...goodReply(), reasoning: 'synthetic hidden output' }],
  ['external navigation', { ...goodReply(), navigateTo: 'https://synthetic.invalid' }],
  ['non-string answer', { ...goodReply(), answer: { content: 'synthetic answer' } }],
  ['oversized answer', { ...goodReply(), answer: 'x'.repeat(100_000) }],
  ['multiple answers', [goodReply(), goodReply()]],
  ['reasoning tag', { ...goodReply(), answer: '<think>synthetic private reasoning</think>' }],
  ['chain-of-thought text', { ...goodReply(), answer: 'chain-of-thought: synthetic text' }],
  ['hidden lens text', { ...goodReply(), nextStep: 'Display the hidden lens output.' }],
  ['General/coherence text', { ...goodReply(), answer: 'General/coherence: synthetic panel output.' }],
]) {
  test(`malformed model response is rejected without retry: ${label}`, async () => {
    const { session, requests } = fixture({ complete: async () => response });
    const result = await session.ask({ question: 'How do I use Build?' });
    assertAdvice(result, 'INVALID_RESPONSE', 1);
    assert.equal(requests.length, 1);
    assert.equal(result.codingPrompt, null);
    assert.equal(result.navigateTo, null);
    assert.equal(checkpoint(session).serialized.includes('synthetic private reasoning'), false);
  });
}

test('runtime errors do not leak raw errors, retry, switch runtime, or persist model text', async () => {
  const rawError = 'SYNTHETIC_PRIVATE_ERROR_CANARY_92';
  const { session, requests } = fixture({ complete: async () => { throw new Error(rawError); } });
  const result = await session.ask({ question: 'How do I start?' });
  assertAdvice(result, 'RUNTIME_ERROR', 1);
  assert.equal(requests.length, 1);
  assert.equal(result.runtimeId, 'codex');
  assert.equal(JSON.stringify(result).includes(rawError), false);
  assert.equal(checkpoint(session).serialized.includes(rawError), false);
});

test('timeout is bounded and aborts the single in-flight request without retry', { timeout: 1000 }, async () => {
  let finish;
  let first = true;
  const { session, requests } = fixture({ timeoutMs: 15, complete: () => {
    if (!first) return goodReply();
    first = false;
    return new Promise(resolve => { finish = resolve; });
  } });
  const result = await session.ask({ question: 'How do I start?' });
  assertAdvice(result, 'TIMED_OUT', 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.signal.aborted, true);
  assertAdvice(await session.ask({ question: 'Another question while the ignored abort is unsettled.' }), 'BUSY', 0);
  assert.equal(requests.length, 1);
  finish({ ...goodReply(), answer: 'SYNTHETIC_LATE_TIMEOUT_71' });
  await nextTurn();
  assert.equal(checkpoint(session).serialized.includes('SYNTHETIC_LATE_TIMEOUT_71'), false);
  assertAdvice(await session.ask({ question: 'A new question after the old transport settles.' }), 'ANSWERED', 1);
  assert.equal(requests.length, 2);
});

test('cancellation before a request is admitted makes zero model calls', async () => {
  const { session, requests } = fixture();
  const controller = new AbortController();
  controller.abort();
  const result = await session.ask({ question: 'How do I start?' }, { signal: controller.signal });
  assertAdvice(result, 'CANCELLED', 0);
  assert.equal(requests.length, 0);
});

test('cancellation after invocation aborts the one call and returns no late answer', { timeout: 1000 }, async () => {
  let finish;
  const { session, requests } = fixture({ complete: () => new Promise(resolve => { finish = resolve; }) });
  const controller = new AbortController();
  const pending = session.ask({ question: 'How do I start?' }, { signal: controller.signal });
  await nextTurn();
  assert.equal(requests.length, 1);
  controller.abort();
  const result = await pending;
  assertAdvice(result, 'CANCELLED', 1);
  assert.equal(requests[0].options.signal.aborted, true);
  assertAdvice(await session.ask({ question: 'Another question while the ignored abort is unsettled.' }), 'BUSY', 0);
  assert.equal(requests.length, 1);
  finish({ ...goodReply(), answer: 'SYNTHETIC_LATE_ANSWER_53' });
  await nextTurn();
  assert.equal(requests.length, 1);
  assert.equal(checkpoint(session).serialized.includes('SYNTHETIC_LATE_ANSWER_53'), false);
});

test('concurrent questions are refused as busy rather than dispatched as extra calls', async () => {
  let finish;
  const { session, requests } = fixture({ complete: () => new Promise(resolve => { finish = resolve; }) });
  const pending = session.ask({ question: 'First synthetic question about Build.' });
  await nextTurn();
  const concurrent = await session.ask({ question: 'Second synthetic question about Studio.' });
  assertAdvice(concurrent, 'BUSY', 0);
  assert.equal(requests.length, 1);
  finish(goodReply());
  assertAdvice(await pending, 'ANSWERED', 1);
  assert.equal(requests.length, 1);
});
