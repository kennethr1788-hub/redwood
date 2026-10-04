// Synthetic normalized facts only. These are not copies of product schemas.
export const AT = '2026-10-03T20:00:00.000Z';
export const HASH = 'a'.repeat(64);
export const HASH2 = 'b'.repeat(64);
export const OUT = 'c'.repeat(64);
export const binding = () => ({ sourceIdentity: HASH, revision: '12', dependencies: [] });
export const artifact = () => ({ path: 'exports/video.mp4', expectedSha256: OUT, observedSha256: OUT, presence: 'PRESENT', validation: 'PASSED' });
export const base = product => ({
  schemaVersion: 1, product, projectId: 'project-1', projectName: 'Daybreak', sourceIdentity: HASH, currentRevision: '12',
  statePath: product === 'build' ? '.launchforge/project.json' : product === 'studio' ? 'state.json' : 'grow.project.json',
  identityScope: 'Fixture source bytes, lockfile, config, tests and declared runtime fingerprint; no blanket environment claim.',
  currentStage: product === 'build' ? 'CHECKING' : product === 'studio' ? 'RENDERED' : 'EXPORTED',
  lastOpenedAt: AT, instructionPaths: ['AGENTS.md'], relevantPaths: ['README.md'], lastSuccessfulAction: null,
  lastFailedAction: null, unresolvedItems: [], externalRequests: [], recovery: 'NONE',
});
export function buildFixture() {
  return { ...base('build'), verificationRequired: false, verification: {
    runId: 'verify-1', binding: binding(), receiptPath: '.launchforge/runs/verify-1.json', status: 'PASSED', finishedAt: AT,
    requiredChecks: ['typecheck', 'build', 'test'].map(id => ({ id, runId: 'verify-1', status: 'PASSED' })),
    criticalFlow: { id: 'save-reopen', runId: 'verify-1', status: 'PASSED' },
  } };
}
export function studioFixture() {
  return { ...base('studio'), render: { id: 'render-1', binding: binding(), receiptPath: 'exports/receipt.json',
    status: 'SUCCEEDED', artifacts: [artifact()], review: 'INSPECTED', finishedAt: AT } };
}
export function growFixture() {
  const dependencies = [{ id: 'evidence', revision: 'raw-1' }, { id: 'plan', revision: 'plan-1' }, { id: 'brand', revision: 'brand-1' }];
  return { ...base('grow'), dependencies, outputs: [
    { id: 'recommendation-1', kind: 'RECOMMENDATION', receiptPath: 'recommendations/receipt.json', status: 'REVIEWED',
      binding: { ...binding(), dependencies: dependencies.slice(0,2) }, bindingMode: 'DEPENDENCIES', artifacts: [] },
    { id: 'export-1', kind: 'EXPORT', receiptPath: 'exports/receipt.json', status: 'EXPORTED', binding: { ...binding(), dependencies },
      bindingMode: 'DEPENDENCIES', artifacts: [{ ...artifact(), path: 'exports/bundle.json' }] },
    { id: 'brand-review', kind: 'REVIEW', receiptPath: 'brand/review.json', status: 'REVIEWED',
      binding: { ...binding(), dependencies: [dependencies[2]] }, bindingMode: 'DEPENDENCIES', artifacts: [] },
  ] };
}
export function onboardingFixture(startingPoint = 'IDEA') {
  return { schemaVersion: 1, startingPoint, projectName: 'Daybreak', desiredOutcome: 'Ship a usable local product',
    selectedAgentAdapterId: 'manual', connectors: [], doctor: { checkedAt: AT,
      checks: [{ id: 'local-files', scope: 'CORE', status: 'VERIFIED', summary: 'Local project prerequisites passed.' }] } };
}
