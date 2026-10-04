import { PROHIBITED_EFFECTS } from '../../integrations/agents/contract.mjs';
export function task() {
  return {
    schemaVersion: 1, taskId: 'bridge-fixture-001', product: 'build', action: 'review-local',
    workspace: '/work/ordinary project-é', createdAt: '2026-10-04T03:00:00.000Z',
    sourceIdentity: { revision: 'fixture-r1', sha256: 'a'.repeat(64) },
    objective: 'Inspect the saved example and report the required local checks.',
    inputs: [{ path: 'src/example.js', sha256: 'b'.repeat(64) }],
    preserve: ['Keep existing user edits.'], acceptance: ['Report actual test results and unresolved failures.'],
    allowedEffects: ['READ_WORKSPACE', 'RUN_LOCAL_CHECKS'], prohibitedEffects: [...PROHIBITED_EFFECTS],
    commands: [{ argv: ['node', '--test', 'tests/example.test.js'], cwd: '.' }],
    evidencePaths: ['evidence/checks.txt'], expectedReceiptPath: '.launchforge/receipts/bridge-fixture-001.json',
  };
}
export function options(id, mode = 'ACCOUNT') {
  return { executable: `/opt/official/${id === 'cursor' ? 'cursor-agent' : id}`, mode,
    auth: { status: 'AUTHENTICATED', mode }, environmentKeys: ['PATH', 'HOME', 'LANG'] };
}
export function receipt() {
  const t = task();
  return { schemaVersion: 1, taskId: t.taskId, taskSha256: 'c'.repeat(64), sourceIdentity: t.sourceIdentity,
    resultingSourceIdentity: t.sourceIdentity, createdAt: t.createdAt,
    provider: { adapterId: 'codex', clientVersion: '0.159.2', authMode: 'ACCOUNT' },
    session: { outcome: 'EXITED', exitCode: 0, reference: 'synthetic-session-001' },
    checks: [], artifacts: [], completionStatus: 'NOT_VERIFIED', unresolvedFailures: [], evidenceTrust: 'UNVERIFIED_INPUT' };
}
