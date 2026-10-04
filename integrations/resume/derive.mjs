import { createHash } from 'node:crypto';
import { NormalizedProjectState, ResumeRecord } from './contracts.mjs';
import { canonicalJSON, fail } from './validation.mjs';

const sha256 = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
const next = (kind, summary, targetPath) => ({ kind, summary, targetPath });
const assessment = (freshness, ...reasons) => ({ freshness, reasons });
const severity = ['CURRENT', 'UNKNOWN', 'INCOMPLETE', 'STALE', 'OUTPUT_STALE_OR_MISSING'];
function combine(...parts) {
  return { freshness: parts.reduce((a, b) => severity.indexOf(b.freshness) > severity.indexOf(a) ? b.freshness : a, 'CURRENT'),
    reasons: [...new Set(parts.flatMap(p => p.reasons))] };
}

function boundToCurrent(binding, state, scope = 'PROJECT') {
  const parts = [];
  if (!state.sourceIdentity || !binding.sourceIdentity) parts.push(assessment('UNKNOWN', 'SOURCE_IDENTITY_UNKNOWN'));
  else if (state.sourceIdentity !== binding.sourceIdentity) parts.push(assessment('STALE', 'SOURCE_CHANGED'));
  if (scope === 'PROJECT') {
    if (!state.currentRevision || !binding.revision) parts.push(assessment('UNKNOWN', 'REVISION_UNKNOWN'));
    else if (state.currentRevision !== binding.revision) parts.push(assessment('STALE', 'REVISION_CHANGED'));
  } else if (!binding.dependencies.length) parts.push(assessment('UNKNOWN', 'DEPENDENCIES_NOT_DECLARED'));
  const current = new Map((state.dependencies ?? []).map(d => [d.id, d.revision]));
  for (const dependency of binding.dependencies) {
    if (!current.get(dependency.id) || !dependency.revision) parts.push(assessment('UNKNOWN', 'DEPENDENCY_UNKNOWN'));
    else if (current.get(dependency.id) !== dependency.revision) parts.push(assessment('STALE', 'DEPENDENCY_CHANGED'));
  }
  return combine(...parts);
}

function outputIntegrity(artifacts, required) {
  if (!artifacts.length) return required ? assessment('UNKNOWN', 'OUTPUT_IDENTITY_MISSING') : assessment('CURRENT');
  return combine(...artifacts.map(a => {
    if (a.presence === 'MISSING') return assessment('OUTPUT_STALE_OR_MISSING', 'OUTPUT_MISSING');
    if (a.validation === 'FAILED') return assessment('OUTPUT_STALE_OR_MISSING', 'OUTPUT_VALIDATION_FAILED');
    if (a.expectedSha256 && a.observedSha256 && a.expectedSha256 !== a.observedSha256) return assessment('OUTPUT_STALE_OR_MISSING', 'OUTPUT_HASH_MISMATCH');
    if (a.presence === 'UNKNOWN' || !a.expectedSha256 || !a.observedSha256 || a.validation === 'UNKNOWN') return assessment('UNKNOWN', 'OUTPUT_NOT_VERIFIED');
    return assessment('CURRENT');
  }));
}

function receipt(input, kind, result, scope = 'PROJECT') {
  return { id: input.id ?? input.runId, kind, path: input.receiptPath, status: input.status,
    ...result, binding: input.binding, scope, artifacts: input.artifacts ?? [] };
}
function actionFrom(id, summary, at, receiptPath) { return at ? { id, summary, at, receiptPath } : null; }
function later(a, b) { return !a ? b : !b || a.at >= b.at ? a : b; }
function issue(record, id, summary, path) {
  // Owner-supplied unresolved items are never silently replaced.
  let uniqueId = 'resume-' + id;
  while (record.unresolvedItems.some(i => i.id === uniqueId)) uniqueId += '-r';
  record.unresolvedItems.push({ id: uniqueId, summary, path });
}

