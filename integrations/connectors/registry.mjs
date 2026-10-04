import {createHash} from 'node:crypto';

// Data-only leaf. No discovery, credentials, persistence, transport or execution.
export const LIMITS = Object.freeze({bytes: 131072, nodes: 4096, depth: 8, connectors: 64, capabilities: 32, maxAgeMs: 86400000});
export const CAPABILITIES = Object.freeze(['MANUAL_HANDOFF', 'AGENT_EXECUTION', 'VIDEO_GENERATION', 'IMAGE_GENERATION', 'TEXT_TO_SPEECH', 'AUDIO_ISOLATION', 'DUBBING', 'EVIDENCE_IMPORT', 'CONTENT_IMPORT', 'MEDIA_IMPORT', 'PUBLISH']);
export const MODES = Object.freeze(['LOCAL_FILE', 'MANUAL', 'OFFICIAL_CLIENT', 'AGENT_ACCOUNT', 'DIRECT_API', 'OAUTH_READ']);
export const BILLING_MODES = Object.freeze(['NONE', 'SUBSCRIPTION', 'ACCOUNT_CREDITS', 'ACCOUNT_QUOTA', 'API_METERED', 'UNKNOWN']);
export const CONNECTION_STATES = Object.freeze(['NOT_DETECTED', 'DETECTED', 'AUTHENTICATED', 'VERIFIED', 'LIMITED', 'NEEDS_SETUP', 'ERROR', 'UNKNOWN']);
const WARNINGS = ['AUTH_NOT_OBSERVABLE', 'BILLING_UNKNOWN', 'QUOTA_UNKNOWN', 'PERMISSION_LIMITED', 'PARTIAL_COVERAGE', 'OWNER_RESULT_PENDING'];
const ERRORS = ['PROBE_FAILED', 'REVOKED', 'RATE_LIMITED', 'OWNER_UNAVAILABLE'];
const BILLING_LABELS = Object.freeze({NONE: 'No connector charge; local resource costs are separate', SUBSCRIPTION: 'Provider subscription; eligibility and limits apply', ACCOUNT_CREDITS: 'Provider account credits; balance and cost unverified', ACCOUNT_QUOTA: 'Provider account/API quota; charges unverified', API_METERED: 'Separate API billing; cost unverified', UNKNOWN: 'Billing unknown; select and verify a mode'});
const MODE_BILLING = Object.freeze({LOCAL_FILE: ['NONE'], MANUAL: ['NONE'], OFFICIAL_CLIENT: ['SUBSCRIPTION', 'ACCOUNT_QUOTA', 'API_METERED'], AGENT_ACCOUNT: ['SUBSCRIPTION', 'ACCOUNT_CREDITS', 'ACCOUNT_QUOTA', 'API_METERED'], DIRECT_API: ['API_METERED', 'ACCOUNT_QUOTA'], OAUTH_READ: ['ACCOUNT_QUOTA', 'API_METERED']});

export class ConnectorValidationError extends Error {
  constructor(code) { super(code); this.name = 'ConnectorValidationError'; this.code = code; }
}
const fail = code => { throw new ConnectorValidationError(code); };
const requireValue = (condition, code) => { if (!condition) fail(code); };

