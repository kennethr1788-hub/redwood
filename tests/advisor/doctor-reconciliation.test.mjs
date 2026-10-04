import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdvisor, reopenAdvisor, retrieveHelp, LIMITS } from '../../integrations/advisor/index.mjs';
import { createConversation } from '../../integrations/advisor/engine.mjs';
import { supportDoctor } from '../../integrations/connectors/support-doctor.mjs';
import { CONNECTION_STATES } from '../../integrations/connectors/registry.mjs';
import { SUPPORT_INTENTS } from '../../docs/advisor/knowledge.mjs';

const config = { projectId: 'project-1', runtimeId: 'codex' };
const current = '2026-10-03T12:00:00.000Z';
const context = connector => ({ projectId: config.projectId, page: 'connections', receipt: null, connector });
const question = 'How do I connect Higgsfield?';

test('fresh integrated Doctor UNKNOWN wins old pending discussion after checkpoint reopen', async () => {
  const oldSession = createConversation(config, { transport: { runtimeId: 'codex', complete: async () => ({
    answer: 'Old discussion said media support was PENDING.', nextStep: 'Inspect current Connections.', navigateTo: null,
  }) } });
  await oldSession.ask({ question });
  oldSession.remember({ style: 'concise', unresolvedTopicIds: ['integrations.higgsfield'] });
  const saved = oldSession.checkpoint();
  assert.doesNotMatch(saved, /PENDING|connector|OFFLINE_QUALIFIED/);
  const session = reopenAdvisor(saved, config.projectId);
  const doctor = supportDoctor(current);
  const row = doctor.rows.find(row => row.connectorId === 'higgsfield');
  assert.equal(doctor.mediaIntegration, 'OFFLINE_QUALIFIED');
  assert.equal(doctor.providerRuntimeQualification, 'NOT_RUN');
  assert.equal(row.status, 'UNKNOWN');
  assert.ok(row.capabilityStates.every(capability => capability.state === 'UNKNOWN'));
  assert.equal(row.authenticated, null);
  assert.equal(row.actionAuthorization, 'NOT_GRANTED');
  const result = await session.ask({ question, liveContext: context({ id: row.connectorId, status: row.status }) });
  assert.equal(result.status, 'BRIDGE_UNAVAILABLE');
  assert.equal(result.modelCalls, 0);
  assert.match(result.answerContract.whatFailed, /Supplied Higgsfield Doctor status: UNKNOWN/);
  assert.match(result.answer, /OFFLINE_QUALIFIED/);
  assert.doesNotMatch(result.answer, /PENDING|absent integration/);
  assert.equal(result.nextStep, result.answerContract.nextUserAction);
  assert.equal(result.executionAuthority, 'NONE');
  assert.equal(result.sourceEditAuthority, 'NONE');
  assert.equal(result.currentState, null);
});

test('every shared Doctor status is accepted as display context without enabling native chat', async () => {
  const session = createAdvisor(config);
  for (const status of CONNECTION_STATES) {
    const result = await session.ask({ question, liveContext: context({ id: 'higgsfield', status }) });
    assert.equal(result.status, 'BRIDGE_UNAVAILABLE', status);
    assert.equal(result.modelCalls, 0);
    assert.ok(result.answerContract.whatFailed.includes(`Doctor status: ${status}.`));
    assert.match(result.answerContract.whatFailed, /Usable capability remains UNKNOWN/);
    assert.match(result.answerContract.whatRemainsValid, /do not grant authentication, billing coverage or action authorization/);
  }
  for (const status of ['PENDING', 'UNAVAILABLE', 'OFFLINE_QUALIFIED', 'READY']) {
    const result = await session.ask({ question, liveContext: context({ id: 'higgsfield', status }) });
    assert.equal(result.status, 'INVALID_INPUT', status);
    assert.equal(result.modelCalls, 0);
  }
});

test('missing or unrelated Doctor observations cannot reuse an earlier Higgsfield status', async () => {
  const session = createAdvisor(config);
  await session.ask({ question, liveContext: context({ id: 'higgsfield', status: 'VERIFIED' }) });
  for (const liveContext of [undefined, context(null), context({ id: 'elevenlabs', status: 'VERIFIED' })]) {
    const result = await session.ask({ question, ...(liveContext ? { liveContext } : {}) });
    assert.equal(result.status, 'BRIDGE_UNAVAILABLE');
    assert.match(result.answerContract.whatFailed, /UNKNOWN because no matching current row was supplied/);
    assert.doesNotMatch(result.answerContract.whatFailed, /VERIFIED/);
    assert.equal(result.modelCalls, 0);
  }
});

test('media knowledge matches integrated mode-specific support without live readiness claims', () => {
  const higgsfield = retrieveHelp(question)[0].body;
  assert.match(higgsfield, /VIDEO_GENERATION/);
  assert.match(higgsfield, /Image generation is not declared/);
  for (const provider of ['higgsfield', 'elevenlabs']) {
    const body = retrieveHelp(`How do I connect ${provider}?`)[0].body;
    for (const label of ['AGENT_ACCOUNT', 'DIRECT_API', 'ACCOUNT_CREDITS', 'API_METERED', 'OFFLINE_QUALIFIED', 'NOT_RUN', 'UNKNOWN']) {
      assert.ok(body.includes(label), `${provider}: ${label}`);
    }
    assert.doesNotMatch(body, /media integration PENDING|integration remains pending|no actual.*implemented/i);
  }
  const elevenlabs = retrieveHelp('How do I connect ElevenLabs?')[0].body;
  assert.match(elevenlabs, /ElevenLabs is outside required competition functionality/);
});

test('all 49 support intents retain one bounded default reply and at most three documents', async () => {
  assert.equal(SUPPORT_INTENTS.length, 49);
  const session = createAdvisor(config);
  for (const intent of SUPPORT_INTENTS) {
    const result = await session.ask({ question: 'Explain the selected support topic.', supportIntent: intent.id });
    assert.equal(result.status, 'BRIDGE_UNAVAILABLE', intent.id);
    assert.equal(result.role, 'assistant');
    assert.equal(result.roleId, 'advisor');
    assert.equal(result.displayName, 'Redwood Advisor');
    assert.equal(result.modelCalls, 0);
    assert.equal(result.supportIntent, intent.id);
    assert.deepEqual(result.topicIds, intent.documents);
    assert.ok(result.topicIds.length >= 1 && result.topicIds.length <= 3);
    assert.ok(result.answer.length <= LIMITS.answerChars);
    assert.ok(result.nextStep.length <= LIMITS.nextStepChars);
    assert.equal(result.executionAuthority, 'NONE');
    assert.equal(result.sourceEditAuthority, 'NONE');
  }
});
