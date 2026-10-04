import { array, enumeration as one, id, object, optional, schema, text, timestamp, unique, canonicalJSON } from '../resume/validation.mjs';

export const STARTING_POINTS = Object.freeze(['IDEA', 'REPO', 'APP_OR_RECORDING', 'GROW_INPUTS']);
export const CONNECTION_STATES = Object.freeze(['NOT_DETECTED', 'DETECTED', 'AUTHENTICATED', 'VERIFIED', 'LIMITED', 'NEEDS_SETUP', 'ERROR', 'UNKNOWN']);
const check = object({ id, scope: one('CORE', 'AGENT', 'OPTIONAL_CONNECTOR'), status: one(...CONNECTION_STATES), summary: text() });
export const OnboardingInput = schema(object({
  schemaVersion: one(1), startingPoint: one(...STARTING_POINTS), projectName: text(100), desiredOutcome: text(1000),
  audience: optional(text()), brand: optional(object({ name: optional(text(100)), tone: optional(text(200)), colors: optional(array(v => /^#[a-fA-F0-9]{6}$/.test(v) ? v : one()(v), 6)) })),
  selectedAgentAdapterId: id, connectors: v => unique(array(id, 16)(v)),
  doctor: object({ checkedAt: timestamp, checks: v => unique(array(check, 32)(v), c => c.scope + ':' + c.id) }),
}));

export function createOnboarding(input) {
  const data = OnboardingInput.parse(input);
  const core = data.doctor.checks.filter(c => c.scope === 'CORE');
  const required = [...core];
  if (!['manual', 'generic'].includes(data.selectedAgentAdapterId)) {
    required.push(data.doctor.checks.find(c => c.scope === 'AGENT' && c.id === data.selectedAgentAdapterId)
      ?? { id: data.selectedAgentAdapterId, scope: 'AGENT', status: 'UNKNOWN', summary: 'Selected agent readiness has not been verified.' });
  }
  const blockers = required.filter(c => c.status !== 'VERIFIED');
  const state = !core.length ? 'UNKNOWN' : blockers.some(c => ['NOT_DETECTED', 'LIMITED', 'NEEDS_SETUP', 'ERROR'].includes(c.status))
    ? 'NEEDS_SETUP' : blockers.length ? 'UNKNOWN' : 'READY';
  return { ...data, product: { IDEA: 'build', REPO: 'build', APP_OR_RECORDING: 'studio', GROW_INPUTS: 'grow' }[data.startingPoint],
    readiness: { state, blockers, optionalWarnings: data.doctor.checks.filter(c => c.scope === 'OPTIONAL_CONNECTOR' && data.connectors.includes(c.id) && c.status !== 'VERIFIED') },
  };
}

// The saved setup contains only the minimal input; readiness is always derived again.
export function serializeOnboarding(input) { return canonicalJSON(OnboardingInput.parse(input)); }
