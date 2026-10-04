import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHiggsfieldCliAccount, nativeCommand } from '../../integrations/media/higgsfield-cli.mjs';
import { plan, sha256 } from '../../integrations/media/contract.mjs';
import { RequestJournal } from '../../integrations/media/journal.mjs';
import { verifyAsset } from '../../integrations/media/assets.mjs';
import { setup, H, video, NOW } from './fixtures.mjs';

const spec = () => ({ intentId: 'native-cli-test', sourceIdentity: H,
  input: { modelId: 'grok_video', prompt: 'Synthetic blue cube.', durationSeconds: 1, aspectRatio: '16:9' } });
function fixture(t, options = {}) {
  const { root, journal } = setup(t), calls = [], observations = [];
  const state = { credits: 20, cost: 1.5, workspace: 'workspace-test', jobStatus: 'completed', jobId: 'job-one', model: 'grok_video', createError: false, downloads: 0, matchCount: 1, createdAt: NOW + 1, ...options.state };
  const job = () => ({ id: state.jobId, job_type: state.model, status: state.jobStatus,
    created_at: new Date(state.createdAt).toISOString(), params: { prompt: spec().input.prompt, duration: 1, aspect_ratio: '16:9' },
    result_url: 'https://d8j0ntlcm91z4.cloudfront.net/result.mp4?signature=private' });
  const command = async (executable, args) => {
    calls.push(args);
    assert.equal(args.at(-1), '--json');
    if (args[0] === 'workspace') return { id: state.workspace };
    if (args[0] === 'account') return { credits: state.credits, subscription_plan_type: 'ultra', email: 'private@example.invalid' };
    if (args[0] === 'model') return { job_type: state.model, type: 'video', params: [{ name: 'prompt' }, { name: 'duration' }, { name: 'aspect_ratio', enum: ['16:9', '9:16'] }] };
    if (args[1] === 'cost') return { credits: state.cost };
    if (args[1] === 'create') {
      // The durable local request must precede provider transport.
      assert.equal(journal.reserve(plan({ ...spec(), connectorId: 'higgsfield', mode: 'AGENT_ACCOUNT', action: 'VIDEO_GENERATION',
        scopeIdentity: observations[0].scopeIdentity })).state, 'SUBMITTED');
      assert.ok(!args.includes('--wait'));
      if (state.createError) throw Error('Unknown remote delivery');
      return Object.hasOwn(state, 'ack') ? state.ack : ['job-one'];
    }
    if (args[1] === 'get') return job();
    if (args[1] === 'list') return Array.from({ length: state.matchCount }, () => job());
    throw Error('Unexpected command');
  };
  const executable = join(root, 'fake-cli'); writeFileSync(executable, 'test-executable', { mode: 0o700 });
  const config = { journal, assetRoot: root, executable, command,
    authorize: async () => true, onObservation: async value => observations.push(value),
    download: async () => { state.downloads++; return Buffer.from('synthetic video bytes'); },
    probe: bytes => ({ sha256: sha256(bytes), kind: 'video', valid: true, durationMs: 1000, codec: 'h264' }), ...options.adapter };
  return { root, journal, calls, state, observations, config, adapter: createHiggsfieldCliAccount(config) };
}
const prepares = adapter => adapter.prepare(spec(), { maxAccountCredits: 1.5 });
const createCount = f => f.calls.filter(a => a[0] === 'generate' && a[1] === 'create').length;

test('actual account catalog ID is accepted while direct API remains path qualified', () => {
  assert.equal(plan({ ...spec(), connectorId: 'higgsfield', mode: 'AGENT_ACCOUNT', action: 'VIDEO_GENERATION', scopeIdentity: H }).input.modelId, 'grok_video');
  assert.throws(() => plan({ ...spec(), connectorId: 'higgsfield', mode: 'DIRECT_API', action: 'VIDEO_GENERATION', scopeIdentity: H }));
  assert.equal(video().input.modelId, 'fixture/video/v1');
  for (const modelId of ['../grok_video', 'grok video', 'grok_video?x=1']) {
    assert.throws(() => plan({ ...spec(), connectorId: 'higgsfield', mode: 'AGENT_ACCOUNT', action: 'VIDEO_GENERATION', scopeIdentity: H, input: { ...spec().input, modelId } }));
  }
});

