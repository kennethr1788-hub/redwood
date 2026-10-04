import { constants, lstatSync, openSync, closeSync, writeSync, fsyncSync } from 'node:fs';
import { resolve, sep, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat, relativePath, sha256, shape, json, integer, hash } from './contract.mjs';

export const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const CODECS = { audio: ['pcm_s16le', 'mp3', 'flac', 'aac'], video: ['h264', 'hevc', 'vp9', 'av1'] };
// Private root must already exist and be owned by the local integration. No crawl.
export function checkedRoot(root) {
  requireThat(typeof root === 'string' && root === resolve(root), 'UNSAFE_ROOT');
  let current = sep;
  for (const part of root.split(sep).filter(Boolean)) {
    current = join(current, part);
    const st = lstatSync(current);
    requireThat(st.isDirectory() && !st.isSymbolicLink(), 'UNSAFE_ROOT');
  }
  return root;
}
export function checkedFile(root, relative) {
  checkedRoot(root); relativePath(relative);
  const parts = relative.split('/'); let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]); const st = lstatSync(current);
    requireThat(!st.isSymbolicLink(), 'UNSAFE_FILE');
    requireThat(i === parts.length - 1 ? st.isFile() && st.nlink === 1 : st.isDirectory(), 'UNSAFE_FILE');
  }
  return current;
}
export function readBoundFile(root, metadata) {
  const path = checkedFile(root, metadata.path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    // Bounds checked on the open descriptor, not only the earlier pathname.
    const bytes = readFileSyncBounded(fd, 32 * 1024 * 1024);
    requireThat(bytes.length === metadata.bytes && sha256(bytes) === metadata.sha256, 'INPUT_CHANGED');
    return bytes;
  } finally { closeSync(fd); }
}
import { fstatSync, readSync } from 'node:fs';
function readFileSyncBounded(fd, max) {
  const st = fstatSync(fd);
  requireThat(st.isFile() && st.nlink === 1 && st.size > 0 && st.size <= max, 'UNSAFE_FILE');
  const out = Buffer.alloc(st.size + 1); let used = 0;
  while (used < out.length) { const n = readSync(fd, out, used, out.length - used, null); if (!n) break; used += n; }
  requireThat(used === st.size, 'FILE_CHANGED');
  return out.subarray(0, used);
}
export async function collectAudio(stream, signal) {
  const parts = []; let size = 0;
  requireThat(typeof stream?.getReader === 'function', 'INVALID_MEDIA');
  const reader = stream.getReader();
  const abort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      requireThat(!signal?.aborted, 'INTERRUPTED');
      const { value: chunk, done } = await reader.read(); if (done) break;
      requireThat(chunk instanceof Uint8Array, 'INVALID_MEDIA');
      size += chunk.byteLength; requireThat(size <= MAX_ASSET_BYTES, 'ASSET_TOO_LARGE');
      parts.push(Buffer.from(chunk));
    }
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
  requireThat(!signal?.aborted, 'INTERRUPTED');
  requireThat(size > 0, 'EMPTY_MEDIA');
  return Buffer.concat(parts, size);
}
// A trusted local probe must decode/inspect the exact supplied bytes. Provider
// metadata is not a probe. This leaf never spawns a shell or replaces source audio.
export async function importAsset({ root, bytes, kind, requestId, providerRequestId, probe, signal }) {
  checkedRoot(root); requireThat(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= MAX_ASSET_BYTES, 'INVALID_MEDIA');
  requireThat(['audio', 'video'].includes(kind) && typeof probe === 'function', 'PROBE_REQUIRED');
  const buffer = Buffer.from(bytes), outputHash = sha256(buffer);
  const result = json(await probe(buffer, kind));
  requireThat(!signal?.aborted, 'INTERRUPTED');
  shape(result, ['sha256', 'kind', 'durationMs', 'codec', 'valid']);
  requireThat(result.valid === true && result.sha256 === outputHash && result.kind === kind, 'PROBE_FAILED');
  integer(result.durationMs, 1, 3600000);
  requireThat(CODECS[kind].includes(result.codec), 'PROBE_FAILED');
  const relative = `asset-${randomUUID()}.bin`, path = join(root, relative);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { let offset = 0; while (offset < buffer.length) offset += writeSync(fd, buffer, offset); fsyncSync(fd); } finally { closeSync(fd); }
  const dir = openSync(root, constants.O_RDONLY); try { fsyncSync(dir); } finally { closeSync(dir); }
  return { path: relative, sha256: outputHash, bytes: buffer.length, kind, probe: result, requestId, providerRequestId, review: 'UNREVIEWED' };
}
export function validateAsset(asset, request) {
  asset = json(asset);
  shape(asset, ['path', 'sha256', 'bytes', 'kind', 'probe', 'requestId', 'providerRequestId', 'review']);
  relativePath(asset.path); hash(asset.sha256); integer(asset.bytes, 1, MAX_ASSET_BYTES);
  requireThat(asset.requestId === request.requestId && asset.providerRequestId === request.providerRequestId && asset.review === 'UNREVIEWED', 'ASSET_BINDING');
  shape(asset.probe, ['sha256', 'kind', 'durationMs', 'codec', 'valid']);
  requireThat(asset.probe.valid === true && asset.probe.sha256 === asset.sha256 && asset.probe.kind === asset.kind, 'PROBE_FAILED');
  requireThat(asset.kind === (request.action === 'VIDEO_GENERATION' ? 'video' : 'audio'), 'ASSET_KIND');
  requireThat(CODECS[asset.kind]?.includes(asset.probe.codec), 'PROBE_FAILED');
  integer(asset.probe.durationMs, 1, 3600000);
  return asset;
}
export function verifyAsset(root, asset) {
  try {
    const fd = openSync(checkedFile(root, asset.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const bytes = readFileSyncBounded(fd, MAX_ASSET_BYTES); return bytes.length === asset.bytes && sha256(bytes) === asset.sha256; } finally { closeSync(fd); }
  } catch { return false; }
}
