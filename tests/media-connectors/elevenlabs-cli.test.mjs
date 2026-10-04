import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElevenLabsCliAccount, elevenAudio } from '../../integrations/media/elevenlabs-cli.mjs';
import { projectCompletedObservation } from '../../integrations/media/local-doctor.mjs';
import { verifyAsset } from '../../integrations/media/assets.mjs';
import { setup, H, wav, probe } from './fixtures.mjs';
const spec = () => ({ intentId: 'eleven-native', sourceIdentity: H, action: 'TEXT_TO_SPEECH', input: { voiceId: 'hpp4J3VqNfWAUOO0d1Us', modelId: 'eleven_multilingual_v2', text: 'Redwood integration test.', outputFormat: 'mp3_44100_128', voiceSettings: { stability: 0.5, similarityBoost: 0.5, useSpeakerBoost: false } } });
function fixture(t, options = {}) {
  const { root, journal } = setup(t), calls = [], state = { auth: true, overage: false, limit: 2000, used: 0, user: 'test-user', multiplier: 1, conversions: 0, ...options.state };
  const executable = join(root, 'fake-cli'); writeFileSync(executable, 'synthetic executable', { mode: 0o700 });
  const command = async (exe, args) => {
    calls.push(args);
    if (args[0] === 'auth') return { schemes: [{ scheme: 'OAuth', logged_in: state.auth }] };
    if (args[0] === 'user' && args[1] === 'get') return { user_id: state.user };
    if (args[0] === 'user') return { status: 'active', tier: 'creator', character_count: state.used, character_limit: state.limit, can_extend_character_limit: state.overage, allowed_to_extend_character_limit: state.overage };
    if (args[0] === 'models') return [{ model_id: 'eleven_multilingual_v2', can_do_text_to_speech: true, model_rates: { character_cost_multiplier: state.multiplier, cost_discount_multiplier: 1 } }];
    if (args[0] === 'voices') return { voice_id: spec().input.voiceId, category: 'premade', sharing: null };
    if (args[0] === 'audio-isolation') return { operation: 'audio-isolation.convert', binaryResponse: true };
    throw Error('unexpected command');
  };
  const audio = async (exe, args, cwd, signal, accepted, input) => { state.conversions++; accepted({ providerRequestId: 'req-test', usage: { characters: 24 } }); assert.equal(journal.get(currentId()).providerRequestId, 'req-test'); if (options.failAudio) throw Error('stream lost'); if (input) assert.equal(input.length, 32000); return wav(); };
  let currentId = () => { throw Error('no request'); };
  const config = { journal, assetRoot: root, inputRoot: root, cwd: root, executable, command, audio, probe,
    authorize: async ({ request }) => { currentId = () => request.requestId; return true; }, ...options.adapter };
  return { root, journal, state, calls, adapter: createElevenLabsCliAccount(config) };
}
const prepare = f => f.adapter.prepare(spec(), { maxAccountCredits: 25 });
test('native OAuth/model/quota preflight then exactly one TTS import through journal', async t => {
  const f = fixture(t), h = await prepare(f); assert.equal(h.estimatedAccountCredits, 25);
  await assert.rejects(f.adapter.submit({ ...h }), /PREFLIGHT_REQUIRED/);
  const r = await f.adapter.submit(h); assert.equal(r.state, 'SUCCEEDED'); assert.equal(r.outputAssets[0].review, 'UNREVIEWED'); assert.ok(verifyAsset(f.root, r.outputAssets[0]));
  await assert.rejects(f.adapter.submit(await prepare(f)), /NO_RESUBMIT/); assert.equal(f.state.conversions, 1);
});
for (const state of [{ auth: false }, { overage: true }, { limit: 10 }, { multiplier: 2 }]) test(`inadmissible account/model blocks conversion ${JSON.stringify(state)}`, async t => { const f = fixture(t, { state }); await assert.rejects(prepare(f)); assert.equal(f.state.conversions, 0); });
test('account switch after preflight prevents conversion', async t => { const f = fixture(t), h = await prepare(f); f.state.user = 'other-user'; assert.equal((await f.adapter.submit(h)).state, 'UNKNOWN_RECONCILE'); assert.equal(f.state.conversions, 0); });
test('lost stream preserves accepted provider identity and never retries', async t => { const f = fixture(t, { failAudio: true }); const r = await f.adapter.submit(await prepare(f)); assert.equal(r.state, 'UNKNOWN_RECONCILE'); assert.equal(r.providerRequestId, 'req-test'); await assert.rejects(f.adapter.submit(await prepare(f)), /NO_RESUBMIT/); assert.equal(f.state.conversions, 1); });
test('account isolation remains closed after the unqualified live attempt', async t => { const f = fixture(t); await assert.rejects(f.adapter.prepare({ ...spec(), action: 'AUDIO_ISOLATION' }, { maxAccountCredits: 1000 }), /UNSUPPORTED_CAPABILITY/); assert.equal(f.state.conversions, 0); });
test('HTTP CLI receipt parser persists headers before body and strips unrelated sensitive headers', async t => {
  const { root } = setup(t), executable = join(root, 'fake-audio');
  writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write('HTTP/1.1 200 OK\\r\\nrequest-id: req-native\\r\\ncharacter-cost: 24\\r\\ncontent-type: audio/mpeg\\r\\nset-cookie: private\\r\\n\\r\\n');setTimeout(()=>process.stdout.write('body'),20);`, { mode: 0o700 });
  let receipt; const bytes = await elevenAudio(executable, [], root, new AbortController().signal, r => { receipt = r; });
  assert.deepEqual(receipt, { providerRequestId: 'req-native', usage: { characters: 24 } }); assert.equal(bytes.toString(), 'body');
});

test('optional Doctor cache failure cannot downgrade successful paid-result journal truth', async t => {
  const warnings = [], f = fixture(t, { adapter: { onObservation: observation => projectCompletedObservation(observation, {
    directory: '/unused-test-projection', record: () => { throw Error('private provider prose must not escape'); }, warn: value => warnings.push(value),
  }) } });
  const r = await f.adapter.submit(await prepare(f));
  assert.equal(r.state, 'SUCCEEDED'); assert.equal(f.journal.get(r.requestId).state, 'SUCCEEDED');
  assert.equal(r.providerRequestId, 'req-test'); assert.ok(verifyAsset(f.root, r.outputAssets[0]));
  assert.deepEqual(warnings, ['LOCAL_DOCTOR_PROJECTION_FAILED']); assert.equal(f.state.conversions, 1);
});