// Reject accessor-bearing objects before reading values. API inputs are inert JSON,
// not arbitrary executable JS objects/proxies. Errors never echo supplied data.
function copyJson(input) {
  let nodes = 0, bytes = 0;
  const seen = new Set();
  const visit = (v, depth) => {
    requireValue(++nodes <= LIMITS.nodes && depth <= LIMITS.depth, 'INPUT_LIMIT');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') { requireValue(Number.isFinite(v), 'INVALID_NUMBER'); return v; }
    if (typeof v === 'string') {
      requireValue(v.length <= LIMITS.bytes && v.isWellFormed(), 'INVALID_TEXT');
      bytes += Buffer.byteLength(v);
      requireValue(bytes <= LIMITS.bytes, 'INPUT_LIMIT');
      return v;
    }
    requireValue(v && typeof v === 'object' && !seen.has(v), 'INVALID_JSON');
    requireValue(Array.isArray(v) || [Object.prototype, null].includes(Object.getPrototypeOf(v)), 'INVALID_OBJECT');
    const keys = Reflect.ownKeys(v);
    requireValue(keys.length <= 129 && keys.every(k => typeof k === 'string' && !['__proto__', 'prototype', 'constructor'].includes(k)), 'INVALID_KEYS');
    seen.add(v);
    const out = Array.isArray(v) ? [] : {};
    if (Array.isArray(v)) requireValue(v.length <= 128 && keys.length === v.length + 1 && keys.every(k => k === 'length' || /^(0|[1-9][0-9]*)$/u.test(k)), 'INVALID_ARRAY');
    for (const k of keys) {
      if (Array.isArray(v) && k === 'length') continue;
      const d = Object.getOwnPropertyDescriptor(v, k);
      requireValue(d && Object.hasOwn(d, 'value') && d.enumerable, 'INVALID_PROPERTY');
      bytes += Buffer.byteLength(k);
      out[k] = visit(d.value, depth + 1);
    }
    seen.delete(v);
    requireValue(bytes <= LIMITS.bytes, 'INPUT_LIMIT');
    return out;
  };
  return visit(input, 0);
}
function exact(v, keys) {
  requireValue(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k)), 'SCHEMA_KEYS');
}
const choice = (v, values) => { requireValue(values.includes(v), 'INVALID_ENUM'); return v; };
function list(v, allowed, max = LIMITS.capabilities) {
  requireValue(Array.isArray(v) && v.length <= max && v.every(x => typeof x === 'string') && new Set(v).size === v.length, 'INVALID_LIST');
  v.forEach(x => choice(x, allowed));
  return [...v].sort();
}
function id(v) { requireValue(typeof v === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(v), 'INVALID_ID'); return v; }
function digest(v) { requireValue(typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v), 'INVALID_DIGEST'); return v; }
function time(v) {
  requireValue(typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v, 'INVALID_TIME');
  return Date.parse(v);
}
function freeze(v) { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; }
function stable(v) { return JSON.stringify(v && typeof v === 'object' ? Array.isArray(v) ? v.map(x => JSON.parse(stable(x))) : Object.fromEntries(Object.keys(v).sort().map(k => [k, JSON.parse(stable(v[k]))])) : v); }
const hash = v => createHash('sha256').update(stable(v)).digest('hex');

/** Strict ConnectorManifest v1. Declarations describe possibilities, never proof. */
export function validateConnectorManifest(input) {
  const m = copyJson(input);
  exact(m, ['schemaVersion', 'id', 'displayName', 'category', 'modes', 'capabilities', 'authOwner', 'billingModes', 'doctorCapabilities', 'products', 'externalEffects', 'modeBindings']);
  requireValue(m.schemaVersion === 1, 'SCHEMA_VERSION'); id(m.id);
  requireValue(typeof m.displayName === 'string' && m.displayName.trim() === m.displayName && m.displayName.length > 0 && m.displayName.length <= 100 && !/[\p{Cc}\p{Cf}<>]/u.test(m.displayName), 'INVALID_LABEL');
  choice(m.category, ['AGENT', 'MEDIA', 'EVIDENCE', 'SOURCE', 'PUBLISHING']);
  choice(m.authOwner, ['NONE', 'PROVIDER_CLIENT', 'EXTERNAL_ADAPTER']);
  m.modes = list(m.modes, MODES); requireValue(m.modes.length > 0, 'EMPTY_MODES');
  m.capabilities = list(m.capabilities, CAPABILITIES); requireValue(m.capabilities.length > 0, 'EMPTY_CAPABILITIES');
  m.billingModes = list(m.billingModes, BILLING_MODES.filter(v => v !== 'UNKNOWN'));
  m.doctorCapabilities = list(m.doctorCapabilities, ['DETECTION', 'AUTH_STATUS', 'CAPABILITY_CHECK', 'BILLING_CATEGORY']);
  m.products = list(m.products, ['BUILD', 'STUDIO', 'GROW']); requireValue(m.products.length > 0, 'EMPTY_PRODUCTS');
  m.externalEffects = list(m.externalEffects, ['READ_REMOTE', 'WRITE_LOCAL', 'RUN_LOCAL', 'GENERATE_REMOTE', 'PUBLISH_REMOTE']);
  requireValue(Array.isArray(m.modeBindings) && m.modeBindings.length === m.modes.length, 'MODE_BINDINGS_REQUIRED');
  const modes = new Set();
  for (const b of m.modeBindings) {
    exact(b, ['mode', 'capabilities', 'billingModes', 'authRequired']); choice(b.mode, m.modes);
    requireValue(!modes.has(b.mode), 'DUPLICATE_MODE'); modes.add(b.mode);
    b.capabilities = list(b.capabilities, m.capabilities); requireValue(b.capabilities.length > 0, 'EMPTY_CAPABILITIES');
    b.billingModes = list(b.billingModes, m.billingModes); requireValue(b.billingModes.length > 0 && b.billingModes.every(v => MODE_BILLING[b.mode].includes(v)), 'MODE_BILLING_MISMATCH');
    requireValue(typeof b.authRequired === 'boolean', 'INVALID_AUTH_REQUIREMENT');
    const local = ['LOCAL_FILE', 'MANUAL'].includes(b.mode);
    requireValue(local ? !b.authRequired && m.authOwner === 'NONE' : b.authRequired && m.authOwner !== 'NONE', 'AUTH_OWNER_MISMATCH');
  }
  requireValue(m.capabilities.every(v => m.modeBindings.some(b => b.capabilities.includes(v))) && m.billingModes.every(v => m.modeBindings.some(b => b.billingModes.includes(v))), 'UNBOUND_DECLARATION');
  m.modeBindings.sort((a, b) => a.mode.localeCompare(b.mode));
  return freeze(m);
}
export const manifestDigest = m => hash(validateConnectorManifest(m));