test('preflight uses native account/model/cost observations and rejects forged copied handles', async t => {
  const f = fixture(t), handle = await prepares(f.adapter);
  assert.equal(handle.authenticated, true); assert.equal(handle.expectedAccountCredits, 1.5);
  assert.equal(handle.accountCredits, 20); assert.equal(handle.mode, 'AGENT_ACCOUNT');
  assert.equal(f.observations.length, 1); assert.ok(!JSON.stringify(handle).includes('private@example'));
  await assert.rejects(f.adapter.submit({ ...handle }), /PREFLIGHT_REQUIRED/);
  assert.equal(createCount(f), 0);
});

for (const state of [{ cost: null }, { cost: 0 }, { cost: 2 }, { credits: 1 }, { model: 'different_model' }]) {
  test(`missing or inadmissible live preflight refuses create: ${JSON.stringify(state)}`, async t => {
    const f = fixture(t, { state }); await assert.rejects(prepares(f.adapter)); assert.equal(createCount(f), 0);
  });
}

test('real authorization callback remains required after successful preflight', async t => {
  const f = fixture(t, { adapter: { authorize: async () => false } });
  await assert.rejects(f.adapter.submit(await prepares(f.adapter)), /NOT_AUTHORIZED/); assert.equal(createCount(f), 0);
});

for (const changed of [{ cost: 2 }, { credits: 1 }, { workspace: 'another-workspace' }]) {
  test(`fresh scope and budget check refuses changed account before create: ${JSON.stringify(changed)}`, async t => {
    const f = fixture(t), handle = await prepares(f.adapter); Object.assign(f.state, changed);
    assert.equal((await f.adapter.submit(handle)).state, 'UNKNOWN_RECONCILE'); assert.equal(createCount(f), 0);
  });
}

test('one create persists ID before import; reopen uses exact ID and keeps local output UNREVIEWED', async t => {
  const f = fixture(t), handle = await prepares(f.adapter), submitted = await f.adapter.submit(handle);
  assert.equal(createCount(f), 1); assert.equal(f.state.downloads, 0); assert.equal(submitted.providerRequestId, 'job-one');
  assert.equal(f.journal.get(submitted.requestId).state, 'PROCESSING');
  await assert.rejects(f.adapter.submit(handle), /PREFLIGHT_REQUIRED/);
  await assert.rejects(f.adapter.submit(await prepares(f.adapter)), /NO_RESUBMIT/);
  f.journal.close(); const reopened = new RequestJournal({ root: f.root }); t.after(() => reopened.close());
  const next = createHiggsfieldCliAccount({ ...f.config, journal: reopened });
  const result = await next.poll(submitted.requestId);
  assert.equal(result.state, 'SUCCEEDED'); assert.equal(result.outputAssets.length, 1);
  assert.equal(result.outputAssets[0].review, 'UNREVIEWED'); assert.ok(verifyAsset(f.root, result.outputAssets[0]));
  assert.ok(!JSON.stringify(result).includes('signature')); assert.ok(!JSON.stringify(result).includes('result.mp4'));
  assert.equal(createCount(f), 1); assert.equal(f.state.downloads, 1);
  assert.equal(f.observations.at(-1).kind, 'COMPLETED');
});

test('uncertain create is never retried or repaired by a new preflight', async t => {
  const f = fixture(t, { state: { createError: true } });
  const result = await f.adapter.submit(await prepares(f.adapter));
  assert.equal(result.state, 'UNKNOWN_RECONCILE'); assert.equal(result.providerRequestId, null);
  await assert.rejects(f.adapter.submit(await prepares(f.adapter)), /NO_RESUBMIT/);
  assert.equal((await f.adapter.reconcile(result.requestId)).state, 'UNKNOWN_RECONCILE');
  assert.equal(createCount(f), 1); assert.equal(f.state.downloads, 0);
});

test('wrong provider job ID stays unknown and never downloads', async t => {
  const f = fixture(t), result = await f.adapter.submit(await prepares(f.adapter)); f.state.jobId = 'other-job';
  assert.equal((await f.adapter.poll(result.requestId)).state, 'UNKNOWN_RECONCILE');
  assert.equal(f.state.downloads, 0); assert.equal(createCount(f), 1);
});

