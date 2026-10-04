import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, openSync, closeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { checkedRoot, validateAsset } from './assets.mjs';
import { canonical, sha256, shape, token, hash, integer, requireThat, checkPlan, quote, STATES, TERMINAL, MediaError } from './contract.mjs';
import { receipt } from './receipt.mjs';

export function transitionAllowed(from, to) {
  if (!STATES.includes(from) || !STATES.includes(to)) return false;
  if (from === 'DRAFT') return to === 'SUBMITTED';
  if (TERMINAL.includes(from)) return false;
  if (from === 'PROCESSING' && to === 'SUBMITTED') return false;
  return to !== 'DRAFT';
}
function validateRecord(r) {
  shape(r, ['schemaVersion', 'requestId', 'effectDigest', 'inputDigest', 'intentId', 'connectorId', 'mode', 'action', 'sourceIdentity', 'scopeIdentity', 'billingMode', 'state', 'providerRequestId', 'providerReceipt', 'outputAssets', 'expectedCost', 'createdAt', 'submittedAt', 'updatedAt', 'revision']);
  requireThat(r.schemaVersion === 1 && STATES.includes(r.state), 'JOURNAL_CORRUPT');
  token(r.requestId); token(r.intentId);
  ['effectDigest', 'inputDigest', 'sourceIdentity', 'scopeIdentity'].forEach(k => hash(r[k]));
  integer(r.revision, 0, Number.MAX_SAFE_INTEGER);
  requireThat(Array.isArray(r.outputAssets) && r.outputAssets.length <= 8, 'JOURNAL_CORRUPT');
  requireThat(r.mode === 'DIRECT_API' ? r.billingMode === 'API_METERED' : r.mode === 'AGENT_ACCOUNT' && r.billingMode === 'ACCOUNT_CREDITS', 'JOURNAL_CORRUPT');
  return r;
}

/** SQLite supplies the transaction, cross-process CAS and crash recovery. The
 * private local journal is not an import format and never contains raw inputs. */
export class RequestJournal {
  #db; #clock; #hosts;
  constructor({ root, clock = Date.now, assetHosts = [] }) {
    checkedRoot(root);
    const st = lstatSync(root);
    requireThat((st.mode & 0o077) === 0 && st.uid === process.getuid(), 'PRIVATE_ROOT_REQUIRED');
    const path = join(root, 'requests.sqlite');
    for (const name of ['requests.sqlite', 'requests.sqlite-wal', 'requests.sqlite-shm']) {
      const full = join(root, name);
      if (existsSync(full)) { const s = lstatSync(full); requireThat(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && (s.mode & 0o077) === 0, 'UNSAFE_JOURNAL'); }
    }
    if (!existsSync(path)) { try { const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); closeSync(fd); } catch (e) { if (e.code !== 'EEXIST') throw new MediaError('JOURNAL_OPEN_FAILED'); } }
    this.#db = new DatabaseSync(path); this.#clock = clock; this.#hosts = [...assetHosts];
    this.#db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA max_page_count=16384; PRAGMA journal_size_limit=8388608;');
    this.#db.exec('CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, effect TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, payload TEXT NOT NULL, checksum TEXT NOT NULL);');
  }
  close() { this.#db.close(); }
  #decode(row) {
    requireThat(row && row.payload.length <= 131072 && sha256(row.payload) === row.checksum, 'JOURNAL_CORRUPT');
    const value = validateRecord(JSON.parse(row.payload));
    requireThat(value.requestId === row.id && value.revision === row.revision && value.effectDigest === row.effect, 'JOURNAL_CORRUPT');
    return value;
  }
  get(id) { token(id); const row = this.#db.prepare('SELECT * FROM requests WHERE id=?').get(id); requireThat(row, 'REQUEST_NOT_FOUND'); return this.#decode(row); }
  reserve(value, expectedQuote = null) {
    const p = checkPlan(value), now = this.#clock(), expectedCost = quote(expectedQuote, p, now);
    const r = { schemaVersion: 1, requestId: randomUUID(), effectDigest: p.effectDigest, inputDigest: p.inputDigest,
      intentId: p.intentId, connectorId: p.connectorId, mode: p.mode, action: p.action, sourceIdentity: p.sourceIdentity, scopeIdentity: p.scopeIdentity, billingMode: p.billingMode,
      state: 'DRAFT', providerRequestId: null, providerReceipt: null, outputAssets: [], expectedCost,
      createdAt: now, submittedAt: null, updatedAt: now, revision: 0 };
    const payload = canonical(r);
    this.#db.prepare('INSERT INTO requests (id,effect,revision,payload,checksum) VALUES (?,?,?,?,?) ON CONFLICT(effect) DO NOTHING').run(r.requestId, r.effectDigest, 0, payload, sha256(payload));
    return this.#decode(this.#db.prepare('SELECT * FROM requests WHERE effect=?').get(r.effectDigest));
  }
  #update(r, changes) {
    const next = validateRecord({ ...r, ...changes, revision: r.revision + 1, updatedAt: this.#clock() }), payload = canonical(next);
    const result = this.#db.prepare('UPDATE requests SET revision=?,payload=?,checksum=? WHERE id=? AND revision=?').run(next.revision, payload, sha256(payload), r.requestId, r.revision);
    requireThat(result.changes === 1, 'CONCURRENT_CHANGE');
    return next;
  }
  arm(id) {
    const r = this.get(id); requireThat(r.state === 'DRAFT', 'NO_RESUBMIT');
    return this.#update(r, { state: 'SUBMITTED', submittedAt: this.#clock() });
  }
  observe(id, revision, value) {
    const r = this.get(id); requireThat(r.revision === revision, 'CONCURRENT_CHANGE');
    const normalized = receipt(value, r, this.#hosts);
    requireThat(transitionAllowed(r.state, normalized.state), 'INVALID_TRANSITION');
    // A queued/in-progress reply to a cancel attempt does not retract the intent.
    const state = r.state === 'CANCEL_REQUESTED' && ['SUBMITTED', 'PROCESSING'].includes(normalized.state) ? 'CANCEL_REQUESTED' : normalized.state;
    return this.#update(r, { state, providerRequestId: normalized.providerRequestId, providerReceipt: normalized, outputAssets: [...r.outputAssets, ...normalized.outputAssets] });
  }
  requestCancel(id) {
    const r = this.get(id); requireThat(!TERMINAL.includes(r.state) && r.state !== 'DRAFT', 'INVALID_TRANSITION');
    requireThat(r.state !== 'CANCEL_REQUESTED', 'CANCEL_ALREADY_REQUESTED');
    return this.#update(r, { state: 'CANCEL_REQUESTED' });
  }
  uncertain(id, revision) {
    const r = this.get(id);
    if (r.revision !== revision || TERMINAL.includes(r.state)) return r;
    requireThat(r.state !== 'DRAFT', 'INVALID_TRANSITION');
    return this.#update(r, { state: 'UNKNOWN_RECONCILE' });
  }
  // Called only after the owning process is known stopped; never sweep another
  // live executor's work. There is deliberately no reset-to-DRAFT API.
  recover(id) { const r = this.get(id); return this.uncertain(id, r.revision); }
  attach(id, value) {
    const r = this.get(id); requireThat(r.state === 'SUCCEEDED', 'OUTPUT_NOT_READY');
    const asset = validateAsset(value, r);
    requireThat(r.outputAssets.length < 8 && !r.outputAssets.some(a => a.path === asset.path), 'DUPLICATE_ASSET');
    return this.#update(r, { outputAssets: [...r.outputAssets, asset] });
  }
}