// The adapter retains this binding alongside the actual check evidence. Like all
// local digests, it prevents accidental reuse; it does not authenticate a caller.
export function capabilityBinding(manifest, input) {
  const m = validateConnectorManifest(manifest), s = copyJson(input);
  exact(s, ['mode', 'billingMode', 'scopeIdentity', 'lastCheckedAt', 'expiresAt', 'capability', 'evidenceDigest']);
  choice(s.mode, m.modes); digest(s.scopeIdentity); time(s.lastCheckedAt); time(s.expiresAt);
  choice(s.capability, m.modeBindings.find(b => b.mode === s.mode).capabilities); digest(s.evidenceDigest);
  choice(s.billingMode, [...m.modeBindings.find(b => b.mode === s.mode).billingModes, 'UNKNOWN']);
  return hash({manifestDigest: hash(m), ...s});
}

/** No secret fields, raw probe logs, account labels, URLs, paths or approvals. */
export function validateConnectorState(input, manifest) {
  const m = validateConnectorManifest(manifest), s = copyJson(input);
  exact(s, ['schemaVersion', 'connectorId', 'manifestDigest', 'mode', 'detected', 'authenticated', 'verifiedCapabilities', 'unknownCapabilities', 'unavailableCapabilities', 'capabilityEvidence', 'billingMode', 'scopeIdentity', 'lastCheckedAt', 'expiresAt', 'warnings', 'errorCode']);
  requireValue(s.schemaVersion === 1, 'SCHEMA_VERSION');
  requireValue(s.connectorId === m.id, 'CONNECTOR_MISMATCH'); digest(s.manifestDigest);
  if (s.mode !== null) choice(s.mode, m.modes);
  choice(s.detected, [true, false, null]); choice(s.authenticated, [true, false, null]);
  const binding = m.modeBindings.find(b => b.mode === s.mode);
  choice(s.billingMode, binding ? [...binding.billingModes, 'UNKNOWN'] : ['UNKNOWN']);
  requireValue(s.authenticated !== true || (s.detected === true && binding?.authRequired), 'AUTH_WITHOUT_DETECTION');
  requireValue(!binding || binding.authRequired || s.authenticated === null, 'LOCAL_AUTH_NOT_APPLICABLE');
  s.verifiedCapabilities = list(s.verifiedCapabilities, binding?.capabilities ?? []);
  s.unknownCapabilities = list(s.unknownCapabilities, m.capabilities);
  s.unavailableCapabilities = list(s.unavailableCapabilities, binding?.capabilities ?? []);
  const classified = [...s.verifiedCapabilities, ...s.unknownCapabilities, ...s.unavailableCapabilities];
  requireValue(new Set(classified).size === classified.length, 'CONTRADICTORY_CAPABILITIES');
  s.unknownCapabilities = [...new Set([...s.unknownCapabilities, ...m.capabilities.filter(c => !classified.includes(c))])].sort();
  s.warnings = list(s.warnings, WARNINGS);
  if (s.errorCode !== null) choice(s.errorCode, ERRORS);
  if (s.scopeIdentity !== null) digest(s.scopeIdentity);
  requireValue((s.lastCheckedAt === null) === (s.expiresAt === null), 'INCOMPLETE_CHECK_WINDOW');
  if (s.lastCheckedAt !== null) {
    const start = time(s.lastCheckedAt), end = time(s.expiresAt);
    requireValue(end > start && end - start <= LIMITS.maxAgeMs, 'INVALID_CHECK_WINDOW');
  }
  requireValue(Array.isArray(s.capabilityEvidence) && s.capabilityEvidence.length === s.verifiedCapabilities.length, 'EVIDENCE_REQUIRED');
  const evidenced = new Set();
  for (const e of s.capabilityEvidence) {
    exact(e, ['capability', 'evidenceDigest', 'bindingDigest']); choice(e.capability, s.verifiedCapabilities); digest(e.evidenceDigest); digest(e.bindingDigest);
    requireValue(!evidenced.has(e.capability), 'DUPLICATE_EVIDENCE'); evidenced.add(e.capability);
    // Bind the recorded declaration digest, so old declarations can be displayed
    // as stale by doctor rather than silently upgraded to the new manifest.
    requireValue(e.bindingDigest === hash({manifestDigest: s.manifestDigest, mode: s.mode, billingMode: s.billingMode, scopeIdentity: s.scopeIdentity, lastCheckedAt: s.lastCheckedAt, expiresAt: s.expiresAt, capability: e.capability, evidenceDigest: e.evidenceDigest}), 'EVIDENCE_BINDING_MISMATCH');
  }
  s.capabilityEvidence.sort((a, b) => a.capability.localeCompare(b.capability));
  if (s.verifiedCapabilities.length) {
    requireValue(s.detected === true && binding && (!binding.authRequired || s.authenticated === true) && s.lastCheckedAt !== null && s.scopeIdentity !== null && s.errorCode === null, 'UNSUPPORTED_VERIFICATION_CLAIM');
  }
  return freeze(s);
}

