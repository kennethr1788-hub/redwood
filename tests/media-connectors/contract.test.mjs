import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, checkPlan, checkCapability, cost, quote, safeUrl, relativePath, json, manifests, baseline, digest } from '../../integrations/media/contract.mjs';
import { accountTask, catalogEntry } from '../../integrations/media/higgsfield.mjs';
import { transitionAllowed } from '../../integrations/media/journal.mjs';
import { video, speech, capability, NOW, H, catalog, setup } from './fixtures.mjs';

test('effect identity is stable, mode/source/settings/intent changes are distinct', () => {
  const p = video(); assert.deepEqual(p, checkPlan(p));
  assert.equal(video().effectDigest, p.effectDigest);
  for (const q of [video('AGENT_ACCOUNT'), video('DIRECT_API', { sourceIdentity: 'b'.repeat(64) }), video('DIRECT_API', { intentId: 'second-intent' }), video('DIRECT_API', { input: { ...p.input, prompt: 'Different' } })]) assert.notEqual(q.effectDigest, p.effectDigest);
  assert.equal(digest({ b: 1, a: 2 }), digest({ a: 2, b: 1 }));
});
test('state machine forbids terminal resurrection and unknown resubmit', () => {
  for (const terminal of ['SUCCEEDED', 'CANCELLED', 'FAILED']) for (const to of ['DRAFT', 'SUBMITTED', 'PROCESSING', 'UNKNOWN_RECONCILE']) assert.equal(transitionAllowed(terminal, to), false);
  assert.equal(transitionAllowed('UNKNOWN_RECONCILE', 'DRAFT'), false);
  assert.equal(transitionAllowed('DRAFT', 'SUCCEEDED'), false);
  assert.equal(transitionAllowed('PROCESSING', 'SUBMITTED'), false);
  assert.equal(transitionAllowed('UNKNOWN_RECONCILE', 'SUCCEEDED'), true);
});
for (const change of [{ verified: false }, { authenticated: false }, { detected: false }, { mode: 'AGENT_ACCOUNT' }, { scopeIdentity: 'b'.repeat(64) }, { modelId: 'other' }, { expiresAt: NOW }, { checkedAt: NOW + 1 }]) {
  test(`missing/stale/mismatched capability refuses ${Object.keys(change)[0]} ${JSON.stringify(change)}`, () => assert.throws(() => checkCapability(video(), capability(video(), change), NOW)));
}
test('unknown price remains null and known zero is explicit; billing modes cannot mix', () => {
  assert.equal(cost(null, 'DIRECT_API'), null);
  assert.deepEqual(cost({ amount: '0', unit: 'USD' }, 'DIRECT_API'), { amount: '0', unit: 'USD' });
  assert.throws(() => cost({ amount: 0, unit: 'USD' }, 'DIRECT_API'));
  assert.throws(() => cost({ amount: '1', unit: 'USD' }, 'AGENT_ACCOUNT'));
  assert.throws(() => cost({ amount: '1', unit: 'ACCOUNT_CREDITS' }, 'DIRECT_API'));
  assert.throws(() => quote({ cost: null, inputDigest: H, expiresAt: NOW + 1, source: 'PROVIDER_ESTIMATE' }, video(), NOW));
});
test('official account task preserves source and billing, grants no execution and no token', t => {
  const { journal } = setup(t), p = video('AGENT_ACCOUNT'), r = journal.reserve(p);
  const task = accountTask(r, p); assert.equal(task.executionAuthorized, false); assert.equal(task.allowApiFallback, false);
  assert.equal(task.connectorUrl, 'https://mcp.higgsfield.ai/mcp'); assert.equal(task.inputDigest, p.inputDigest);
  assert.throws(() => accountTask(r, video()));
});
test('catalog cannot lend an image/preview/unverified endpoint video capability', () => {
  for (const patch of [{ capability: 'IMAGE_GENERATION' }, { environment: 'PREVIEW' }, { parametersVerified: false }, { endpoint: 'https://evil.test/v1' }]) assert.throws(() => catalogEntry({ ...catalog[0], ...patch }));
});
test('unsupported voice operations and account isolation are refused', () => {
  for (const action of ['VOICE_CLONING', 'VOICE_DESIGN', 'DUBBING', 'PUBLISH', 'AUDIO_ISOLATION']) assert.throws(() => speech({ mode: 'AGENT_ACCOUNT', action }));
});
for (const url of ['http://api.higgsfield.ai/a', 'https://api.higgsfield.ai.evil.test/a', 'https://api.higgsfield.ai@evil.test/a', 'https://127.0.0.1/a', 'https://api.higgsfield.ai:8443/a', 'https://api.higgsfield.ai/a?token=secret', 'https://api.higgsfield.ai/a#fragment', 'https://api.higgsfield.ai/a/../b', 'https://api.higgsfield.ai/%2e%2e/a', 'https://api.higgsfield.ai\\evil.test/a']) test(`hostile URL ${url}`, () => assert.throws(() => safeUrl(url, ['api.higgsfield.ai'])));
for (const path of ['../audio.wav', '/etc/passwd', 'C:\\audio.wav', 'a/../../b', 'a//b', '.env', 'a/./b', 'a\u0000.wav']) test(`hostile path ${JSON.stringify(path)}`, () => assert.throws(() => relativePath(path)));
test('schemas reject unknown fields, getters, cycles, nonfinite values and secret-like prose', () => {
  assert.throws(() => checkPlan({ ...video(), apiKey: 'fake' }));
  assert.throws(() => json({ get token() { throw Error('must not evaluate'); } }));
  const cycle = {}; cycle.self = cycle; assert.throws(() => json(cycle));
  assert.throws(() => json({ value: NaN }));
  assert.throws(() => json(Array.from({ length: 128 }, () => 'x'.repeat(16384))), /INPUT_LIMIT/);
  const array = []; array.extra = 'not-an-index'; assert.throws(() => json(array));
  assert.throws(() => video('DIRECT_API', { input: { ...video().input, prompt: 'api_key=synthetic-secret' } }));
});
test('baseline needs zero connectors; static declarations confer no verification', () => {
  assert.deepEqual(baseline(), { connectorsRequired: false, productCompletion: 'NOT_ASSESSED' });
  const m = manifests(); assert.equal(m.length, 2); assert.equal(m[1].modeBindings[0].capabilities.includes('AUDIO_ISOLATION'), false);
  assert.equal('verified' in m[0], false);
});