test('generation failure is preserved without download or refund inference', async t => {
  const f = fixture(t, { state: { jobStatus: 'failed' } });
  const result = await f.adapter.poll((await f.adapter.submit(await prepares(f.adapter))).requestId);
  assert.equal(result.state, 'FAILED'); assert.equal(result.providerReceipt.actualCost, null);
  assert.equal(f.state.downloads, 0); assert.equal(createCount(f), 1);
});

test('lost create identity reconciles only one exact prompt/model/time/account match', async t => {
  const f = fixture(t, { state: { createError: true } });
  const unknown = await f.adapter.submit(await prepares(f.adapter));
  const result = await f.adapter.reconcileSubmission(unknown.requestId, spec());
  assert.equal(result.state, 'SUCCEEDED'); assert.equal(result.providerRequestId, 'job-one');
  assert.equal(result.outputAssets[0].review, 'UNREVIEWED'); assert.equal(createCount(f), 1);
});

for (const state of [{ matchCount: 0 }, { matchCount: 2 }, { createdAt: NOW - 2000 }]) {
  test(`ambiguous/old history cannot authorize recovery: ${JSON.stringify(state)}`, async t => {
    const f = fixture(t, { state: { createError: true, ...state } });
    const unknown = await f.adapter.submit(await prepares(f.adapter));
    await assert.rejects(f.adapter.reconcileSubmission(unknown.requestId, spec()), /MANUAL_RECONCILE_REQUIRED/);
    assert.equal(f.journal.get(unknown.requestId).providerRequestId, null); assert.equal(createCount(f), 1);
  });
}

test('recovery cannot replace the immutable effect with a changed prompt', async t => {
  const f = fixture(t, { state: { createError: true } });
  const unknown = await f.adapter.submit(await prepares(f.adapter)); const changed = spec(); changed.input.prompt = 'Different input';
  await assert.rejects(f.adapter.reconcileSubmission(unknown.requestId, changed), /PLAN_MISMATCH/);
  assert.equal(f.journal.get(unknown.requestId).providerRequestId, null); assert.equal(createCount(f), 1);
});

test('native submit still rejects unprepared handles before provider access', async t => { const f = fixture(t, { adapter: { command: nativeCommand } }); await assert.rejects(f.adapter.submit({}), /PREFLIGHT_REQUIRED/); });

for (const ack of [[{ id: 'job-one', job_type: 'grok_video' }], { jobs: [{ id: 'job-one' }] }, { id: 'job-one' }]) {
  test(`object acknowledgement compatibility: ${JSON.stringify(ack)}`, async t => {
    const f = fixture(t, { state: { ack } });
    const r = await f.adapter.submit(await prepares(f.adapter));
    assert.equal(r.providerRequestId, 'job-one'); assert.equal(r.state, 'PROCESSING');
    assert.equal(f.state.downloads, 0); assert.equal(createCount(f), 1);
  });
}

for (const ack of [null, [], ['job-one', 'job-two'], ['job-one', { id: 'job-two' }], [{}], [null], [123], [''], ['https://example.invalid/job'], { jobs: null }, { request_id: 'job-one' }, 'job-one', [{ id: 'job-one', job_type: 'other' }]]) {
  test(`malformed or ambiguous acknowledgement stays unknown: ${JSON.stringify(ack)}`, async t => {
    const f = fixture(t, { state: { ack } });
    const r = await f.adapter.submit(await prepares(f.adapter));
    assert.equal(r.state, 'UNKNOWN_RECONCILE'); assert.equal(r.providerRequestId, null);
    assert.equal(f.state.downloads, 0);
    await assert.rejects(f.adapter.submit(await prepares(f.adapter)), /NO_RESUBMIT/);
    f.journal.close(); const reopened = new RequestJournal({ root: f.root }); t.after(() => reopened.close());
    const next = createHiggsfieldCliAccount({ ...f.config, journal: reopened });
    await assert.rejects(next.submit(await prepares(next)), /NO_RESUBMIT/);
    assert.equal(reopened.get(r.requestId).state, 'UNKNOWN_RECONCILE'); assert.equal(createCount(f), 1);
  });
}

