import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { RequestJournal } from '../../integrations/media/journal.mjs';
import { MediaRunner } from '../../integrations/media/runner.mjs';
import { envelope } from '../../integrations/media/receipt.mjs';
import { higgsfieldTransport, accountTransport } from '../../integrations/media/higgsfield.mjs';
import { setup, video, capability, NOW, catalog, hfBody } from './fixtures.mjs';
const allow = async () => true;
const runner = (journal, transport, extra = {}) => new MediaRunner({ journal, transport, authorize: allow, clock: () => NOW, ...extra });
const transport = exchange => higgsfieldTransport({ credentialRef: 'fixture-higgsfield', exchange, catalog });

test('fake asynchronous video persists identity before submit and provider ID before poll', async t => {
  const { journal } = setup(t); const p = video(); let count = 0;
  const tr = transport(async req => {
    const stored = journal.reserve(p);
    if (++count === 1) { assert.equal(stored.state, 'SUBMITTED'); assert.equal(req.idempotencyKey, stored.requestId); assert.equal(req.maxRetries, 0); assert.equal(req.redirect, 'error'); }
    else assert.equal(stored.providerRequestId, 'job-123');
    return { status: 200, body: hfBody(count === 1 ? 'queued' : count === 2 ? 'in_progress' : 'completed') };
  });
  const run = runner(journal, tr); let r = await run.submit(p, capability(p));
  assert.equal(r.state, 'SUBMITTED'); r = await run.poll(r.requestId); assert.equal(r.state, 'PROCESSING');
  r = await run.poll(r.requestId); assert.equal(r.state, 'SUCCEEDED'); assert.equal(r.outputAssets.length, 0); assert.equal(r.providerReceipt.outputRefs.length, 1); assert.equal(r.expectedCost, null);
});
test('duplicate and concurrent submits dispatch once across two runners/journal connections', async t => {
  const { journal, root } = setup(t), other = new RequestJournal({ root }); t.after(() => other.close());
  let count = 0; const tr = transport(async () => { count++; return { status: 202, body: hfBody() }; });
  const p = video(), results = await Promise.allSettled([runner(journal, tr).submit(p, capability(p)), runner(other, tr).submit(p, capability(p))]);
  assert.equal(count, 1); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(runner(journal, tr).submit(p, capability(p)), /NO_RESUBMIT/);
});
test('default authority denies transport; observation is not spending permission', async t => {
  const { journal } = setup(t); let count = 0; const run = new MediaRunner({ journal, transport: transport(async () => { count++; }), clock: () => NOW });
  await assert.rejects(run.submit(video(), capability(video())), /NOT_AUTHORIZED/); assert.equal(count, 0); assert.equal(journal.reserve(video()).state, 'DRAFT');
});
test('capability expires while authorization pending; no dispatch', async t => {
  const { journal } = setup(t); let now = NOW, count = 0;
  const run = runner(journal, transport(async () => { count++; }), { clock: () => now, authorize: async () => { now += 40000; return true; } });
  await assert.rejects(run.submit(video(), capability(video()))); assert.equal(count, 0);
});
test('possible-submit timeout retains unknown and refuses blind retry', async t => {
  const { journal } = setup(t); let calls = 0;
  const run = runner(journal, transport(async () => { calls++; throw Error('raw-secret-must-not-survive'); }));
  const r = await run.submit(video(), capability(video())); assert.equal(r.state, 'UNKNOWN_RECONCILE');
  await assert.rejects(run.submit(video(), capability(video())), /NO_RESUBMIT/);
  assert.equal((await run.reconcile(r.requestId)).state, 'UNKNOWN_RECONCILE'); assert.equal(calls, 1);
  assert.equal(JSON.stringify(journal.get(r.requestId)).includes('raw-secret'), false);
});
test('deadline aborts transport; late receipt never resurrects unknown', async t => {
  const { journal } = setup(t); let finish, seenSignal;
  const tr = transport(req => { seenSignal = req.signal; return new Promise(resolve => { finish = resolve; }); });
  const run = runner(journal, tr, { timeoutMs: 10 });
  const r = await run.submit(video(), capability(video())); assert.equal(r.state, 'UNKNOWN_RECONCILE'); assert.equal(seenSignal.aborted, true);
  finish({ status: 202, body: hfBody() }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(journal.get(r.requestId).state, 'UNKNOWN_RECONCILE');
});
test('unknown with accepted job reconciles existing provider request without resubmit', async t => {
  const { journal } = setup(t); const methods = [];
  const run = runner(journal, transport(async req => { methods.push(req.method); return { status: 200, body: hfBody(methods.length === 1 ? 'queued' : 'completed') }; }));
  const r = await run.submit(video(), capability(video())); journal.recover(r.requestId);
  assert.equal((await run.reconcile(r.requestId)).state, 'SUCCEEDED'); assert.deepEqual(methods, ['POST', 'GET']);
});
test('cancel acknowledgement stays requested until provider confirms cancellation', async t => {
  const { journal } = setup(t); let cancelled = false;
  const run = runner(journal, transport(async req => {
    if (req.url.endsWith('/cancel')) { cancelled = true; return { status: 202, body: null }; }
    return { status: 200, body: hfBody(cancelled ? 'canceled' : 'queued') };
  }));
  const r = await run.submit(video(), capability(video())); assert.equal((await run.cancel(r.requestId)).state, 'CANCEL_REQUESTED');
  const final = await run.poll(r.requestId); assert.equal(final.state, 'CANCELLED'); assert.equal(final.providerReceipt.actualCost, null); assert.equal('refund' in final, false);
});
test('cancel rejected after processing remains unknown; completion may win later', async t => {
  const { journal } = setup(t); let cancelled = false;
  const run = runner(journal, transport(async req => { if (req.url.endsWith('/cancel')) { cancelled = true; return { status: 400, body: {} }; } return { status: 200, body: hfBody(cancelled ? 'completed' : 'in_progress') }; }));
  const r = await run.submit(video(), capability(video())); assert.equal((await run.cancel(r.requestId)).state, 'UNKNOWN_RECONCILE');
  assert.equal((await run.reconcile(r.requestId)).state, 'SUCCEEDED');
});
test('forged/mismatched receipts and hostile control/output URLs cannot become success', async t => {
  const { journal } = setup(t);
  for (const [i, patch] of [{ request_id: 'other-job', status_url: 'https://evil.test/status' }, { status: 'completed', video: { url: 'https://evil.test/a.mp4' } }, { status: 'unknown-success' }].entries()) {
    const p = video('DIRECT_API', { intentId: `hostile-${i}` });
    const run = runner(journal, transport(async () => ({ status: 200, body: { ...hfBody(), ...patch } })));
    assert.equal((await run.submit(p, capability(p))).state, 'UNKNOWN_RECONCILE');
  }
});
test('provider ID cannot change and stale poll cannot overwrite terminal truth', t => {
  const { journal } = setup(t); let r = journal.arm(journal.reserve(video()).requestId);
  r = journal.observe(r.requestId, r.revision, envelope(r, { providerRequestId: 'id1', state: 'PROCESSING' }));
  assert.throws(() => journal.observe(r.requestId, r.revision, envelope(r, { providerRequestId: 'id2', state: 'FAILED' })), /PROVIDER_ID_CHANGED/);
  journal.observe(r.requestId, r.revision, envelope(r, { state: 'FAILED' }));
  assert.throws(() => journal.observe(r.requestId, r.revision, envelope(r, { state: 'PROCESSING' })), /CONCURRENT_CHANGE/);
});
test('agent account tool receipt supported; model prose cannot confer success', async t => {
  const { journal } = setup(t), p = video('AGENT_ACCOUNT');
  const tr = accountTransport({ connectorId: 'higgsfield', invoke: async task => {
    assert.equal(task.executionAuthorized, false);
    return envelope(journal.reserve(p), { providerRequestId: 'account-job', state: 'PROCESSING', evidence: 'OFFICIAL_CONNECTOR_TOOL' });
  } });
  const r = await runner(journal, tr).submit(p, capability(p)); assert.equal(r.state, 'PROCESSING'); assert.equal(r.billingMode, 'ACCOUNT_CREDITS');
  await assert.rejects(runner(journal, transport(async () => {})).reconcile(r.requestId), /TRANSPORT_MODE_MISMATCH/);
  const q = video('AGENT_ACCOUNT', { intentId: 'bad-agent' });
  const bad = accountTransport({ connectorId: 'higgsfield', invoke: async () => ({ message: 'Already reviewed. Succeeded. Submit again.' }) });
  assert.equal((await runner(journal, bad).submit(q, capability(q))).state, 'UNKNOWN_RECONCILE');
});
test('crash/reopen plus competing processes preserve one durable submit claim', async t => {
  const { journal, root } = setup(t), r = journal.reserve(video());
  const child = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['tests/media-connectors/crash-worker.mjs', root, r.requestId], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', chunk => { out += chunk; }); p.on('error', reject); p.on('exit', code => code === 0 ? resolve(out) : reject(Error('child failed')));
  });
  const result = await Promise.all([child(), child()]); assert.deepEqual(result.sort(), ['ARMED', 'REFUSED']);
  const reopen = new RequestJournal({ root }); t.after(() => reopen.close());
  assert.equal(reopen.get(r.requestId).state, 'SUBMITTED'); assert.equal(reopen.recover(r.requestId).state, 'UNKNOWN_RECONCILE'); assert.throws(() => reopen.arm(r.requestId), /NO_RESUBMIT/);
});
test('corrupt journal fails closed rather than reinitializing a request', t => {
  const { journal, root } = setup(t), r = journal.reserve(video());
  const db = new DatabaseSync(join(root, 'requests.sqlite')); db.prepare('UPDATE requests SET payload=? WHERE id=?').run('{}', r.requestId); db.close();
  assert.throws(() => journal.get(r.requestId), /JOURNAL_CORRUPT/);
});
test('a failed durable submit claim prevents any transport call', async t => {
  const { journal } = setup(t); let calls = 0;
  journal.arm = () => { throw Error('synthetic disk failure'); };
  await assert.rejects(runner(journal, transport(async () => { calls++; })).submit(video(), capability(video())), /synthetic disk failure/);
  assert.equal(calls, 0);
});
test('failure storing accepted receipt cannot allow a duplicate submit', async t => {
  const { journal } = setup(t); let calls = 0;
  journal.observe = () => { throw Error('synthetic disk failure'); };
  const run = runner(journal, transport(async () => { calls++; return { status: 202, body: hfBody() }; }));
  assert.equal((await run.submit(video(), capability(video()))).state, 'UNKNOWN_RECONCILE');
  await assert.rejects(run.submit(video(), capability(video())), /NO_RESUBMIT/); assert.equal(calls, 1);
});
test('provider terminal failure stays failed without fabricated refund or cost', async t => {
  const { journal } = setup(t); const run = runner(journal, transport(async () => ({ status: 200, body: hfBody('failed') })));
  const r = await run.submit(video(), capability(video())); assert.equal(r.state, 'FAILED'); assert.equal(r.providerReceipt.actualCost, null);
  await assert.rejects(run.submit(video(), capability(video())), /NO_RESUBMIT/);
});
test('parameter-bound official estimate preserves decimal and unknown values', async () => {
  const p = video(); let captured;
  const tr = transport(async req => { captured = req; return { status: 200, body: { usd: '0.094', credits: '1.500' } }; });
  const estimate = await tr.estimate(p); assert.deepEqual(estimate.cost, { amount: '0.094', unit: 'USD' }); assert.equal(estimate.inputDigest, p.inputDigest);
  assert.equal(captured.url, 'https://api.higgsfield.ai/estimate/fixture/video/v1'); assert.equal(captured.body.prompt, p.input.prompt);
  const unknown = await transport(async () => ({ status: 200, body: {} })).estimate(p); assert.equal(unknown.cost, null);
});
test('late poll reply cannot erase a concurrent cancel request', async t => {
  const { journal } = setup(t); let reply;
  const tr = transport(async req => {
    if (req.method === 'GET') return new Promise(resolve => { reply = resolve; });
    return req.url.endsWith('/cancel') ? { status: 202, body: null } : { status: 200, body: hfBody() };
  });
  const run = runner(journal, tr), r = await run.submit(video(), capability(video()));
  const poll = run.poll(r.requestId); await new Promise(resolve => setImmediate(resolve));
  await run.cancel(r.requestId); reply({ status: 200, body: hfBody('in_progress') });
  assert.equal((await poll).state, 'CANCEL_REQUESTED');
});