function build(state, record) {
  const v = state.verification;
  record.nextRecommendedAction = next('VERIFY', 'Run fresh verification against the current source after checking project instructions and readiness.', state.statePath);
  if (!v) { record.completionState = 'NOT_RUN'; return; }
  const steps = [...v.requiredChecks, ...(v.criticalFlow ? [v.criticalFlow] : [])];
  let run = assessment('CURRENT');
  if (v.status === 'RUNNING' || !v.finishedAt || !v.requiredChecks.length || steps.some(s => s.runId !== v.runId || s.status === 'NOT_RUN_IN_THIS_RUN')) {
    run = assessment('INCOMPLETE', 'RUN_INCOMPLETE');
  } else if (v.status === 'UNKNOWN' || steps.some(s => s.status === 'UNKNOWN')) run = assessment('UNKNOWN', 'RUN_UNKNOWN');
  const failed = v.status === 'FAILED' || steps.some(s => s.status === 'FAILED');
  const result = combine(boundToCurrent(v.binding, state), run,
    v.status === 'CHANGED_DURING_RUN' || state.verificationRequired ? assessment('STALE', 'FRESH_VERIFICATION_REQUIRED') : assessment('CURRENT'));
  record.receipts.push(receipt(v, 'VERIFICATION', result));
  const successfulRun = v.status === 'PASSED' && run.freshness === 'CURRENT' && !failed;
  if (successfulRun) {
    record.lastVerifiedAt = v.finishedAt;
    record.lastSuccessfulAction = later(record.lastSuccessfulAction, actionFrom(v.runId, v.criticalFlow ? 'Verification and named critical flow passed on the receipt identity.' : 'Deterministic checks passed; no critical flow was supplied.', v.finishedAt, v.receiptPath));
  }
  if (failed) {
    record.lastFailedAction = later(record.lastFailedAction, actionFrom(v.runId, 'Verification failed; inspect the original receipt.', v.finishedAt, v.receiptPath));
    issue(record, 'verification-failed', 'The latest verification run contains a failure.', v.receiptPath);
  }
  if (result.freshness !== 'CURRENT') {
    record.completionState = result.freshness;
    issue(record, 'verification-not-current', 'Verification does not establish a current pass. Inspect receipt reasons and verify again.', v.receiptPath);
  } else if (failed) {
    record.completionState = 'CURRENT_FAIL';
    record.nextRecommendedAction = next('REPAIR_AND_VERIFY', 'Inspect and repair the recorded failure, then run a complete fresh verification.', v.receiptPath);
  } else if (successfulRun) {
    record.completionState = v.criticalFlow ? 'CURRENT_PASS' : 'CURRENT_CHECKS_PASS_NO_FLOW';
    record.nextRecommendedAction = v.criticalFlow
      ? next('CONTINUE', 'Inspect the current source and receipt, then choose the next local project task.', state.statePath)
      : next('VERIFY', 'Define and verify the named critical user flow; checks alone do not establish product completion.', v.receiptPath);
  } else record.completionState = 'UNKNOWN';
  if (v.status === 'RUNNING') record.nextRecommendedAction = next('RECONCILE', 'Inspect the existing verification run and process ownership before starting fresh verification.', v.receiptPath);
}