for (const jobStatus of ['cancelled', 'canceled']) {
  test(`provider-confirmed ${jobStatus} preserves identity without inferred refund`, async t => {
    const f = fixture(t, { state: { jobStatus } });
    const submitted = await f.adapter.submit(await prepares(f.adapter));
    const result = await f.adapter.poll(submitted.requestId);
    assert.equal(result.state, 'CANCELLED'); assert.equal(result.providerRequestId, 'job-one');
    assert.equal(result.providerReceipt.actualCost, null); assert.equal(f.state.downloads, 0);
    await assert.rejects(f.adapter.submit(await prepares(f.adapter)), /NO_RESUBMIT/);
    assert.equal(createCount(f), 1);
  });
}

test('native process JSON string-array acknowledgement is parsed without --wait', async t => {
  const { root } = setup(t), executable = join(root, 'fake-native');
  writeFileSync(executable, '#!/bin/sh\nprintf \'["job-one"]\\n\'\n', { mode: 0o700 });
  assert.deepEqual(await nativeCommand(executable, ['generate', 'create', '--json']), ['job-one']);
});

test('native command end-to-end: local reservation, ID-only ack, restart, exact poll and no duplicate', async t => {
  const f = fixture(t), log = join(f.root, 'native-calls.jsonl');
  writeFileSync(f.config.executable, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
let value;
if (args[0] === 'workspace') value = { id: 'workspace-test' };
else if (args[0] === 'account') value = { credits: 20, subscription_plan_type: 'ultra' };
else if (args[0] === 'model') value = { job_type: 'grok_video', type: 'video', params: [{ name: 'prompt' }, { name: 'duration' }, { name: 'aspect_ratio', enum: ['16:9'] }] };
else if (args[1] === 'cost') value = { credits_exact: 1.5 };
else {
  const db = new DatabaseSync(${JSON.stringify(join(f.root, 'requests.sqlite'))}, { readOnly: true });
  const row = JSON.parse(db.prepare('SELECT payload FROM requests').get().payload); db.close();
  if (args[1] === 'create') {
    if (row.state !== 'SUBMITTED' || row.providerRequestId !== null || args.includes('--wait')) process.exit(7);
    value = ['job-one'];
  } else if (args[1] === 'get') {
    if (args[2] !== 'job-one' || row.providerRequestId !== 'job-one') process.exit(8);
    value = { id: 'job-one', job_type: 'grok_video', status: 'completed', result_url: 'https://d8j0ntlcm91z4.cloudfront.net/synthetic.mp4' };
  } else process.exit(9);
}
console.log(JSON.stringify(value));
`, { mode: 0o700 });
  const adapter = createHiggsfieldCliAccount({ ...f.config, command: nativeCommand });
  const r = await adapter.submit(await prepares(adapter));
  assert.equal(r.state, 'PROCESSING'); assert.equal(r.providerRequestId, 'job-one');
  assert.equal(f.state.downloads, 0);
  f.journal.close(); const reopened = new RequestJournal({ root: f.root }); t.after(() => reopened.close());
  const next = createHiggsfieldCliAccount({ ...f.config, journal: reopened, command: nativeCommand });
  const result = await next.poll(r.requestId);
  assert.equal(result.state, 'SUCCEEDED'); assert.ok(verifyAsset(f.root, result.outputAssets[0]));
  assert.equal(result.outputAssets[0].review, 'UNREVIEWED');
  await assert.rejects(next.submit(await prepares(next)), /NO_RESUBMIT/);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(a => a[1] === 'create').length, 1);
  assert.equal(calls.filter(a => a[0] === 'generate' && a[1] === 'get').length, 1);
});

for (const source of ['printf \'not-json\\n\'', 'printf \'["job-one"]\\n\'; exit 1', 'kill -TERM $$']) {
  test(`native process uncertainty remains an error: ${source}`, async t => {
    const { root } = setup(t), executable = join(root, 'fake-native');
    writeFileSync(executable, `#!/bin/sh\n${source}\n`, { mode: 0o700 });
    await assert.rejects(nativeCommand(executable, ['generate', 'create', '--json']), /CLI_RESULT_UNKNOWN/);
  });
}

test('aborted native operation never implies provider cancellation or refund', async t => {
  const { root } = setup(t), executable = join(root, 'fake-native');
  writeFileSync(executable, '#!/bin/sh\nexec /bin/sleep 5\n', { mode: 0o700 });
  const controller = new AbortController();
  const pending = nativeCommand(executable, [], controller.signal);
  controller.abort();
  await assert.rejects(pending, /CLI_RESULT_UNKNOWN/);
});