export function createConnectorState(manifest) {
  const m = validateConnectorManifest(manifest);
  return validateConnectorState({schemaVersion: 1, connectorId: m.id, manifestDigest: hash(m), mode: null, detected: null, authenticated: null, verifiedCapabilities: [], unknownCapabilities: m.capabilities, unavailableCapabilities: [], capabilityEvidence: [], billingMode: 'UNKNOWN', scopeIdentity: null, lastCheckedAt: null, expiresAt: null, warnings: [], errorCode: null}, m);
}

export function createRegistry(manifests) {
  requireValue(Array.isArray(manifests) && manifests.length <= LIMITS.connectors, 'REGISTRY_LIMIT');
  const values = manifests.map(validateConnectorManifest).sort((a, b) => a.id.localeCompare(b.id));
  requireValue(new Set(values.map(m => m.id)).size === values.length, 'DUPLICATE_CONNECTOR');
  return freeze(values);
}

function context(input) {
  const c = copyJson(input); exact(c, ['now', 'scopeIdentity']); time(c.now);
  if (c.scopeIdentity !== null) digest(c.scopeIdentity);
  return c;
}

/** Presentation only. Caller supplies current trusted local identity and clock. */
export function connectorDoctor(manifest, inputState, current) {
  const m = validateConnectorManifest(manifest), c = context(current);
  let s;
  try { s = inputState === undefined ? createConnectorState(m) : validateConnectorState(inputState, m); }
  catch (e) {
    if (!(e instanceof ConnectorValidationError)) throw e;
    s = createConnectorState(m);
    return row(m, s, 'ERROR', 'INVALID_STATE', [], [], ['INVALID_STATE']);
  }
  const checked = s.lastCheckedAt !== null && Date.parse(s.lastCheckedAt) <= Date.parse(c.now) && Date.parse(c.now) < Date.parse(s.expiresAt);
  const identity = s.manifestDigest === hash(m) && c.scopeIdentity !== null && c.scopeIdentity === s.scopeIdentity;
  if (!checked || !identity) return row(m, s, 'UNKNOWN', s.lastCheckedAt === null ? 'NOT_CHECKED' : 'STALE_OR_UNBOUND', [], [], [...s.warnings, 'CHECK_REQUIRED']);
  const binding = m.modeBindings.find(b => b.mode === s.mode);
  let status;
  if (s.errorCode) status = 'ERROR';
  else if (s.detected === false) status = 'NOT_DETECTED';
  else if (s.detected === null) status = 'UNKNOWN';
  else if (!binding) status = 'NEEDS_SETUP';
  else if (binding.authRequired && s.authenticated === false) status = 'NEEDS_SETUP';
  else if (binding.authRequired && s.authenticated === null) status = 'DETECTED';
  else if (s.verifiedCapabilities.length === binding.capabilities.length && s.billingMode !== 'UNKNOWN') status = 'VERIFIED';
  else if (s.verifiedCapabilities.length || s.unavailableCapabilities.length || s.billingMode === 'UNKNOWN') status = 'LIMITED';
  else status = binding.authRequired ? 'AUTHENTICATED' : 'DETECTED';
  return row(m, s, status, 'CURRENT', s.verifiedCapabilities, s.unavailableCapabilities, s.warnings);
}
function row(m, s, status, freshness, verified, unavailable, warnings) {
  const binding = m.modeBindings.find(b => b.mode === s.mode);
  return freeze({connectorId: m.id, displayName: m.displayName, products: m.products, status, freshness,
    mode: s.mode, billingMode: s.billingMode, billingLabel: BILLING_LABELS[s.billingMode], costEstimate: null,
    billingIsCurrent: freshness === 'CURRENT', detected: freshness === 'CURRENT' ? s.detected : null, authenticated: freshness === 'CURRENT' ? s.authenticated : null,
    capabilityStates: m.capabilities.map(capability => ({capability, state: binding && !binding.capabilities.includes(capability) ? 'UNSUPPORTED_MODE' : verified.includes(capability) ? 'VERIFIED' : unavailable.includes(capability) ? 'UNAVAILABLE' : 'UNKNOWN'})),
    warnings: [...new Set(warnings)].sort(), errorCode: freshness === 'INVALID_STATE' ? 'INVALID_STATE' : s.errorCode,
    lastCheckedAt: s.lastCheckedAt, actionAuthorization: 'NOT_GRANTED'});
}

