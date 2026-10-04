import {constants, lstatSync, openSync, fstatSync, readSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync, mkdirSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {supportManifests} from './support-doctor.mjs';
import {createConnectorState, validateConnectorState, capabilityBinding, parseConnectorJson} from './registry.mjs';

// Private local check cache, not an import API or authorization store. Only a
// trusted provider adapter should call the writer after observing its result.
// Same-user disk tampering is outside this cache's integrity boundary; digests
// bind evidence but are not authentication. No account secrets are retained.
const MAX_BYTES = 131072;
export const OBSERVATION_TTL_MS = 15 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
function requireSafe(ok) { if (!ok) throw Error('INVALID_LOCAL_OBSERVATION'); }
function rootInfo(directory, create = false) {
  requireSafe(path.isAbsolute(directory));
  if (create) mkdirSync(directory, {recursive: true, mode: 0o700});
  const stat = lstatSync(directory);
  requireSafe(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0);
  const resolved = realpathSync(directory);
  requireSafe(resolved === path.resolve(directory));
  return {scopeIdentity: hash('redwood-local-provider-check-v1\n' + resolved), file: path.join(directory, 'observations.json')};
}
function readStore(file, scopeIdentity) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    requireSafe(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 && stat.size <= MAX_BYTES);
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0); requireSafe(count <= MAX_BYTES);
    const store = parseConnectorJson(bytes.subarray(0, count).toString('utf8'));
    requireSafe(Object.keys(store).sort().join(',') === 'records,schemaVersion,scopeIdentity' && store.schemaVersion === 1 && store.scopeIdentity === scopeIdentity);
    requireSafe(Array.isArray(store.records) && store.records.length <= 6);
    const manifests = supportManifests(), seen = new Set();
    for (const record of store.records) {
      requireSafe(Object.keys(record).sort().join(',') === 'connectorId,label,state' && !seen.has(record.connectorId));
      seen.add(record.connectorId);
      requireSafe(typeof record.label === 'string' && record.label.length <= 200 && /^[A-Za-z0-9 _.():;/=-]+$/.test(record.label));
      const manifest = manifests.find(m => m.id === record.connectorId); requireSafe(manifest);
      record.state = validateConnectorState(record.state, manifest);
      requireSafe(record.state.scopeIdentity === scopeIdentity && Date.parse(record.state.expiresAt) - Date.parse(record.state.lastCheckedAt) <= OBSERVATION_TTL_MS);
    }
    return store;
  } catch (error) {
    if (error.code === 'ENOENT') return {schemaVersion: 1, scopeIdentity, records: []};
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function readLocalObservations(directory) {
  try {
    const {file, scopeIdentity} = rootInfo(directory);
    const store = readStore(file, scopeIdentity);
    return {scopeIdentity, observations: store.records.map(({connectorId, state}) => ({connectorId, state})),
      labels: Object.fromEntries(store.records.map(r => [r.connectorId, r.label]))};
  } catch { return {scopeIdentity: null, observations: [], labels: {}}; }
}

export function recordLocalObservation(directory, {connectorId, mode, detected, authenticated, billingMode,
  verifiedCapabilities = [], evidenceDigest, label, now = new Date().toISOString(), ttlMs = OBSERVATION_TTL_MS}) {
  requireSafe(Number.isSafeInteger(ttlMs) && ttlMs > 0 && ttlMs <= OBSERVATION_TTL_MS);
  requireSafe(typeof label === 'string' && label.length > 0 && label.length <= 200 && /^[A-Za-z0-9 _.():;/=-]+$/.test(label));
  const {file, scopeIdentity} = rootInfo(directory, true);
  const manifest = supportManifests().find(m => m.id === connectorId); requireSafe(manifest);
  const lastCheckedAt = new Date(now).toISOString(), expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
  const state = {...createConnectorState(manifest), mode, detected, authenticated, billingMode, scopeIdentity,
    lastCheckedAt, expiresAt, verifiedCapabilities, unknownCapabilities: manifest.capabilities.filter(c => !verifiedCapabilities.includes(c))};
  state.capabilityEvidence = verifiedCapabilities.map(capability => ({capability, evidenceDigest,
    bindingDigest: capabilityBinding(manifest, {mode, billingMode, scopeIdentity, lastCheckedAt, expiresAt, capability, evidenceDigest})}));
  validateConnectorState(state, manifest);
  // Fail closed on a concurrent writer or corrupt existing cache; never silently
  // overwrite another adapter's check. A stale lock requires explicit inspection.
  const lock = file + '.lock'; let lockFd, temp, fd;
  try {
    lockFd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const store = readStore(file, scopeIdentity);
    store.records = [...store.records.filter(r => r.connectorId !== connectorId), {connectorId, label, state}];
    const bytes = JSON.stringify(store) + '\n'; requireSafe(Buffer.byteLength(bytes) <= MAX_BYTES);
    temp = file + '.' + randomUUID();
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, file); temp = undefined;
    const dirFd = openSync(directory, constants.O_RDONLY); try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    return state;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (temp) try { unlinkSync(temp); } catch { /* Preserve original error. */ }
    if (lockFd !== undefined) { closeSync(lockFd); unlinkSync(lock); }
  }
}
