import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, symlinkSync, linkSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {recordLocalObservation, readLocalObservations, OBSERVATION_TTL_MS} from '../../integrations/connectors/local-observations.mjs';
import {supportDoctor} from '../../integrations/connectors/support-doctor.mjs';

const now = '2026-10-04T08:00:00.000Z';
const observed = {connectorId: 'higgsfield', mode: 'AGENT_ACCOUNT', detected: true, authenticated: true,
  billingMode: 'ACCOUNT_CREDITS', verifiedCapabilities: ['VIDEO_GENERATION'], evidenceDigest: 'b'.repeat(64),
  label: 'grok_video; 1 second; 16:9; synthetic qualification', now};
function fixture(t) { const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'redwood-observations-'))); t.after(() => rmSync(root, {recursive: true, force: true})); return path.join(root, 'connections'); }

test('observed provider state reopens with exact mode, scope and no authority', t => {
  const dir = fixture(t); recordLocalObservation(dir, observed);
  const report = supportDoctor(now, readLocalObservations(dir));
  const row = report.rows.find(r => r.connectorId === 'higgsfield');
  assert.equal(row.status, 'VERIFIED'); assert.equal(row.mode, 'AGENT_ACCOUNT');
  assert.equal(row.billingMode, 'ACCOUNT_CREDITS'); assert.equal(row.actionAuthorization, 'NOT_GRANTED');
  assert.equal(row.qualificationScope, observed.label); assert.equal(row.costEstimate, null);
  assert.equal(report.providerRuntimeQualification, 'VERIFIED_FOR_RECORDED_SCOPE');
  assert.equal(report.rows.find(r => r.connectorId === 'elevenlabs').status, 'UNKNOWN');
  assert.equal(report.productCompletion, 'NOT_ASSESSED');
});
test('expiration and a different cache directory cannot preserve verification', t => {
  const dir = fixture(t); recordLocalObservation(dir, observed);
  const later = new Date(Date.parse(now) + OBSERVATION_TTL_MS).toISOString();
  assert.equal(supportDoctor(later, readLocalObservations(dir)).rows.find(r => r.connectorId === 'higgsfield').status, 'UNKNOWN');
  const other = path.join(path.dirname(dir), 'other'); mkdirSync(other, {mode: 0o700});
  writeFileSync(path.join(other, 'observations.json'), readFileSync(path.join(dir, 'observations.json')), {mode: 0o600});
  assert.equal(readLocalObservations(other).observations.length, 0);
});
test('authentication-only observation does not become a verified capability', t => {
  const dir = fixture(t); recordLocalObservation(dir, {...observed, verifiedCapabilities: []});
  const row = supportDoctor(now, readLocalObservations(dir)).rows.find(r => r.connectorId === 'higgsfield');
  assert.equal(row.status, 'AUTHENTICATED'); assert.equal(row.capabilityStates[0].state, 'UNKNOWN');
});
test('malformed, public and linked cache files fail closed', t => {
  const dir = fixture(t); recordLocalObservation(dir, observed); const file = path.join(dir, 'observations.json');
  chmodSync(file, 0o644); assert.equal(readLocalObservations(dir).observations.length, 0);
  chmodSync(file, 0o600); const linked = path.join(path.dirname(dir), 'copy'); linkSync(file, linked);
  assert.equal(readLocalObservations(dir).observations.length, 0); rmSync(linked);
  writeFileSync(file, '{bad'); assert.equal(readLocalObservations(dir).observations.length, 0);
  rmSync(file); symlinkSync('/dev/null', file); assert.equal(readLocalObservations(dir).observations.length, 0);
});
test('writer refuses public or symlinked roots, excess TTL and invalid evidence', t => {
  const dir = fixture(t); mkdirSync(dir, {mode: 0o755}); chmodSync(dir, 0o755);
  assert.throws(() => recordLocalObservation(dir, observed)); chmodSync(dir, 0o700);
  const alias = path.join(path.dirname(dir), 'alias'); symlinkSync(dir, alias);
  assert.throws(() => recordLocalObservation(alias, observed));
  assert.throws(() => recordLocalObservation(dir, {...observed, ttlMs: OBSERVATION_TTL_MS + 1}));
  assert.throws(() => recordLocalObservation(dir, {...observed, evidenceDigest: 'invalid'}));
});
test('distinct connector observations survive append; concurrent writer fails without overwriting', t => {
  const dir = fixture(t); recordLocalObservation(dir, observed);
  recordLocalObservation(dir, {...observed, connectorId: 'codex', mode: 'OFFICIAL_CLIENT', billingMode: 'SUBSCRIPTION', verifiedCapabilities: ['AGENT_EXECUTION'], label: 'codex; synthetic source-edit task'});
  assert.equal(readLocalObservations(dir).observations.length, 2);
  const file = path.join(dir, 'observations.json'), before = readFileSync(file);
  writeFileSync(file + '.lock', '', {mode: 0o600});
  assert.throws(() => recordLocalObservation(dir, observed)); assert.deepEqual(readFileSync(file), before);
});
