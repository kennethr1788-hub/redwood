import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createAdvisor, retrieveHelp, classifySupportIntent, LIMITS } from '../../integrations/advisor/index.mjs';
import { createConversation } from '../../integrations/advisor/engine.mjs';
import { KNOWLEDGE_VERSION, KNOWLEDGE_DOCUMENTS, SUPPORT_INTENTS } from '../../docs/advisor/knowledge.mjs';

// Repository-owned Markdown is the only data read here. Request/transport/state
// fixtures are synthetic; nothing contacts a provider or executes product work.
const config = { projectId: 'project-1', runtimeId: 'codex' };
const makeState = (product, overrides = {}) => ({
  projectId: 'project-1', product, revision: 'revision-1', freshness: 'CURRENT',
  completionState: 'NOT_RUN', ...overrides,
});
const liveContext = (overrides = {}) => ({ projectId: 'project-1', page: null, receipt: null, connector: null, ...overrides });
function fixture(reply = { answer: 'Synthetic bounded guidance.', nextStep: 'Review the owning product.', navigateTo: null }) {
  const requests = [];
  const session = createConversation(config, { transport: {
    runtimeId: 'codex', complete: async request => { requests.push(request); return reply; },
  } });
  return { session, requests };
}
function assertContract(value, id) {
  assert.ok(value);
  assert.deepEqual(Object.keys(value).sort(), ['id', 'whatFailed', 'whatRemainsValid', 'nextUserAction', 'codingPromptUseful'].sort());
  assert.equal(value.id, id);
  for (const field of ['whatFailed', 'whatRemainsValid', 'nextUserAction']) {
    assert.equal(typeof value[field], 'string');
    assert.ok(value[field].trim().length > 0);
  }
  assert.ok(['YES', 'NO', 'MAYBE'].includes(value.codingPromptUseful));
}
const ids = documents => documents.map(document => document.id);
const sortedIds = documents => ids(documents).sort();
const libraryRoot = new URL('../../docs/advisor/', import.meta.url);

test('metadata-only index bounds the support intents and maps every intent to one to three known documents', () => {
  assert.equal(KNOWLEDGE_VERSION, 'redwood-expert-r1');
  assert.equal(SUPPORT_INTENTS.length, 49);
  assert.equal(new Set(SUPPORT_INTENTS.map(intent => intent.id)).size, SUPPORT_INTENTS.length);
  const documentIds = new Set(KNOWLEDGE_DOCUMENTS.map(document => document.id));
  assert.equal(documentIds.size, KNOWLEDGE_DOCUMENTS.length);
  for (const document of KNOWLEDGE_DOCUMENTS) {
    assert.deepEqual(Object.keys(document).sort(), ['id', 'title', 'path', 'sourcePaths'].sort());
    assert.equal('body' in document, false);
  }
  for (const intent of SUPPORT_INTENTS) {
    assert.deepEqual(Object.keys(intent).sort(), ['id', 'keywords', 'documents', 'products', 'contract'].sort());
    assert.ok(intent.documents.length >= 1 && intent.documents.length <= LIMITS.retrievedSections);
    assert.equal(new Set(intent.documents).size, intent.documents.length);
    assert.ok(intent.documents.every(id => documentIds.has(id)));
    assert.ok(Array.isArray(intent.keywords) && intent.keywords.length > 0);
    assert.ok(Array.isArray(intent.products));
    assert.ok([null, 'BUILD_VERIFICATION_FAILED', 'STUDIO_STALE_RENDER', 'HIGGSFIELD_SETUP'].includes(intent.contract));
  }
});

test('the complete curated Markdown library stays within its finite byte and document budgets', () => {
  assert.equal(KNOWLEDGE_DOCUMENTS.length, 18);
  let corpusBytes = 0;
  for (const document of KNOWLEDGE_DOCUMENTS) {
    assert.match(document.path, /\.md$/);
    assert.equal(document.path.startsWith('/'), false);
    assert.equal(document.path.split('/').includes('..'), false);
    const filename = new URL(document.path, libraryRoot);
    assert.ok(fs.lstatSync(filename).isFile());
    const body = fs.readFileSync(filename, 'utf8');
    const bytes = Buffer.byteLength(body);
    assert.ok(bytes > 0 && bytes <= LIMITS.documentBytes, document.path);
    corpusBytes += bytes;
    const words = body.trim().split(/\s+/).length;
    assert.ok(words >= 250 && words <= 850, `${document.path}: ${words} words`);
  }
  assert.ok(corpusBytes <= LIMITS.corpusBytes);
});

