import { createHash } from 'node:crypto';

export class MediaError extends Error {
  constructor(code) { super(code); this.name = 'MediaError'; this.code = code; }
}
export function requireThat(ok, code = 'INVALID_INPUT') { if (!ok) throw new MediaError(code); }
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function json(value, depth = 0, budget = { nodes: 0, bytes: 0 }) {
  requireThat(++budget.nodes <= 4096, 'INPUT_LIMIT');
  requireThat(depth < 12);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { requireThat(Number.isFinite(value)); return value; }
  if (typeof value === 'string') { budget.bytes += Buffer.byteLength(value); requireThat(value.length <= 16384 && budget.bytes <= 131072 && value.isWellFormed(), 'INPUT_LIMIT'); return value; }
  requireThat(value && typeof value === 'object');
  requireThat(Object.getPrototypeOf(value) === (Array.isArray(value) ? Array.prototype : Object.prototype));
  const keys = Reflect.ownKeys(value).filter(k => k !== 'length' || !Array.isArray(value));
  requireThat(keys.length <= 128);
  const out = Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) requireThat(value.length === keys.length && keys.every(k => /^(0|[1-9][0-9]*)$/.test(k)));
  for (const key of keys.sort()) {
    requireThat(typeof key === 'string' && !['__proto__', 'constructor', 'prototype'].includes(key));
    const d = Object.getOwnPropertyDescriptor(value, key);
    requireThat(d && 'value' in d && d.enumerable);
    budget.bytes += Buffer.byteLength(key); requireThat(budget.bytes <= 131072, 'INPUT_LIMIT');
    out[key] = json(d.value, depth + 1, budget);
  }
  return out;
}
export const canonical = value => JSON.stringify(json(value));
export const digest = value => sha256(canonical(value));
export function shape(value, required, optional = []) {
  requireThat(value && !Array.isArray(value) && typeof value === 'object');
  requireThat(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k)));
  return value;
}
export function token(value, max = 128) { requireThat(typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value)); return value; }
export function hash(value) { requireThat(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)); return value; }
export function text(value, max = 8000) {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value));
  requireThat(!/(?:bearer\s+[\w.-]+|(?:api[_ -]?key|secret|token)\s*[:=]\s*\S+|sk-[a-z0-9]{16,})/i.test(value), 'SECRET_LIKE_INPUT');
  return value;
}
export function integer(value, min, max) { requireThat(Number.isSafeInteger(value) && value >= min && value <= max); return value; }
export function relativePath(value) {
  requireThat(typeof value === 'string' && value.length <= 240 && /^[A-Za-z0-9_./-]+$/.test(value));
  requireThat(!value.startsWith('/') && value.split('/').every(p => p && p !== '.' && p !== '..' && !p.startsWith('.')), 'UNSAFE_PATH');
  return value;
}
export function safeUrl(value, hosts) {
  requireThat(typeof value === 'string' && value.length <= 2048 && !/[\\\s%]/u.test(value), 'UNSAFE_URL');
  let url; try { url = new URL(value); } catch { throw new MediaError('UNSAFE_URL'); }
  requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && !url.search && hosts.includes(url.hostname), 'UNAPPROVED_HOST');
  requireThat(url.href === value && !value.split('/').some(p => p === '.' || p === '..'), 'UNSAFE_URL');
  return value;
}
export const MODES = ['AGENT_ACCOUNT', 'DIRECT_API'];
export const STATES = ['DRAFT', 'SUBMITTED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED', 'UNKNOWN_RECONCILE'];
export const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED'];
const CAPS = {
  higgsfield: { AGENT_ACCOUNT: ['VIDEO_GENERATION'], DIRECT_API: ['VIDEO_GENERATION'] },
  elevenlabs: { AGENT_ACCOUNT: ['TEXT_TO_SPEECH'], DIRECT_API: ['TEXT_TO_SPEECH', 'AUDIO_ISOLATION'] },
};
export function billingMode(mode) { requireThat(MODES.includes(mode)); return mode === 'DIRECT_API' ? 'API_METERED' : 'ACCOUNT_CREDITS'; }
export function manifests() {
  return Object.entries(CAPS).map(([id, modes]) => ({
    schemaVersion: 1, id, displayName: id === 'higgsfield' ? 'Higgsfield' : 'ElevenLabs',
    category: 'MEDIA', modes: MODES.slice(),
    capabilities: [...new Set(Object.values(modes).flat())], authOwner: 'EXTERNAL_ADAPTER',
    billingModes: ['ACCOUNT_CREDITS', 'API_METERED'], doctorCapabilities: ['DETECTION', 'AUTH_STATUS', 'CAPABILITY_CHECK'],
    products: ['STUDIO', 'GROW'], externalEffects: ['GENERATE_REMOTE', 'WRITE_LOCAL'],
    modeBindings: MODES.map(mode => ({ mode, capabilities: modes[mode].slice(), billingModes: [billingMode(mode)], authRequired: true })),
  }));
}
export const excludedCapabilities = Object.freeze(['VOICE_CLONING', 'VOICE_DESIGN', 'DUBBING', 'PUBLISH']);
export function validateInput(connectorId, action, input, mode = 'DIRECT_API') {
  input = json(input);
  if (connectorId === 'higgsfield') {
    shape(input, ['modelId', 'prompt', 'durationSeconds', 'aspectRatio']);
    // Account catalogs use job_type IDs (for example grok_video); direct API
    // catalogs use provider/model paths. Never turn one namespace into the other.
    requireThat((mode === 'AGENT_ACCOUNT' ? /^[a-z0-9_-]+(?:\/[a-z0-9_-]+){0,6}$/ : /^[a-z0-9_-]+(?:\/[a-z0-9_-]+){1,6}$/).test(input.modelId));
    text(input.prompt); integer(input.durationSeconds, 1, 60);
    requireThat(['16:9', '9:16', '1:1'].includes(input.aspectRatio));
  } else if (action === 'TEXT_TO_SPEECH') {
    shape(input, ['voiceId', 'modelId', 'text', 'outputFormat', 'voiceSettings']);
    token(input.voiceId); token(input.modelId); text(input.text);
    // Deliberately bounded initial subset; account entitlement is still required.
    requireThat(['mp3_44100_128', 'wav_44100', 'pcm_16000'].includes(input.outputFormat));
    shape(input.voiceSettings, ['stability', 'similarityBoost', 'useSpeakerBoost']);
    for (const key of ['stability', 'similarityBoost']) requireThat(typeof input.voiceSettings[key] === 'number' && input.voiceSettings[key] >= 0 && input.voiceSettings[key] <= 1);
    requireThat(typeof input.voiceSettings.useSpeakerBoost === 'boolean');
  } else {
    shape(input, ['audio', 'fileFormat']);
    validateFileMetadata(input.audio);
    requireThat(['other', 'pcm_s16le_16'].includes(input.fileFormat));
  }
  return input;
}
export function validateFileMetadata(file) {
  shape(file, ['path', 'sha256', 'bytes', 'mime']); relativePath(file.path); hash(file.sha256);
  integer(file.bytes, 1, 32 * 1024 * 1024);
  requireThat(['audio/wav', 'audio/mpeg', 'audio/pcm', 'audio/flac'].includes(file.mime));
  return file;
}
export function plan(spec) {
  spec = json(spec);
  shape(spec, ['intentId', 'connectorId', 'mode', 'action', 'sourceIdentity', 'scopeIdentity', 'input']);
  token(spec.intentId); hash(spec.sourceIdentity); hash(spec.scopeIdentity);
  requireThat(CAPS[spec.connectorId]?.[spec.mode]?.includes(spec.action), 'UNSUPPORTED_CAPABILITY');
  spec.input = validateInput(spec.connectorId, spec.action, spec.input, spec.mode);
  const inputDigest = digest(spec.input);
  return { ...spec, inputDigest, effectDigest: digest({ ...spec, input: inputDigest }), billingMode: billingMode(spec.mode) };
}
export function checkPlan(p) {
  const v = json(p);
  shape(v, ['intentId', 'connectorId', 'mode', 'action', 'sourceIdentity', 'scopeIdentity', 'input', 'inputDigest', 'effectDigest', 'billingMode']);
  const { inputDigest, effectDigest, billingMode: billing, ...spec } = v;
  const expected = plan(spec);
  requireThat(inputDigest === expected.inputDigest && effectDigest === expected.effectDigest && billing === expected.billingMode, 'PLAN_MISMATCH');
  return expected;
}
export function checkCapability(p, observation, now) {
  const o = json(observation);
  shape(o, ['connectorId', 'mode', 'action', 'scopeIdentity', 'modelId', 'detected', 'authenticated', 'verified', 'checkedAt', 'expiresAt', 'evidenceDigest']);
  integer(now, 0, Number.MAX_SAFE_INTEGER); hash(o.evidenceDigest);
  requireThat(['connectorId', 'mode', 'action', 'scopeIdentity'].every(k => o[k] === p[k]) && o.modelId === (p.input.modelId ?? 'audio-isolation'), 'CAPABILITY_SCOPE_MISMATCH');
  requireThat(o.detected === true && o.authenticated === true && o.verified === true, 'CAPABILITY_NOT_VERIFIED');
  integer(o.checkedAt, 0, now); integer(o.expiresAt, now + 1, o.checkedAt + 86400000);
  return o;
}
export function cost(value, mode) {
  if (value === null) return null;
  const v = json(value); shape(v, ['amount', 'unit']);
  requireThat(typeof v.amount === 'string' && /^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,6})?$/.test(v.amount));
  requireThat((mode === 'DIRECT_API' ? ['USD', 'API_CREDITS'] : ['ACCOUNT_CREDITS']).includes(v.unit), 'BILLING_MODE_MISMATCH');
  return v;
}
export function quote(value, p, now) {
  if (value === null) return null;
  const v = json(value); shape(v, ['cost', 'inputDigest', 'expiresAt', 'source']);
  requireThat(v.inputDigest === p.inputDigest && v.source === 'PROVIDER_ESTIMATE', 'QUOTE_MISMATCH');
  integer(v.expiresAt, now + 1, now + 86400000);
  return { ...v, cost: cost(v.cost, p.mode) };
}
export function baseline() { return { connectorsRequired: false, productCompletion: 'NOT_ASSESSED' }; }
