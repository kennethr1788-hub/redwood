import { jsonData, shape, requireValue, identifier, sourceIdentity, digest, timestamp, list, oneOf, relativePath, text, freeze, canonicalJson, parseJson, validateTask, serializeTask, sha256 } from './contract.mjs';
import { adapter, AUTH_MODES } from './adapters.mjs';

/** Validates portable evidence structure, never authenticates a provider or establishes completion. */
export function validateReceipt(input) {
  const r = jsonData(input);
  shape(r, ['schemaVersion', 'taskId', 'taskSha256', 'sourceIdentity', 'resultingSourceIdentity', 'createdAt', 'provider', 'session', 'checks', 'artifacts', 'completionStatus', 'unresolvedFailures', 'evidenceTrust']);
  requireValue(r.schemaVersion === 1, 'SCHEMA_VERSION_REJECTED');
  identifier(r.taskId); digest(r.taskSha256); sourceIdentity(r.sourceIdentity); sourceIdentity(r.resultingSourceIdentity); timestamp(r.createdAt);
  requireValue(r.evidenceTrust === 'UNVERIFIED_INPUT', 'RECEIPT_CANNOT_GRANT_TRUST');
  shape(r.provider, ['adapterId', 'clientVersion', 'authMode']);
  adapter(r.provider.adapterId); identifier(r.provider.clientVersion); oneOf(r.provider.authMode, AUTH_MODES);
  shape(r.session, ['outcome', 'exitCode', 'reference']);
  oneOf(r.session.outcome, ['EXITED', 'INTERRUPTED', 'UNKNOWN', 'NOT_RUN']);
  requireValue(r.session.exitCode === null || (Number.isInteger(r.session.exitCode) && r.session.exitCode >= 0 && r.session.exitCode <= 255), 'EXIT_CODE_REJECTED');
  requireValue((r.session.outcome === 'EXITED') === (r.session.exitCode !== null), 'SESSION_EXIT_CONFLICT');
  if (r.session.reference !== null) identifier(r.session.reference);
  list(r.checks, c => {
    shape(c, ['name', 'status', 'sourceIdentity', 'evidencePaths']);
    identifier(c.name); oneOf(c.status, ['PASSED', 'FAILED', 'UNKNOWN', 'NOT_RUN']); sourceIdentity(c.sourceIdentity);
    list(c.evidencePaths, p => relativePath(p));
    if (c.status === 'PASSED') requireValue(c.evidencePaths.length > 0, 'PASS_NEEDS_EVIDENCE_REFERENCE');
  });
  requireValue(new Set(r.checks.map(c => c.name)).size === r.checks.length, 'DUPLICATE_CHECK');
  list(r.artifacts, a => { shape(a, ['path', 'sha256']); relativePath(a.path); digest(a.sha256); });
  requireValue(new Set(r.artifacts.map(a => a.path)).size === r.artifacts.length, 'DUPLICATE_ARTIFACT');
  oneOf(r.completionStatus, ['NOT_VERIFIED', 'CHECKS_REPORTED_PASS', 'FAILED', 'UNKNOWN_RECONCILE']);
  list(r.unresolvedFailures, s => text(s));
  if (['UNKNOWN', 'INTERRUPTED'].includes(r.session.outcome)) requireValue(r.completionStatus === 'UNKNOWN_RECONCILE', 'UNCERTAIN_SESSION_REQUIRES_RECONCILIATION');
  if (r.completionStatus === 'CHECKS_REPORTED_PASS') {
    requireValue(r.session.outcome === 'EXITED' && r.session.exitCode === 0 && r.checks.length > 0 && r.unresolvedFailures.length === 0, 'CHECKS_PASS_CONFLICT');
    requireValue(r.checks.every(c => c.status === 'PASSED' && canonicalJson(c.sourceIdentity) === canonicalJson(r.resultingSourceIdentity) && c.evidencePaths.every(p => r.artifacts.some(a => a.path === p))), 'CHECKS_PASS_CONFLICT');
  }
  return freeze(r);
}
export function serializeReceipt(input) {
  const serialized = canonicalJson(validateReceipt(input));
  requireValue(Buffer.byteLength(serialized) <= 32768, 'JSON_RESOURCE_LIMIT');
  return serialized;
}
export function parseReceipt(input) { return validateReceipt(parseJson(input)); }

export function bindReceiptToTask(input, task) {
  const r = validateReceipt(input); const t = validateTask(task);
  requireValue(r.taskId === t.taskId && r.taskSha256 === sha256(serializeTask(t)) && canonicalJson(r.sourceIdentity) === canonicalJson(t.sourceIdentity), 'RECEIPT_TASK_MISMATCH');
  return r;
}
export function receiptSourceState(input, currentSourceIdentity) {
  const r = validateReceipt(input); const current = jsonData(currentSourceIdentity); sourceIdentity(current);
  return canonicalJson(r.resultingSourceIdentity) === canonicalJson(current) ? 'MATCHES_DECLARED_SOURCE' : 'STALE';
}
