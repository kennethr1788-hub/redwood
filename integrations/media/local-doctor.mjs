import { fileURLToPath } from 'node:url';
import { recordLocalObservation } from '../connectors/local-observations.mjs';

// Optional UI projection only. Its lock/disk/validation failure must not alter
// provider/asset truth. Required journal and asset writes stay outside this catch.
export function projectCompletedObservation(observation, { directory = fileURLToPath(new URL('../../launcher/.local/connections', import.meta.url)),
  record = recordLocalObservation, warn = message => console.error(message) } = {}) {
  if (observation.kind !== 'COMPLETED') return;
  try {
    record(directory, { connectorId: observation.connectorId, mode: observation.mode, detected: true, authenticated: true,
      billingMode: 'ACCOUNT_CREDITS', verifiedCapabilities: [observation.action], evidenceDigest: observation.evidenceDigest,
      label: observation.connectorId === 'higgsfield' ? 'recovered existing grok_video job; fresh submit unqualified' : 'TTS only; eleven_multilingual_v2; Bella premade; synthetic qualification',
      now: new Date(observation.checkedAt).toISOString() });
  } catch { warn('LOCAL_DOCTOR_PROJECTION_FAILED'); }
}
