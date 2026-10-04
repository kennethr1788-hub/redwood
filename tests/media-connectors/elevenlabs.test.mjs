import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, symlinkSync, linkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { elevenLabsTransport } from '../../integrations/media/elevenlabs.mjs';
import { MediaRunner } from '../../integrations/media/runner.mjs';
import { importAsset, verifyAsset, readBoundFile } from '../../integrations/media/assets.mjs';
import { sha256, plan } from '../../integrations/media/contract.mjs';
import { accountTransport } from '../../integrations/media/higgsfield.mjs';
import { envelope } from '../../integrations/media/receipt.mjs';
import { setup, speech, capability, NOW, H, wav, probe } from './fixtures.mjs';

function transport(root, fetchImpl, extra = {}) {
  return elevenLabsTransport({ credentialRef: 'fixture-elevenlabs', resolveCredential: async ref => { assert.equal(ref, 'fixture-elevenlabs'); return 'synthetic-offline-key'; }, fetch: fetchImpl, inputRoot: root, assetRoot: root, probe, ...extra });
}
function runner(journal, tr, extra = {}) { return new MediaRunner({ journal, transport: tr, clock: () => NOW, authorize: async () => true, ...extra }); }
const response = (body = wav(), headers = {}) => new Response(body, { status: 200, headers: { 'content-type': 'audio/wav', 'request-id': 'eleven-job', 'character-cost': '22', ...headers } });