/** Optional failures do not grade any product's completion or baseline health. */
export function aggregateDoctor(manifests, observations, current, requirements = []) {
  const registry = createRegistry(manifests), c = context(current);
  requireValue(Array.isArray(observations) && observations.length <= LIMITS.connectors, 'OBSERVATION_LIMIT');
  const states = new Map();
  for (const observation of observations) {
    const o = copyJson(observation); exact(o, ['connectorId', 'state']); id(o.connectorId);
    requireValue(registry.some(m => m.id === o.connectorId), 'UNKNOWN_CONNECTOR');
    requireValue(!states.has(o.connectorId), 'DUPLICATE_OBSERVATION'); states.set(o.connectorId, o.state);
  }
  requireValue(Array.isArray(requirements) && requirements.length <= 64, 'REQUIREMENT_LIMIT');
  const rows = registry.map(m => connectorDoctor(m, states.get(m.id), c));
  const requested = requirements.map(input => {
    const r = copyJson(input); exact(r, ['connectorId', 'mode', 'capability', 'product']); id(r.connectorId);
    choice(r.mode, MODES); choice(r.capability, CAPABILITIES); choice(r.product, ['BUILD', 'STUDIO', 'GROW']);
    const found = rows.find(item => item.connectorId === r.connectorId);
    const capabilityVerified = Boolean(found && found.products.includes(r.product) && found.mode === r.mode && found.freshness === 'CURRENT' && found.billingMode !== 'UNKNOWN' && found.capabilityStates.some(x => x.capability === r.capability && x.state === 'VERIFIED'));
    return {...r, capabilityVerified, actionAuthorization: 'NOT_GRANTED'};
  });
  return freeze({schemaVersion: 1, checkedAt: c.now, rows, requirements: requested,
    selectionStatus: !requested.length ? 'NO_CONNECTOR_REQUIREMENTS' : requested.every(r => r.capabilityVerified) ? 'CAPABILITIES_VERIFIED' : 'NEEDS_ATTENTION',
    baseline: 'UNAFFECTED_BY_CONNECTORS', productCompletion: 'NOT_ASSESSED', actionAuthorization: 'NOT_GRANTED'});
}

export const serializeManifest = m => stable(validateConnectorManifest(m)) + '\n';
export const serializeState = (s, m) => stable(validateConnectorState(s, m)) + '\n';

/** Parse bounded inert JSON before calling a schema validator. */
export function parseConnectorJson(text) {
  requireValue(typeof text === 'string' && text.length <= LIMITS.bytes && Buffer.byteLength(text) <= LIMITS.bytes, 'INPUT_LIMIT');
  let value; try { value = JSON.parse(text); } catch { fail('INVALID_JSON'); }
  return copyJson(value);
}
