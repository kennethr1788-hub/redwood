import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { plan, sha256, requireThat } from '../../integrations/media/contract.mjs';
import { RequestJournal } from '../../integrations/media/journal.mjs';
export const NOW = 1791086400000;
export const H = 'a'.repeat(64);
export function video(mode = 'DIRECT_API', extra = {}) {
  return plan({ intentId: 'fixture-intent', connectorId: 'higgsfield', mode, action: 'VIDEO_GENERATION', sourceIdentity: H, scopeIdentity: H,
    input: { modelId: 'fixture/video/v1', prompt: 'A synthetic test scene', durationSeconds: 5, aspectRatio: '16:9' }, ...extra });
}
export function speech(extra = {}) {
  return plan({ intentId: 'fixture-speech', connectorId: 'elevenlabs', mode: 'DIRECT_API', action: 'TEXT_TO_SPEECH', sourceIdentity: H, scopeIdentity: H,
    input: { voiceId: 'fixture-voice', modelId: 'fixture-model', text: 'Synthetic offline test', outputFormat: 'wav_44100', voiceSettings: { stability: 0.5, similarityBoost: 0.5, useSpeakerBoost: false } }, ...extra });
}
export function capability(p, extra = {}) {
  return { connectorId: p.connectorId, mode: p.mode, action: p.action, scopeIdentity: p.scopeIdentity, modelId: p.input.modelId ?? 'audio-isolation', detected: true, authenticated: true, verified: true, checkedAt: NOW - 1000, expiresAt: NOW + 30000, evidenceDigest: H, ...extra };
}
export function setup(t) {
  const parent = resolve('tests/media-connectors/.tmp'); mkdirSync(parent, { recursive: true });
  const root = realpathSync(mkdtempSync(`${parent}/case-`));
  const journal = new RequestJournal({ root, clock: () => NOW, assetHosts: ['media.higgsfield.ai'] });
  t.after(() => { try { journal.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return { root, journal };
}
export const catalog = [{ modelId: 'fixture/video/v1', endpoint: 'https://api.higgsfield.ai/fixture/video/v1', documentation: 'https://docs.higgsfield.ai/docs/fixture', schemaDigest: H, capability: 'VIDEO_GENERATION', environment: 'PRODUCTION', parametersVerified: true }];
export const hfBody = (status = 'queued', id = 'job-123') => ({ status, request_id: id, status_url: `https://api.higgsfield.ai/requests/${id}/status`, cancel_url: `https://api.higgsfield.ai/requests/${id}/cancel`, ...(status === 'completed' ? { video: { url: 'https://media.higgsfield.ai/test.mp4' } } : {}) });
export function wav() {
  const b = Buffer.alloc(364); b.write('RIFF', 0); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(320, 40); return b;
}
// Test-only minimal PCM-WAV inspector, not a production FFmpeg replacement.
export function probe(bytes, kind) {
  requireThat(kind === 'audio' && bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE' && bytes.readUInt32LE(4) + 8 === bytes.length, 'PROBE_FAILED');
  return { sha256: sha256(bytes), kind, valid: true, durationMs: Math.round(bytes.readUInt32LE(40) / bytes.readUInt32LE(28) * 1000), codec: 'pcm_s16le' };
}