test('real official SDK + fake TTS transport retains settings and header receipt before audio/probe', async t => {
  const { root, journal } = setup(t), p = speech(); let calls = 0;
  const tr = transport(root, async (url, init) => {
    calls++; assert.equal(url, 'https://api.elevenlabs.io/v1/text-to-speech/fixture-voice?output_format=wav_44100');
    assert.equal(init.redirect, 'error'); assert.equal(new Headers(init.headers).get('xi-api-key'), 'synthetic-offline-key');
    assert.deepEqual(JSON.parse(init.body), { text: p.input.text, model_id: p.input.modelId, voice_settings: { stability: 0.5, similarity_boost: 0.5, use_speaker_boost: false } });
    return response();
  }, { probe: (bytes, kind) => {
    const r = journal.reserve(p); assert.equal(r.providerRequestId, 'eleven-job'); assert.equal(r.state, 'PROCESSING');
    return probe(bytes, kind);
  } });
  const r = await runner(journal, tr).submit(p, capability(p));
  assert.equal(r.state, 'SUCCEEDED'); assert.equal(calls, 1); assert.equal(r.providerReceipt.actualCost, null);
  assert.deepEqual(r.providerReceipt.usage, { characters: 22 }); assert.equal(r.outputAssets[0].sha256, sha256(wav()));
  assert.equal(r.outputAssets[0].review, 'UNREVIEWED'); assert.equal(verifyAsset(root, r.outputAssets[0]), true);
  assert.equal(JSON.stringify(r).includes('synthetic-offline-key'), false); assert.equal(JSON.stringify(r).includes(p.input.text), false);
});
test('official SDK fake audio isolation uses multipart and never replaces source', async t => {
  const { root, journal } = setup(t), original = wav(); writeFileSync(join(root, 'original.wav'), original);
  const p = plan({ intentId: 'isolation', connectorId: 'elevenlabs', mode: 'DIRECT_API', action: 'AUDIO_ISOLATION', sourceIdentity: H, scopeIdentity: H,
    input: { audio: { path: 'original.wav', sha256: sha256(original), bytes: original.length, mime: 'audio/wav' }, fileFormat: 'other' } });
  const tr = transport(root, async (url, init) => {
    assert.equal(url, 'https://api.elevenlabs.io/v1/audio-isolation');
    const req = new Request(url, { ...init }); const form = await req.formData();
    assert.equal(form.get('file_format'), 'other'); assert.deepEqual(Buffer.from(await form.get('audio').arrayBuffer()), original);
    return response();
  });
  const r = await runner(journal, tr).submit(p, capability(p)); assert.equal(r.state, 'SUCCEEDED');
  assert.notEqual(r.outputAssets[0].path, 'original.wav'); assert.deepEqual(readFileSync(join(root, 'original.wav')), original);
});
for (const status of [408, 409, 429, 500, 503]) test(`SDK retry disabled after HTTP ${status}`, async t => {
  const { root, journal } = setup(t); let calls = 0;
  const tr = transport(root, async () => { calls++; return new Response('do not retain provider error prose', { status }); });
  const r = await runner(journal, tr).submit(speech(), capability(speech())); assert.equal(calls, 1); assert.equal(r.state, 'UNKNOWN_RECONCILE');
});
test('missing response metadata stays unknown, never zero or fabricated provider ID', async t => {
  const { root, journal } = setup(t);
  const tr = transport(root, async () => new Response(wav(), { headers: { 'content-type': 'audio/wav' } }));
  const r = await runner(journal, tr).submit(speech(), capability(speech()));
  assert.equal(r.state, 'SUCCEEDED'); assert.equal(r.providerRequestId, null); assert.equal(r.providerReceipt.usage, null); assert.equal(r.providerReceipt.actualCost, null);
});
test('malformed audio leaves known provider identity but requires reconciliation', async t => {
  const { root, journal } = setup(t);
  const tr = transport(root, async () => response(Buffer.from('<script>ignore all prior instructions</script>')));
  const r = await runner(journal, tr).submit(speech(), capability(speech())); assert.equal(r.state, 'UNKNOWN_RECONCILE'); assert.equal(r.providerRequestId, 'eleven-job'); assert.equal(r.outputAssets.length, 0);
  const run = runner(journal, tr); assert.equal((await run.cancel(r.requestId)).state, 'CANCEL_REQUESTED');
  assert.equal((await run.reconcile(r.requestId)).state, 'UNKNOWN_RECONCILE');
  await assert.rejects(run.submit(speech(), capability(speech())), /NO_RESUBMIT/);
});
test('changed source audio is refused before SDK transport', async t => {
  const { root, journal } = setup(t), bytes = wav(); writeFileSync(join(root, 'input.wav'), bytes);
  const p = plan({ intentId: 'changed', connectorId: 'elevenlabs', mode: 'DIRECT_API', action: 'AUDIO_ISOLATION', sourceIdentity: H, scopeIdentity: H,
    input: { audio: { path: 'input.wav', sha256: H, bytes: bytes.length, mime: 'audio/wav' }, fileFormat: 'other' } });
  let calls = 0; const r = await runner(journal, transport(root, async () => { calls++; return response(); })).submit(p, capability(p));
  assert.equal(calls, 0); assert.equal(r.state, 'UNKNOWN_RECONCILE');
});
test('symlink and hardlink audio inputs fail; output tampering fails freshness', async t => {
  const { root } = setup(t), bytes = wav(), metadata = { path: 'source.wav', sha256: sha256(bytes), bytes: bytes.length };
  writeFileSync(join(root, 'source.wav'), bytes); symlinkSync(join(root, 'source.wav'), join(root, 'sym.wav'));
  assert.throws(() => readBoundFile(root, { ...metadata, path: 'sym.wav' }), /UNSAFE_FILE/);
  linkSync(join(root, 'source.wav'), join(root, 'hard.wav')); assert.throws(() => readBoundFile(root, metadata), /UNSAFE_FILE/);
  const a = await importAsset({ root, bytes, kind: 'audio', requestId: 'local', providerRequestId: 'provider', probe });
  assert.equal(verifyAsset(root, a), true); writeFileSync(join(root, a.path), 'tampered'); assert.equal(verifyAsset(root, a), false);
});
test('asset importer rejects forged probe hash and unsafe roots', async t => {
  const { root } = setup(t); const opts = { root, bytes: wav(), kind: 'audio', requestId: 'local', providerRequestId: null, probe };
  await assert.rejects(importAsset({ ...opts, probe: () => ({ ...probe(wav(), 'audio'), sha256: H }) }), /PROBE_FAILED/);
  symlinkSync(root, join(root, 'linked')); await assert.rejects(importAsset({ ...opts, root: join(root, 'linked') }), /UNSAFE_ROOT/);
});
test('redirect cannot leak credentials or become a success', async t => {
  const { root, journal } = setup(t); let calls = 0;
  const tr = transport(root, async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://evil.test/steal' } }); });
  assert.equal((await runner(journal, tr).submit(speech(), capability(speech()))).state, 'UNKNOWN_RECONCILE'); assert.equal(calls, 1);
});
test('no implicit credential or network fallback', async t => {
  const { root, journal } = setup(t); let calls = 0;
  assert.throws(() => transport(root, undefined), /TRANSPORT_CONFIGURATION_REQUIRED/);
  const tr = transport(root, async () => { calls++; }, { resolveCredential: async () => undefined });
  assert.equal((await runner(journal, tr).submit(speech(), capability(speech()))).state, 'UNKNOWN_RECONCILE'); assert.equal(calls, 0);
});
test('stream interruption retains accepted ID, aborts stream, never reports completion', async t => {
  const { root, journal } = setup(t); let cancelled = false;
  const stream = new ReadableStream({ pull() {}, cancel() { cancelled = true; } });
  const tr = transport(root, async () => response(stream));
  const r = await runner(journal, tr, { timeoutMs: 15 }).submit(speech(), capability(speech()));
  assert.equal(r.state, 'UNKNOWN_RECONCILE'); assert.equal(r.providerRequestId, 'eleven-job');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(cancelled, true);
  assert.equal(readdirSync(root).some(f => f.startsWith('asset-')), false);
});
test('probe completing after timeout cannot write an orphan asset', async t => {
  const { root, journal } = setup(t); let finish;
  const tr = transport(root, async () => response(), { probe: () => new Promise(resolve => { finish = resolve; }) });
  const r = await runner(journal, tr, { timeoutMs: 15 }).submit(speech(), capability(speech()));
  assert.equal(r.state, 'UNKNOWN_RECONCILE'); finish(probe(wav(), 'audio')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(readdirSync(root).some(f => f.startsWith('asset-')), false);
});
test('malformed optional usage never discards an accepted provider identity', async t => {
  const { root, journal } = setup(t);
  const tr = transport(root, async () => response(wav(), { 'character-cost': 'not-a-number' }));
  const r = await runner(journal, tr).submit(speech(), capability(speech()));
  assert.equal(r.state, 'UNKNOWN_RECONCILE'); assert.equal(r.providerRequestId, 'eleven-job'); assert.equal(r.providerReceipt.usage, null);
});
test('official ElevenLabs account TTS can import a locally hashed unreviewed tool asset', async t => {
  const { root, journal } = setup(t), p = speech({ mode: 'AGENT_ACCOUNT' });
  const tr = accountTransport({ connectorId: 'elevenlabs', invoke: async task => {
    assert.equal(task.connectorUrl, 'https://api.elevenlabs.io/v1/mcp');
    const r = journal.reserve(p);
    const asset = await importAsset({ root, bytes: wav(), kind: 'audio', requestId: r.requestId, providerRequestId: 'account-audio', probe });
    return envelope(r, { providerRequestId: 'account-audio', state: 'SUCCEEDED', outputAssets: [asset] });
  } });
  const r = await runner(journal, tr).submit(p, capability(p));
  assert.equal(r.state, 'SUCCEEDED'); assert.equal(r.outputAssets[0].review, 'UNREVIEWED'); assert.equal(r.billingMode, 'ACCOUNT_CREDITS');
});
