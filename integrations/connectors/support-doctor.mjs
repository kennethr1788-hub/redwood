import {ADAPTERS} from '../agents/adapters.mjs';
import {aggregateDoctor, createRegistry} from './registry.mjs';
import {manifests as mediaManifests} from '../media/contract.mjs';

export function supportManifests() {
  const agents = Object.values(ADAPTERS).filter(a => a.id !== 'manual').map(a => ({schemaVersion: 1, id: a.id,
    displayName: a.displayName, category: 'AGENT', modes: ['OFFICIAL_CLIENT'], capabilities: ['AGENT_EXECUTION'],
    authOwner: 'PROVIDER_CLIENT', billingModes: ['SUBSCRIPTION', 'API_METERED'], doctorCapabilities: ['DETECTION', 'AUTH_STATUS'],
    products: ['BUILD', 'STUDIO', 'GROW'], externalEffects: ['RUN_LOCAL', 'WRITE_LOCAL', 'GENERATE_REMOTE'],
    modeBindings: [{mode: 'OFFICIAL_CLIENT', capabilities: ['AGENT_EXECUTION'], billingModes: ['SUBSCRIPTION', 'API_METERED'], authRequired: true}]}));
  const media = mediaManifests();
  return createRegistry([...agents, ...media]);
}

// Observations are supplied by the local host, never accepted from an HTTP body.
// They describe past checks and cannot authorize another provider operation.
export function supportDoctor(now, {observations = [], scopeIdentity = null, labels = {}} = {}) {
  const doctor = aggregateDoctor(supportManifests(), observations, {now, scopeIdentity});
  const rows = doctor.rows.map(row => labels[row.connectorId] ? {...row, qualificationScope: labels[row.connectorId]} : row);
  return {...doctor, rows,
    mediaIntegration: 'OFFLINE_QUALIFIED', manualHandoff: 'AVAILABLE',
    providerRuntimeQualification: rows.some(row => row.freshness === 'CURRENT' && row.capabilityStates.some(c => c.state === 'VERIFIED'))
      ? 'VERIFIED_FOR_RECORDED_SCOPE'
      : observations.some(o => o.state?.verifiedCapabilities?.length) ? 'STALE_OR_UNBOUND' : 'NOT_RUN'};
}
