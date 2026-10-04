import { execFile, spawn } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { plan, digest, sha256, requireThat, shape, token, MediaError } from './contract.mjs';
import { checkedRoot, importAsset, MAX_ASSET_BYTES } from './assets.mjs';
import { MediaRunner } from './runner.mjs';
import { envelope } from './receipt.mjs';

const API = 'https://api.elevenlabs.io';
const MODEL = 'eleven_multilingual_v2';
const VOICE = 'hpp4J3VqNfWAUOO0d1Us'; // Provider premade Bella; no cloning/library mutation.
const env = () => Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG'].filter(k => process.env[k]).map(k => [k, process.env[k]]));

// Only allowlisted receipt headers leave this closure. No auth export/debug,
// inherited provider overrides, .env in caller cwd, shell, or automatic retry.
export function elevenJson(executable, args, cwd, signal) {
  return new Promise((resolve, reject) => execFile(executable, [...args, '--format', 'json'],
    { cwd, env: env(), signal, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new MediaError('CLI_RESULT_UNKNOWN'));
      try { resolve(JSON.parse(stdout)); } catch { reject(new MediaError('CLI_RESULT_UNKNOWN')); }
    }));
}
export function elevenAudio(executable, args, cwd, signal, accepted, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args, '--format', 'http', '--no-retry', '--base-url', API],
      { cwd, env: env(), signal, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = Buffer.alloc(0), headers = false, size = 0, failed = false;
    const parts = [];
    const fail = () => { if (!failed) { failed = true; child.kill(); reject(new MediaError('DELIVERY_UNKNOWN')); } };
    child.on('error', fail); child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      if (failed) return;
      try {
        if (!headers) {
          buffer = Buffer.concat([buffer, chunk]); const end = buffer.indexOf('\r\n\r\n');
          requireThat(end >= 0 || buffer.length <= 16384, 'INVALID_HEADERS');
          if (end < 0) return;
          requireThat(end <= 16384, 'INVALID_HEADERS');
          const lines = buffer.subarray(0, end).toString('utf8').split('\r\n');
          requireThat(/^HTTP\/(?:1\.[01]|2|3) 200 /.test(lines.shift()), 'PROVIDER_RESPONSE_UNKNOWN');
          const values = new Map();
          for (const line of lines) { const i = line.indexOf(':'); if (i > 0) { const k = line.slice(0, i).toLowerCase(); if (['request-id', 'character-cost', 'content-type'].includes(k)) { requireThat(!values.has(k), 'DUPLICATE_HEADER'); values.set(k, line.slice(i + 1).trim()); } } }
          const providerRequestId = values.get('request-id') ?? null; if (providerRequestId !== null) token(providerRequestId);
          requireThat(/^audio\//.test(values.get('content-type') ?? ''), 'INVALID_MEDIA');
          const characters = values.get('character-cost') ?? null;
          requireThat(characters === null || /^(?:0|[1-9][0-9]{0,6})$/.test(characters), 'INVALID_USAGE');
          accepted({ providerRequestId, usage: characters === null ? null : { characters: Number(characters) } });
          headers = true; chunk = buffer.subarray(end + 4); buffer = Buffer.alloc(0);
        }
        size += chunk.length; requireThat(size <= MAX_ASSET_BYTES, 'ASSET_TOO_LARGE'); parts.push(chunk);
      } catch { fail(); }
    });
    child.on('close', code => { if (failed) return; if (code !== 0 || !headers || !size) fail(); else resolve(Buffer.concat(parts, size)); });
    child.stdin.end(input);
  });
}