function studio(state, record) {
  const r = state.render;
  record.nextRecommendedAction = next('INSPECT_AND_RERENDER', 'Inspect the timeline and source, then render and inspect the required outputs.', state.statePath);
  if (!r) { record.completionState = 'NOT_RUN'; return; }
  const result = combine(boundToCurrent(r.binding, state), outputIntegrity(r.artifacts, true),
    r.status === 'RUNNING' || r.status === 'RECOVERY_REQUIRED' || !r.finishedAt ? assessment('INCOMPLETE', 'RENDER_INCOMPLETE')
      : r.status === 'UNKNOWN' ? assessment('UNKNOWN', 'OWNER_STATUS_UNKNOWN') : assessment('CURRENT'));
  record.receipts.push(receipt(r, 'RENDER', result));
  if (r.status === 'RECOVERY_REQUIRED') {
    record.completionState = 'RECONCILE_REQUIRED';
    record.nextRecommendedAction = next('RECONCILE', 'Inspect existing export, staging and renderer ownership before recovering; preserve previous complete exports.', r.receiptPath);
    issue(record, 'render-recovery', 'Render recovery is unresolved.', r.receiptPath);
  } else if (result.freshness !== 'CURRENT') {
    record.completionState = result.freshness;
    issue(record, 'render-not-current', 'The render is not a verified current output. Inspect its binding and output identities.', r.receiptPath);
  } else if (r.status === 'FAILED') record.completionState = 'FAILED';
  else if (r.status === 'UNKNOWN') record.completionState = 'UNKNOWN';
  else if (r.status === 'SUCCEEDED') {
    record.completionState = r.review === 'INSPECTED' ? 'INSPECTED' : 'RENDERED';
    record.nextRecommendedAction = r.review === 'INSPECTED'
      ? next('CONTINUE', 'Open the inspected current media and owning project before choosing the next local task.', r.receiptPath)
      : next('INSPECT_OUTPUT', 'Inspect the actual rendered media; rendering alone is not inspection.', r.receiptPath);
  }
  if (r.status === 'SUCCEEDED' && r.finishedAt) record.lastSuccessfulAction = later(record.lastSuccessfulAction, actionFrom(r.id, 'Render completed on the receipt identity; freshness and inspection are listed separately.', r.finishedAt, r.receiptPath));
  if (r.status === 'FAILED') {
    record.lastFailedAction = later(record.lastFailedAction, actionFrom(r.id, 'Render failed; inspect the original receipt.', r.finishedAt, r.receiptPath));
    issue(record, 'render-failed', 'The latest render failed.', r.receiptPath);
  }
  if (r.status === 'RUNNING') record.nextRecommendedAction = next('RECONCILE', 'Inspect the existing renderer and staging before any rerender; preserve previous complete exports.', r.receiptPath);
}

function grow(state, record) {
  for (const o of state.outputs) {
    const result = combine(boundToCurrent(o.binding, state, o.bindingMode), outputIntegrity(o.artifacts, o.kind === 'EXPORT'),
      o.status === 'UNKNOWN' ? assessment('UNKNOWN', 'OWNER_STATUS_UNKNOWN') : o.status === 'RUNNING' ? assessment('INCOMPLETE', 'OPERATION_INCOMPLETE') : assessment('CURRENT'));
    record.receipts.push(receipt(o, o.kind, result, o.bindingMode));
  }
  const worst = combine(...record.receipts);
  record.nextRecommendedAction = next('REVIEW_OUTPUTS', 'Review the current product outputs and evidence; export does not establish publication.', state.statePath);
  if (!state.outputs.length) record.completionState = 'DRAFT';
  else if (worst.freshness !== 'CURRENT') {
    record.completionState = worst.freshness;
    record.nextRecommendedAction = next('REVIEW_DEPENDENT_OUTPUTS', 'Review and regenerate only the affected dependent outputs against current evidence and artifact identities.', state.statePath);
    for (const r of record.receipts.filter(r => r.freshness !== 'CURRENT')) issue(record, 'output-' + r.id.slice(0,60), 'This output does not establish a current claim. Inspect the receipt reasons.', r.path);
  } else if (state.outputs.some(o => o.status === 'FAILED')) record.completionState = 'FAILED';
  else if (state.outputs.some(o => o.status === 'DRAFT')) record.completionState = 'DRAFT';
  else record.completionState = state.outputs.some(o => o.kind === 'EXPORT' && o.status === 'EXPORTED') ? 'EXPORTED' : 'REVIEWED';
  for (const o of state.outputs.filter(o => o.status === 'FAILED')) issue(record, 'failed-' + o.id.slice(0,60), 'The owning product reports a failed output.', o.receiptPath);
  const running = state.outputs.find(o => o.status === 'RUNNING');
  if (running) record.nextRecommendedAction = next('RECONCILE', 'Inspect the existing local output operation before retrying or regenerating it.', running.receiptPath);
}

