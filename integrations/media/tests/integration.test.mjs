import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {manifests} from '../contract.mjs';
import {supportDoctor} from '../../connectors/support-doctor.mjs';
import {aggregateDoctor, createRegistry, createConnectorState, capabilityBinding} from '../../connectors/registry.mjs';

const now = '2026-10-04T05:00:00.000Z', scopeIdentity = 'a'.repeat(64);
const current = {now, scopeIdentity};
const registry = createRegistry(manifests());
function observed(connectorId, mode, verifiedCapabilities) {
  const manifest = registry.find(m => m.id === connectorId);
  const state = {...createConnectorState(manifest), mode, detected: true, authenticated: true,
    billingMode: mode === 'AGENT_ACCOUNT' ? 'ACCOUNT_CREDITS' : 'API_METERED', scopeIdentity,
    lastCheckedAt: '2026-10-04T04:59:00.000Z', expiresAt: '2026-10-04T05:01:00.000Z',
    verifiedCapabilities, unknownCapabilities: manifest.capabilities.filter(c => !verifiedCapabilities.includes(c))};
  state.capabilityEvidence = verifiedCapabilities.map(capability => {
    const evidenceDigest = 'b'.repeat(64);
    const {billingMode, lastCheckedAt, expiresAt} = state;
    return {capability, evidenceDigest, bindingDigest: capabilityBinding(manifest,
      {mode, billingMode, scopeIdentity, lastCheckedAt, expiresAt, capability, evidenceDigest})};
  });
  return {connectorId, state};
}

test('shared doctor consumes exactly the admitted media declarations, not placeholder capabilities', () => {
  const doctor = supportDoctor(now);
  const rows = doctor.rows.filter(r => registry.some(m => m.id === r.connectorId));
  assert.deepEqual(rows, aggregateDoctor(registry, [], {now, scopeIdentity: null}).rows);
  assert.equal(doctor.mediaIntegration, 'OFFLINE_QUALIFIED');
  assert.equal(doctor.providerRuntimeQualification, 'NOT_RUN');
  assert.equal(doctor.selectionStatus, 'NO_CONNECTOR_REQUIREMENTS');
  assert.equal(doctor.baseline, 'UNAFFECTED_BY_CONNECTORS');
  assert.equal(doctor.productCompletion, 'NOT_ASSESSED');
  assert.equal(doctor.actionAuthorization, 'NOT_GRANTED');
  assert.deepEqual(registry.find(m => m.id === 'higgsfield').capabilities, ['VIDEO_GENERATION']);
  for (const row of rows) {
    assert.equal(row.status, 'UNKNOWN'); assert.equal(row.freshness, 'NOT_CHECKED');
    assert.equal(row.authenticated, null); assert.equal(row.costEstimate, null);
    assert.equal(row.billingMode, 'UNKNOWN');
    assert.ok(row.capabilityStates.every(c => c.state === 'UNKNOWN'));
  }
});

test('baseline doctor loads without the optional SDK, SQLite, private state or connector installation', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const result = spawnSync(process.execPath, ['--permission',
    '--allow-fs-read=integrations/agents', '--allow-fs-read=integrations/connectors',
    // Pure centralized display data is shared by portable task presentation.
    // Keep all launcher runtime, optional SDK, database and private data denied.
    '--allow-fs-read=launcher/src/display-names.js', '--allow-fs-read=launcher/package.json',
    '--allow-fs-read=integrations/media/contract.mjs', '--input-type=module', '-e',
    `import {supportDoctor} from './integrations/connectors/support-doctor.mjs';
     console.log(JSON.stringify(supportDoctor('${now}')));`], {cwd: root, encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).selectionStatus, 'NO_CONNECTOR_REQUIREMENTS');
});

for (const mode of ['AGENT_ACCOUNT', 'DIRECT_API']) test(`fake Higgsfield ${mode} evidence stays mode-bound`, () => {
  const observation = observed('higgsfield', mode, ['VIDEO_GENERATION']);
  const other = mode === 'AGENT_ACCOUNT' ? 'DIRECT_API' : 'AGENT_ACCOUNT';
  const report = aggregateDoctor(registry, [observation], current, [mode, other].map(selected =>
    ({connectorId: 'higgsfield', mode: selected, capability: 'VIDEO_GENERATION', product: 'STUDIO'})));
  const row = report.rows.find(r => r.connectorId === 'higgsfield');
  assert.equal(row.status, 'VERIFIED'); assert.equal(row.mode, mode);
  assert.equal(row.billingMode, mode === 'AGENT_ACCOUNT' ? 'ACCOUNT_CREDITS' : 'API_METERED');
  assert.deepEqual(report.requirements.map(r => r.capabilityVerified), [true, false]);
  assert.equal(report.actionAuthorization, 'NOT_GRANTED');
  // Caller-supplied fake evidence never enters the public product doctor.
  assert.equal(supportDoctor(now).rows.find(r => r.connectorId === 'higgsfield').status, 'UNKNOWN');
});

for (const capability of ['TEXT_TO_SPEECH', 'AUDIO_ISOLATION']) test(`fake ElevenLabs ${capability} does not qualify its sibling`, () => {
  const report = aggregateDoctor(registry, [observed('elevenlabs', 'DIRECT_API', [capability])], current);
  const row = report.rows.find(r => r.connectorId === 'elevenlabs');
  assert.equal(row.status, 'LIMITED');
  assert.equal(row.capabilityStates.find(c => c.capability === capability).state, 'VERIFIED');
  assert.equal(row.capabilityStates.find(c => c.capability !== capability).state, 'UNKNOWN');
  assert.equal(row.actionAuthorization, 'NOT_GRANTED');
});

test('ElevenLabs account TTS observation cannot verify account isolation', () => {
  const report = aggregateDoctor(registry, [observed('elevenlabs', 'AGENT_ACCOUNT', ['TEXT_TO_SPEECH'])], current);
  const row = report.rows.find(r => r.connectorId === 'elevenlabs');
  assert.equal(row.billingMode, 'ACCOUNT_CREDITS');
  assert.equal(row.capabilityStates.find(c => c.capability === 'AUDIO_ISOLATION').state, 'UNSUPPORTED_MODE');
});

test('expired or changed-scope media observations cannot survive reopen as provider readiness', () => {
  const observation = observed('elevenlabs', 'DIRECT_API', ['TEXT_TO_SPEECH']);
  for (const context of [{...current, now: '2026-10-04T05:01:00.000Z'}, {...current, scopeIdentity: 'c'.repeat(64)}]) {
    const row = aggregateDoctor(registry, [observation], context).rows.find(r => r.connectorId === 'elevenlabs');
    assert.equal(row.status, 'UNKNOWN'); assert.equal(row.freshness, 'STALE_OR_UNBOUND');
    assert.ok(row.capabilityStates.every(c => c.state === 'UNKNOWN'));
  }
});