export function createElevenLabsCliAccount({ journal, assetRoot, probe, executable, cwd,
  authorize = async () => false, onObservation = async () => {}, clock = Date.now, command = elevenJson, audio = elevenAudio }) {
  checkedRoot(cwd); checkedRoot(assetRoot);
  requireThat(isAbsolute(executable) && lstatSync(executable).isFile() && !lstatSync(executable).isSymbolicLink(), 'UNSAFE_EXECUTABLE');
  requireThat(!['.env', '.env.local'].some(name => { try { return lstatSync(`${cwd}/${name}`) !== null; } catch { return false; } }), 'UNSAFE_CLI_CWD');
  const executableDigest = sha256(readFileSync(executable)), prepared = new WeakMap(), active = new Map();
  const pin = () => requireThat(sha256(readFileSync(executable)) === executableDigest, 'EXECUTABLE_CHANGED');
  const call = (args, signal) => { pin(); return command(executable, args[0] === 'auth' ? args : [...args, '--base-url', API, '--no-retry'], cwd, signal); };
  async function account(signal) {
    const auth = await call(['auth', 'status'], signal);
    requireThat(auth.schemes?.some(s => s.scheme === 'OAuth' && s.logged_in === true), 'AUTH_REQUIRED');
    const user = await call(['user', 'get', '--query', '{user_id:user_id}'], signal); token(user.user_id);
    const sub = await call(['user', 'subscription', 'get', '--query', '{tier:tier,status:status,character_count:character_count,character_limit:character_limit,can_extend_character_limit:can_extend_character_limit,allowed_to_extend_character_limit:allowed_to_extend_character_limit}'], signal);
    requireThat(sub.status === 'active' && Number.isSafeInteger(sub.character_count) && sub.character_count >= 0 && Number.isSafeInteger(sub.character_limit) && sub.character_limit >= sub.character_count, 'QUOTA_UNKNOWN');
    requireThat(sub.can_extend_character_limit === false && sub.allowed_to_extend_character_limit === false, 'OVERAGE_NOT_DISABLED');
    return { scopeIdentity: digest({ connectorId: 'elevenlabs', mode: 'AGENT_ACCOUNT', userId: user.user_id }), credits: sub.character_limit - sub.character_count, tier: sub.tier, used: sub.character_count };
  }
  const runner = new MediaRunner({ journal, clock, timeoutMs: 60000,
    authorize: ({ operation, request }) => authorize({ operation, request, preflight: active.get(request.effectDigest)?.summary ?? null }),
    transport: { connectorId: 'elevenlabs', mode: 'AGENT_ACCOUNT', async submit(r, p, signal, accepted) {
      const entry = active.get(p.effectDigest); requireThat(entry && entry.expiresAt > clock(), 'PREFLIGHT_REQUIRED');
      const current = await account(signal); requireThat(current.scopeIdentity === p.scopeIdentity && current.credits >= entry.credits, 'ACCOUNT_OR_QUOTA_CHANGED');
      const v = p.input;
      const args = ['text-to-speech', 'convert', '--voice-id', VOICE, '--model-id', MODEL, '--text', v.text, '--output-format', v.outputFormat,
        '--voice-settings', JSON.stringify({ stability: v.voiceSettings.stability, similarity_boost: v.voiceSettings.similarityBoost, use_speaker_boost: v.voiceSettings.useSpeakerBoost })];
      pin(); let receipt = envelope(r);
      const bytes = await audio(executable, args, cwd, signal, observed => {
        receipt = { ...receipt, ...observed }; accepted({ ...receipt, state: observed.providerRequestId ? 'PROCESSING' : 'UNKNOWN_RECONCILE' });
      });
      requireThat(!signal.aborted, 'INTERRUPTED');
      const asset = await importAsset({ root: assetRoot, bytes, kind: 'audio', requestId: r.requestId, providerRequestId: receipt.providerRequestId, probe, signal });
      await onObservation({ schemaVersion: 1, kind: 'COMPLETED', connectorId: 'elevenlabs', mode: 'AGENT_ACCOUNT', action: p.action,
        requestId: r.requestId, providerRequestId: receipt.providerRequestId, checkedAt: clock(), outputSha256: asset.sha256, review: 'UNREVIEWED',
        evidenceDigest: digest({ requestId: r.requestId, providerRequestId: receipt.providerRequestId, sha256: asset.sha256 }) });
      return { ...receipt, state: 'SUCCEEDED', outputAssets: [asset] };
    }, async reconcile() { throw new MediaError('MANUAL_RECONCILE_REQUIRED'); } } });
  return Object.freeze({
    async prepare(spec, { maxAccountCredits }) {
      shape(spec, ['intentId', 'sourceIdentity', 'action', 'input']);
      requireThat(spec.action === 'TEXT_TO_SPEECH', 'UNSUPPORTED_CAPABILITY');
      requireThat(Number.isSafeInteger(maxAccountCredits) && maxAccountCredits > 0 && maxAccountCredits <= 1000, 'BUDGET_REQUIRED');
      const acct = await account();
      const p = plan({ ...spec, connectorId: 'elevenlabs', mode: 'AGENT_ACCOUNT', scopeIdentity: acct.scopeIdentity });
      requireThat(p.input.modelId === MODEL && p.input.voiceId === VOICE && p.input.outputFormat === 'mp3_44100_128' && /^[\x20-\x7e]{1,100}$/.test(p.input.text), 'MODEL_NOT_QUALIFIED');
      const models = await call(['models', 'list']); const m = models.find(v => v.model_id === MODEL);
      requireThat(m?.can_do_text_to_speech === true && m.model_rates?.character_cost_multiplier === 1 && m.model_rates?.cost_discount_multiplier === 1, 'MODEL_NOT_QUALIFIED');
      const v = await call(['voices', 'get', '--voice-id', VOICE, '--query', '{voice_id:voice_id,category:category,sharing:sharing}']);
      requireThat(v.voice_id === VOICE && v.category === 'premade' && v.sharing === null, 'VOICE_NOT_QUALIFIED');
      const credits = p.input.text.length;
      requireThat(credits <= maxAccountCredits && credits <= acct.credits, 'COST_EXCEEDS_AUTHORIZATION');
      const checkedAt = clock(), expiresAt = checkedAt + 30000;
      const summary = { schemaVersion: 1, kind: 'PREFLIGHT', connectorId: 'elevenlabs', mode: 'AGENT_ACCOUNT', action: p.action,
        authenticated: true, inputDigest: p.inputDigest, scopeIdentity: p.scopeIdentity, accountCredits: acct.credits, tier: acct.tier,
        estimatedAccountCredits: credits, reservedAccountCredits: credits,
        rateBasis: 'NATIVE_MODEL_RATES', executableDigest, checkedAt, expiresAt };
      summary.evidenceDigest = digest(summary);
      const observation = { connectorId: 'elevenlabs', mode: 'AGENT_ACCOUNT', action: p.action, scopeIdentity: p.scopeIdentity, modelId: p.input.modelId ?? 'audio-isolation', detected: true, authenticated: true, verified: true, checkedAt, expiresAt, evidenceDigest: summary.evidenceDigest };
      const handle = Object.freeze({ ...summary }); prepared.set(handle, { p, observation, summary, expiresAt, credits }); await onObservation(summary); return handle;
    },
    async submit(handle) { const entry = prepared.get(handle); requireThat(entry && entry.expiresAt > clock(), 'PREFLIGHT_REQUIRED'); active.set(entry.p.effectDigest, entry);
      try { return await runner.submit(entry.p, entry.observation); } finally { active.delete(entry.p.effectDigest); prepared.delete(handle); } },
    reconcile: id => runner.reconcile(id),
  });
}
