import { array, bool, digest, enumeration as one, id, identity, nullable, object, optional, product, relativePath, revision, schema, text, timestamp, unique, fail } from './validation.mjs';

const paths = array(relativePath, 32);
const dependency = object({ id, revision });
const dependencies = v => unique(array(dependency, 32)(v), d => d.id);
const binding = object({ sourceIdentity: identity, revision, dependencies });
const item = object({ id, summary: text(), path: optional(relativePath) });
const action = nullable(object({ id, summary: text(), at: timestamp, receiptPath: relativePath }));
const artifact = object({ path: relativePath, expectedSha256: identity, observedSha256: identity,
  presence: one('PRESENT', 'MISSING', 'UNKNOWN'), validation: one('PASSED', 'FAILED', 'UNKNOWN') });
const artifacts = v => unique(array(artifact, 32)(v), a => a.path);
const externalRequest = object({ requestId: id, providerJobId: nullable(id), connectorId: id, receiptPath: relativePath,
  status: one('DRAFT', 'SUBMITTED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED', 'UNKNOWN_RECONCILE') });
const externalRequests = v => unique(array(externalRequest, 8)(v), r => r.requestId);

const common = {
  schemaVersion: one(1), product, projectId: id, projectName: text(100), sourceIdentity: identity, currentRevision: revision,
  statePath: relativePath, identityScope: text(), lastOpenedAt: timestamp, currentStage: id,
  instructionPaths: paths, relevantPaths: paths, lastSuccessfulAction: action, lastFailedAction: action,
  unresolvedItems: array(item, 16), externalRequests,
  recovery: one('NONE', 'RECONCILE_REQUIRED'),
};
const step = object({ id, runId: id, status: one('PASSED', 'FAILED', 'NOT_RUN_IN_THIS_RUN', 'UNKNOWN') });
const verification = nullable(object({
  runId: id, binding, receiptPath: relativePath, status: one('PASSED', 'FAILED', 'RUNNING', 'CHANGED_DURING_RUN', 'UNKNOWN'),
  finishedAt: nullable(timestamp), requiredChecks: v => unique(array(step, 8)(v), s => s.id), criticalFlow: nullable(step),
}));
const render = nullable(object({ id, binding, receiptPath: relativePath, finishedAt: nullable(timestamp),
  status: one('SUCCEEDED', 'FAILED', 'RUNNING', 'RECOVERY_REQUIRED', 'UNKNOWN'), artifacts,
  review: one('INSPECTED', 'NOT_REVIEWED', 'UNKNOWN'),
}));
const growOutputShape = object({ id, kind: one('RECOMMENDATION', 'EXPORT', 'REVIEW', 'PREFLIGHT'),
  binding, bindingMode: one('PROJECT', 'DEPENDENCIES'), receiptPath: relativePath, artifacts,
  status: one('DRAFT', 'REVIEWED', 'EXPORTED', 'FAILED', 'RUNNING', 'UNKNOWN'),
});
const growOutput = v => {
  const output = growOutputShape(v);
  if (output.status === 'EXPORTED' && output.kind !== 'EXPORT') fail('Only exports have EXPORTED state');
  return output;
};
const normalized = {
  build: object({ ...common, product: one('build'), verification, verificationRequired: bool }),
  studio: object({ ...common, product: one('studio'), render }),
  grow: object({ ...common, product: one('grow'), dependencies, outputs: v => unique(array(growOutput, 16)(v), o => o.id) }),
};
export const NormalizedProjectState = schema(v => {
  product(v?.product);
  const state = normalized[v.product](v);
  unique(state.unresolvedItems, x => x.id);
  unique(state.instructionPaths); unique(state.relevantPaths);
  if (state.product !== 'grow') {
    const receipt = state.verification ?? state.render;
    if (receipt?.binding.dependencies.length) fail('Build and Studio use the complete declared identity');
  }
  return state;
});

export const freshness = one('CURRENT', 'STALE', 'UNKNOWN', 'OUTPUT_STALE_OR_MISSING', 'INCOMPLETE');
export const completion = one('CURRENT_PASS', 'CURRENT_CHECKS_PASS_NO_FLOW', 'CURRENT_FAIL', 'NOT_RUN', 'STALE', 'UNKNOWN',
  'INCOMPLETE', 'OUTPUT_STALE_OR_MISSING', 'RECONCILE_REQUIRED', 'RENDERED', 'INSPECTED', 'EXPORTED', 'REVIEWED', 'DRAFT', 'FAILED', 'NEEDS_ATTENTION');
const receipt = object({ id, kind: one('VERIFICATION', 'RENDER', 'RECOMMENDATION', 'EXPORT', 'REVIEW', 'PREFLIGHT'),
  path: relativePath, status: id, freshness, reasons: array(id, 16), binding, scope: one('PROJECT', 'DEPENDENCIES'), artifacts,
});
export const NextAction = object({ kind: one('VERIFY', 'REPAIR_AND_VERIFY', 'RECONCILE', 'INSPECT_AND_RERENDER', 'INSPECT_OUTPUT',
  'REVIEW_DEPENDENT_OUTPUTS', 'REVIEW_OUTPUTS', 'INSPECT_PROJECT', 'CONTINUE'), summary: text(), targetPath: relativePath,
  requestId: optional(id),
});
export const ResumeRecord = schema(object({
  schemaVersion: one(1), derived: one(true), projectId: id, projectName: text(100), product,
  sourceIdentity: identity, currentRevision: revision, lastOpenedAt: timestamp, lastVerifiedAt: nullable(timestamp),
  derivedFrom: object({ statePath: relativePath, snapshotSha256: digest, identityScope: text() }),
  currentStage: id, completionState: completion, lastSuccessfulAction: action, lastFailedAction: action,
  unresolvedItems: array(item, 64), relevantPaths: array(relativePath, 128), instructionPaths: paths,
  receipts: array(receipt, 32), externalRequests, nextRecommendedAction: NextAction,
}));

export const RecentProjectPointer = schema(object({ schemaVersion: one(1), id, name: text(100), product,
  localPath: relativePath, lastOpenedAt: timestamp, resumePath: relativePath,
}));