test('runtime import opens no Markdown, and a Studio question opens only its two selected documents', async t => {
  const opened = [];
  const originalOpen = fs.openSync;
  const asPath = value => value instanceof URL ? fileURLToPath(value) : typeof value === 'string' ? value : null;
  t.mock.method(fs, 'openSync', function (...args) {
    const fd = originalOpen.apply(this, args);
    const path = asPath(args[0]);
    if (path?.endsWith('.md')) opened.push(path);
    return fd;
  });
  syncBuiltinESMExports();
  try {
    const fresh = await import('../../integrations/advisor/knowledge.mjs?lazy-read-fixture');
    assert.deepEqual(opened, []);
    const selected = fresh.retrieveHelp('Why is my Studio render stale?');
    const expected = selected.map(document => fileURLToPath(new URL(document.path, libraryRoot))).sort();
    assert.equal(opened.length, 2);
    assert.deepEqual([...opened].sort(), expected);
    assert.equal(new Set(opened).size, 2);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('every explicit support-intent lookup is deterministic and reads only its mapped small document set', () => {
  for (const intent of SUPPORT_INTENTS) {
    const context = { supportIntent: intent.id };
    assert.deepEqual(classifySupportIntent('Synthetic question.', context), intent);
    const selected = retrieveHelp('Synthetic question.', [], context);
    assert.deepEqual(ids(selected), intent.documents);
    assert.deepEqual(retrieveHelp('Synthetic question.', [], context), selected);
    assert.ok(selected.length >= 1 && selected.length <= LIMITS.retrievedSections);
    for (const document of selected) {
      assert.equal(typeof document.body, 'string');
      assert.ok(document.body.trim().length > 0);
      assert.ok(Buffer.byteLength(document.body) <= LIMITS.sectionChars);
    }
  }
});

for (const [question, intent, expected] of [
  ['Why is my Present render stale?', 'studio.stale_render', ['studio.render-delivery', 'core.authority']],
  ['Why is my Studio render stale?', 'studio.stale_render', ['studio.render-delivery', 'core.authority']],
  ['How do I connect Higgsfield?', 'connection.higgsfield', ['operations.connections']],
]) {
  test(`natural-language routing selects the minimum relevant library slice: ${question}`, () => {
    assert.equal(classifySupportIntent(question).id, intent);
    const selected = retrieveHelp(question);
    assert.deepEqual(sortedIds(selected), [...expected].sort());
    assert.ok(selected.every(document => !/^(?:build|grow)\./.test(document.id)));
    if (intent === 'studio.stale_render') assert.ok(selected.every(document => !document.id.startsWith('integrations.')));
    if (intent === 'connection.higgsfield') {
      assert.ok(selected.every(document => !/integrations\.(?:codex|claude|elevenlabs)/.test(document.id)));
    }
  });
}

test('Present and legacy Studio aliases select the same owner for overview, stale and export questions', () => {
  for (const [question, expected] of [
    ['Help me use NAME.', 'studio.overview'],
    ['Why is NAME stale?', 'studio.stale_render'],
    ['How do I export in NAME?', 'studio.export'],
  ]) {
    const present = classifySupportIntent(question.replace('NAME', 'Present'));
    const legacy = classifySupportIntent(question.replace('NAME', 'Studio'));
    assert.equal(present.id, expected);
    assert.deepEqual(present, legacy);
    assert.deepEqual(present.products, ['studio']);
  }
});

test('current retrieved help uses Redwood and Present with canonical expert paths and stable product ownership', () => {
  const start = retrieveHelp('How do I start?')[0];
  assert.match(start.body, /Redwood has three standalone products/);
  assert.match(start.body, /Present works with an app recording/);
  const present = retrieveHelp('Why is my Present render stale?');
  assert.equal(present[0].title, 'Present rendering and delivery');
  assert.match(present[0].body, /A Present render is tied to a saved source/);
  assert.equal(present[0].id, 'studio.render-delivery');
  assert.equal(present[0].path, 'studio/render-delivery.md');
  assert.ok(present[0].sourcePaths.includes('products/studio/src/core/store.js'));
  assert.deepEqual(present, retrieveHelp('Why is my Studio render stale?'));
  for (const document of KNOWLEDGE_DOCUMENTS) {
    const selected = retrieveHelp('Synthetic question.', [], {
      supportIntent: SUPPORT_INTENTS.find(intent => intent.documents.includes(document.id)).id,
    }).find(topic => topic.id === document.id);
    assert.doesNotMatch(selected.title + '\n' + selected.body, /\b(?:LaunchForge|Studio)\b/);
    assert.equal(selected.path, document.path);
    assert.deepEqual(selected.sourcePaths, document.sourcePaths);
  }
});

test('Present stale-render questions use fresh studio state after legacy Studio discussion', async () => {
  const { session, requests } = fixture();
  await session.ask({ question: 'Why is my Studio render stale?',
    state: makeState('studio', { revision: 'old-revision', freshness: 'STALE', completionState: 'STALE' }) });
  const current = makeState('studio', { revision: 'present-revision', completionState: 'RENDERED' });
  const input = { question: 'Why is my Present render stale?', state: current };
  const result = await session.ask(input);
  const local = await createAdvisor(config).ask(input);
  assertContract(result.answerContract, 'STUDIO_STALE_RENDER');
  assert.equal(result.supportIntent, 'studio.stale_render');
  assert.match(result.answerContract.whatFailed, /^Supplied Present state: RENDERED; freshness CURRENT\./);
  assert.match(result.answerContract.nextUserAction, /^Open Present and inspect/);
  assert.deepEqual(result.answerContract, local.answerContract);
  assert.deepEqual(result.currentState, current);
  assert.deepEqual(requests[1].context.currentState, current);
  assert.equal(requests[1].context.question, input.question);
  assert.equal(JSON.stringify(requests[1].context).includes('old-revision'), false);
  assert.match(requests[1].system, /^You are one Redwood Advisor/);
  assert.match(requests[1].system, /Build, Present and Grow; their stable navigation IDs remain build, studio and grow/);
  assert.ok(local.answer.includes(local.answerContract.whatFailed));
  assert.equal(local.modelCalls, 0);
  for (const label of ['Present', 'Studio']) {
    const unknown = await session.ask({ question: `Why is my ${label} render stale?` });
    assert.equal(unknown.supportIntent, 'studio.stale_render');
    assert.equal(unknown.currentState, null);
    assert.match(unknown.answerContract.whatFailed, /^Current Present state is UNKNOWN because it was not supplied\./);
  }
});

for (const provider of ['codex', 'claude', 'higgsfield', 'elevenlabs']) {
  test(`specific ${provider} setup selects only the consolidated connection card`, () => {
    const question = `How do I connect ${provider}?`;
    assert.equal(classifySupportIntent(question).id, `connection.${provider}`);
    const selected = retrieveHelp(question);
    assert.deepEqual(ids(selected), ['operations.connections']);
  });
}

test('conflicting previous topics do not pull Build, Grow or other providers into an explicit current question', () => {
  const previousTopics = ['build.verification', 'grow.overview', 'integrations.claude'];
  assert.deepEqual(sortedIds(retrieveHelp('Why is my Studio render stale?', previousTopics)),
    ['studio.render-delivery', 'core.authority'].sort());
  assert.deepEqual(sortedIds(retrieveHelp('How do I connect Higgsfield?', previousTopics)),
    ['operations.connections'].sort());
});

test('explicit unknown support intents cannot expand the library or become file paths', () => {
  for (const supportIntent of ['unknown.intent', '../README.md', '/synthetic/private.md', 'docs/advisor/START.md']) {
    assert.throws(() => retrieveHelp('Synthetic question.', [], { supportIntent }));
    assert.throws(() => classifySupportIntent('Synthetic question.', { supportIntent }));
  }
});

test('representative failure contracts are deterministic in both local fallback and single-call fake paths', async () => {
  const cases = [
    { supportIntent: 'build.verification_failed', question: 'Why did Build verification fail?',
      state: makeState('build', { completionState: 'CURRENT_FAIL' }), contract: 'BUILD_VERIFICATION_FAILED', suppliedStatus: 'CURRENT_FAIL' },
    { supportIntent: 'studio.stale_render', question: 'Why is my Studio render stale?',
      state: makeState('studio', { freshness: 'STALE', completionState: 'STALE' }), contract: 'STUDIO_STALE_RENDER', suppliedStatus: 'STALE' },
    { supportIntent: 'connection.higgsfield', question: 'How do I connect Higgsfield?',
      state: null, contract: 'HIGGSFIELD_SETUP', suppliedStatus: null },
  ];
  for (const entry of cases) {
    const input = { question: entry.question, supportIntent: entry.supportIntent, state: entry.state };
    const local = await createAdvisor(config).ask(input);
    const { session, requests } = fixture();
    const modeled = await session.ask(input);
    assert.equal(local.status, 'BRIDGE_UNAVAILABLE');
    assert.equal(local.modelCalls, 0);
    assert.equal(modeled.status, 'ANSWERED');
    assert.equal(modeled.modelCalls, 1);
    assert.equal(requests.length, 1);
    assertContract(local.answerContract, entry.contract);
    assert.deepEqual(modeled.answerContract, local.answerContract);
    assert.equal(modeled.supportIntent, entry.supportIntent);
    assert.equal(local.supportIntent, entry.supportIntent);
    if (entry.suppliedStatus) assert.match(local.answerContract.whatFailed, new RegExp(entry.suppliedStatus));
    for (const result of [local, modeled]) {
      assert.equal(result.role, 'assistant');
      assert.equal(result.roleId, 'advisor');
      assert.equal(result.executionAuthority, 'NONE');
      assert.equal(result.sourceEditAuthority, 'NONE');
      assert.deepEqual(result.currentState, entry.state);
    }
  }
});

test('missing current state keeps Build and Studio failure contracts unknown even after earlier known discussion', async () => {
  for (const [product, supportIntent, contractId] of [
    ['build', 'build.verification_failed', 'BUILD_VERIFICATION_FAILED'],
    ['studio', 'studio.stale_render', 'STUDIO_STALE_RENDER'],
  ]) {
    const { session, requests } = fixture();
    await session.ask({ question: 'What happened?', supportIntent,
      state: makeState(product, { completionState: product === 'build' ? 'CURRENT_FAIL' : 'STALE', freshness: 'STALE' }) });
    const unknown = await session.ask({ question: 'What is true now?', supportIntent });
    assert.equal(unknown.currentState, null);
    assertContract(unknown.answerContract, contractId);
    assert.match(unknown.answerContract.whatFailed, /unknown|unavailable|not supplied/i);
    assert.equal(requests[1].context.currentState, null);
    assert.equal(JSON.stringify(requests[1].context.continuity).includes('CURRENT_FAIL'), false);
    assert.equal(JSON.stringify(requests[1].context.continuity).includes('revision-1'), false);
  }
});

test('Higgsfield supplied status cannot turn offline support into capability or authorization', async () => {
  const input = { question: 'How do I connect Higgsfield?', supportIntent: 'connection.higgsfield',
    liveContext: liveContext({ page: 'connections', connector: { id: 'higgsfield', status: 'VERIFIED' } }) };
  const { session, requests } = fixture();
  const modeled = await session.ask(input);
  const local = await createAdvisor(config).ask(input);
  assert.equal(modeled.status, 'ANSWERED');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].context.liveContext, input.liveContext);
  assertContract(modeled.answerContract, 'HIGGSFIELD_SETUP');
  assert.deepEqual(modeled.answerContract, local.answerContract);
  assert.match(modeled.answerContract.whatFailed, /Supplied Higgsfield Doctor status: VERIFIED/);
  assert.match(modeled.answerContract.whatFailed, /UNKNOWN/);
  assert.match(modeled.answerContract.whatRemainsValid, /OFFLINE_QUALIFIED/);
  assert.match(modeled.answerContract.whatRemainsValid, /current Connections for mode-specific live qualification/);
  assert.doesNotMatch(JSON.stringify(modeled.answerContract), /has not been checked yet|qualification is NOT_RUN/);
  assert.match(modeled.answerContract.whatRemainsValid, /do not grant authentication, billing coverage or action authorization/);
  assert.doesNotMatch(JSON.stringify(modeled.answerContract), /PENDING|absent integration/);
  assert.equal(modeled.answerContract.codingPromptUseful, 'NO');
  assert.ok(local.answer.includes(local.answerContract.whatFailed));
  assert.equal(local.nextStep, local.answerContract.nextUserAction);
  assert.equal(session.checkpoint().includes('VERIFIED'), false);
  assert.equal(session.checkpoint().includes('connector'), false);
});

test('only a current matching failed receipt can add a failure code to the deterministic Build contract', async () => {
  const errorCode = 'SYNTHETIC_CHECK_FAILED_42';
  const current = makeState('build', { completionState: 'CURRENT_FAIL' });
  const receipt = { product: 'build', revision: 'revision-1', status: 'FAILED', errorCode };
  const { session } = fixture();
  const matched = await session.ask({ question: 'Why did Build verification fail?', supportIntent: 'build.verification_failed',
    state: current, liveContext: liveContext({ page: 'build', receipt }) });
  assertContract(matched.answerContract, 'BUILD_VERIFICATION_FAILED');
  assert.ok(matched.answerContract.whatFailed.includes(errorCode));
  for (const [suppliedState, suppliedReceipt] of [
    [null, receipt],
    [{ ...current, freshness: 'STALE' }, receipt],
    [{ ...current, completionState: 'CURRENT_PASS' }, receipt],
    [current, { ...receipt, revision: 'old-revision' }],
    [current, { ...receipt, product: 'studio' }],
    [current, { ...receipt, status: 'PASSED' }],
    [current, { ...receipt, status: 'UNKNOWN' }],
  ]) {
    const result = await session.ask({ question: 'Why did Build verification fail?', supportIntent: 'build.verification_failed',
      state: suppliedState, liveContext: liveContext({ page: 'build', receipt: suppliedReceipt }) });
    assert.equal(result.status, 'ANSWERED');
    assertContract(result.answerContract, 'BUILD_VERIFICATION_FAILED');
    assert.equal(result.answerContract.whatFailed.includes(errorCode), false);
  }
  assert.equal(session.checkpoint().includes(errorCode), false);
});

test('a fresh supplied product state wins over stale discussion topics', async () => {
  const { session, requests } = fixture();
  await session.ask({ question: 'Why is my Present render stale?',
    state: makeState('studio', { revision: 'old-revision', freshness: 'STALE', completionState: 'STALE' }) });
  const current = makeState('build', { revision: 'current-revision', completionState: 'CURRENT_FAIL' });
  const result = await session.ask({ question: 'Why did Build verification fail?', supportIntent: 'build.verification_failed', state: current });
  assertContract(result.answerContract, 'BUILD_VERIFICATION_FAILED');
  assert.match(result.answerContract.whatFailed, /CURRENT_FAIL/);
  assert.deepEqual(result.currentState, current);
  assert.deepEqual(requests[1].context.currentState, current);
  assert.equal(JSON.stringify(requests[1].context).includes('old-revision'), false);
  assert.ok(requests[1].context.knowledge.every(document => !document.id.startsWith('studio.')));
});

test('model responses cannot replace deterministic answer contracts', async () => {
  const { session, requests } = fixture({
    answer: 'Synthetic claim that code is fixed.', nextStep: 'Synthetic next step.', navigateTo: null,
    answerContract: { id: 'BUILD_VERIFICATION_FAILED', whatFailed: 'Nothing; synthetic success override.',
      whatRemainsValid: 'Everything.', nextUserAction: 'Deploy.', codingPromptUseful: 'NO' },
  });
  const result = await session.ask({ question: 'Why did verification fail?', supportIntent: 'build.verification_failed',
    state: makeState('build', { completionState: 'CURRENT_FAIL' }) });
  assert.equal(result.status, 'INVALID_RESPONSE');
  assert.equal(result.modelCalls, 1);
  assert.equal(requests.length, 1);
  assertContract(result.answerContract, 'BUILD_VERIFICATION_FAILED');
  assert.match(result.answerContract.whatFailed, /CURRENT_FAIL/);
  assert.equal(JSON.stringify(result).includes('synthetic success override'), false);
  assert.equal(JSON.stringify(session.checkpoint()).includes('Synthetic claim'), false);
});

test('adding a support intent cannot grant builder or execution authority', async () => {
  const { session, requests } = fixture();
  for (const intent of ['RUN_COMMAND', 'EDIT_SOURCE', 'DEPLOY', 'SPEND', 'PUBLISH']) {
    const result = await session.ask({ question: 'Perform the synthetic action.', supportIntent: 'build.verification_failed', intent });
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.modelCalls, 0);
    assert.equal(result.executionAuthority, 'NONE');
    assert.equal(result.sourceEditAuthority, 'NONE');
  }
  assert.equal(requests.length, 0);
});
