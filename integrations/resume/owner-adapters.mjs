import {NormalizedProjectState} from './contracts.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const binding = (source, revision) => ({sourceIdentity: hash(source), revision: revision == null ? null : String(revision), dependencies: []});
function common(product, project, source, revision, statePath, openedAt) {
  return {schemaVersion: 1, product, projectId: project.id, projectName: project.name,
    sourceIdentity: hash(source), currentRevision: revision == null ? null : String(revision), statePath,
    identityScope: product === 'build' ? 'Build source-identity-v2: bounded source bytes, modes and saved flow; excludes generated files, installed dependencies and runtime.' : 'Owning product snapshot and explicitly supplied fresh output observations; unavailable observations remain unknown.',
    lastOpenedAt: openedAt, currentStage: 'REVIEW', instructionPaths: [], relevantPaths: [statePath],
    lastSuccessfulAction: null, lastFailedAction: null, unresolvedItems: [], externalRequests: [], recovery: 'NONE'};
}

export function mapBuildState(project, identity, openedAt, instructionPaths = []) {
  const statePath = '.launchforge/project.json';
  const base = common('build', project, identity, identity, statePath, openedAt);
  base.instructionPaths = instructionPaths;
  base.relevantPaths.push('.launchforge/brief.md', 'package.json', 'package-lock.json');
  if (project.restore?.outcome === 'RECONCILE_REQUIRED') base.recovery = 'RECONCILE_REQUIRED';
  const step = (run, id) => ({id, runId: run.id,
    status: ({passed: 'PASSED', failed: 'FAILED', NOT_RUN_IN_THIS_RUN: 'NOT_RUN_IN_THIS_RUN'})[run.checks?.[id]?.status] ?? 'NOT_RUN_IN_THIS_RUN'});
  const v = project.verification;
  // Every required step is represented; no previous run fills a missing result.
  const verification = v ? {runId: v.id, binding: binding(v.identity, v.identity), receiptPath: statePath,
    status: v.status, finishedAt: time(v.endedAt), requiredChecks: ['typecheck', 'build', 'test'].map(id => step(v, id)),
    criticalFlow: v.flow ? step(v, 'flow') : null} : null;
  for (const run of [...(project.verificationHistory ?? []), ...(v ? [v] : [])]) {
    const at = time(run.endedAt); if (!at) continue;
    if (run.status === 'FAILED') base.lastFailedAction = {id: run.id, at, receiptPath: statePath, summary: 'Build verification failed; details remain in local Checks.'};
    if (run.status === 'PASSED') base.lastSuccessfulAction = {id: run.id, at, receiptPath: statePath, summary: 'Historical Build verification passed; currentness is assessed separately.'};
  }
  base.currentStage = v ? 'VERIFICATION' : 'BRIEF';
  return NormalizedProjectState.parse({...base, verification, verificationRequired: project.restore?.verificationRequired === true});
}

// These adapters consume the CURRENT product owner's view and read-only observations.
// They do not import its store, mutate it, probe media, or accept model completion facts.
export function mapStudioState(view, {identity = null, receipt = null, artifacts = [], recovery = 'NONE', openedAt}) {
  const {studio} = view;
  const base = common('studio', studio, identity, studio.revision, 'state.json', openedAt);
  base.recovery = recovery;
  base.currentStage = 'MEDIA_REVIEW';
  base.relevantPaths.push(studio.asset.path, 'events.ndjson');
  // Cover every file declared by the owner receipt. A partial observation list
  // must not turn one good file into a current complete render claim.
  const observedArtifacts = (receipt?.files ?? []).map(file => {
    const filePath = 'exports/' + file.name;
    const observed = artifacts.find(item => item.path === filePath);
    return {path: filePath, expectedSha256: hash(file.sha256), observedSha256: hash(observed?.observedSha256),
      presence: observed?.presence ?? 'UNKNOWN', validation: observed?.validation ?? 'UNKNOWN'};
  });
  const render = receipt ? {id: 'render-' + receipt.revision, binding: binding(receipt.binding?.identity, view.exports?.some(file => file.stale) ? 'stale-owner-revision' : receipt.revision),
    receiptPath: 'exports/receipt.json', finishedAt: time(receipt.renderedAt), status: 'SUCCEEDED',
    // One inspected frame is not proof that all final media were inspected.
    review: 'NOT_REVIEWED', artifacts: observedArtifacts} : null;
  return NormalizedProjectState.parse({...base, render});
}

export function mapGrowState(project, {sourceIdentity = null, outputs = [], dependencies = [], openedAt}) {
  const base = common('grow', project, sourceIdentity, project.updatedAt ? 'revision-' + Date.parse(project.updatedAt) : null,
    'grow.project.json', openedAt);
  base.currentStage = project.exports?.length ? 'EXPORT_REVIEW' : project.growthPlan ? 'PLAN_REVIEW' : 'INTAKE';
  // Output bindings/observations must come from the owner. Saved export labels alone
  // cannot establish current bytes or exact dependency equivalence.
  const mapped = outputs.map(output => {
    const owner = (project.exports ?? []).find(item => item.id === output.id);
    if (output.kind === 'EXPORT' && !owner) return {...output, status: 'UNKNOWN'};
    return owner?.stale ? {...output, binding: {...output.binding, revision: 'stale-owner-revision'}, bindingMode: 'PROJECT'} : output;
  });
  if (project.exports?.length && !outputs.length) base.unresolvedItems.push({id: 'exports-unverified', summary: 'Saved exports exist; current dependency and file integrity observations are required.', path: 'grow.project.json'});
  return NormalizedProjectState.parse({...base, dependencies, outputs: mapped});
}