export function deriveResume(input) {
  const state = NormalizedProjectState.parse(input);
  const record = {
    schemaVersion: 1, derived: true, projectId: state.projectId, projectName: state.projectName, product: state.product,
    sourceIdentity: state.sourceIdentity, currentRevision: state.currentRevision, lastOpenedAt: state.lastOpenedAt, lastVerifiedAt: null,
    derivedFrom: { statePath: state.statePath, snapshotSha256: sha256(state), identityScope: state.identityScope },
    currentStage: state.currentStage, completionState: 'UNKNOWN', lastSuccessfulAction: state.lastSuccessfulAction,
    lastFailedAction: state.lastFailedAction, unresolvedItems: [...state.unresolvedItems], relevantPaths: [...state.relevantPaths],
    instructionPaths: state.instructionPaths, receipts: [], externalRequests: state.externalRequests,
    nextRecommendedAction: next('INSPECT_PROJECT', 'Inspect the current owning project state.', state.statePath),
  };
  ({ build, studio, grow })[state.product](state, record);
  if (state.unresolvedItems.length) {
    if (['CURRENT_PASS', 'EXPORTED', 'INSPECTED', 'REVIEWED'].includes(record.completionState)) record.completionState = 'NEEDS_ATTENTION';
    if (record.nextRecommendedAction.kind === 'CONTINUE') record.nextRecommendedAction = next('INSPECT_PROJECT', 'Inspect the preserved unresolved items before continuing.', state.unresolvedItems[0].path ?? state.statePath);
  }
  if (state.recovery === 'RECONCILE_REQUIRED') {
    record.completionState = 'RECONCILE_REQUIRED';
    record.nextRecommendedAction = next('RECONCILE', 'Reconcile the interrupted local operation against current state before retrying it.', state.statePath);
    issue(record, 'recovery', 'The owning product requires recovery reconciliation.', state.statePath);
  }
  for (const request of state.externalRequests.filter(r => r.status === 'FAILED')) {
    issue(record, 'provider-failed-' + request.requestId.slice(0, 50), 'Provider request failed; local failure does not establish a refund.', request.receiptPath);
    if (['CURRENT_PASS', 'EXPORTED', 'INSPECTED', 'REVIEWED'].includes(record.completionState)) record.completionState = 'NEEDS_ATTENTION';
    if (record.nextRecommendedAction.kind === 'CONTINUE') record.nextRecommendedAction = next('INSPECT_PROJECT', 'Inspect the failed provider request receipt and current product state.', request.receiptPath);
  }
  const pending = state.externalRequests.find(r => ['UNKNOWN_RECONCILE', 'CANCEL_REQUESTED'].includes(r.status))
    ?? state.externalRequests.find(r => ['SUBMITTED', 'PROCESSING'].includes(r.status));
  if (pending) {
    record.completionState = ['UNKNOWN_RECONCILE', 'CANCEL_REQUESTED'].includes(pending.status) ? 'RECONCILE_REQUIRED' : 'INCOMPLETE';
    record.nextRecommendedAction = { ...next('RECONCILE', 'Reconcile the existing provider request or job using its local receipt; do not submit a duplicate.', pending.receiptPath), requestId: pending.requestId };
    issue(record, 'provider-request', 'Provider effect or cancellation is not confirmed. Preserve the existing request identity.', pending.receiptPath);
  }
  record.relevantPaths = [...new Set([state.statePath, ...state.instructionPaths, ...state.relevantPaths,
    ...record.receipts.flatMap(r => [r.path, ...r.artifacts.map(a => a.path)]),
    ...state.externalRequests.map(r => r.receiptPath), ...record.unresolvedItems.flatMap(i => i.path ? [i.path] : []),
    ...[record.lastSuccessfulAction, record.lastFailedAction].flatMap(a => a ? [a.receiptPath] : [])])];
  return ResumeRecord.parse(record);
}

export function deriveBuildResume(input) { return forProduct('build', input); }
export function deriveStudioResume(input) { return forProduct('studio', input); }
export function deriveGrowResume(input) { return forProduct('grow', input); }
function forProduct(product, input) {
  const state = NormalizedProjectState.parse(input);
  if (state.product !== product) fail('Wrong normalized product adapter');
  return deriveResume(state);
}

// Structural parsing alone NEVER makes a cached resume current. Compare the entire
// regenerated projection, including same-revision output observations and failures.
export function inspectResume(cached, currentState) {
  const record = ResumeRecord.parse(cached);
  const current = deriveResume(currentState);
  const status = record.projectId === current.projectId && record.product === current.product
    && canonicalJSON(record) === canonicalJSON(current) ? 'CURRENT' : 'STALE';
  return { status, record: current };
}
