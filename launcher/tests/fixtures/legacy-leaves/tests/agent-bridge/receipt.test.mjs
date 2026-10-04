import test from 'node:test';
import assert from 'node:assert/strict';
import { validateReceipt, serializeReceipt, parseReceipt, bindReceiptToTask, receiptSourceState } from '../../integrations/agents/receipt.mjs';
import { BridgeError, taskPacket } from '../../integrations/agents/contract.mjs';
import { receipt, task } from './fixtures.mjs';
function reportedPass() {
  const r = receipt(); r.checks = [{ name: 'unit', status: 'PASSED', sourceIdentity: r.resultingSourceIdentity, evidencePaths: ['evidence/unit.tap'] }];
  r.artifacts = [{ path: 'evidence/unit.tap', sha256: 'd'.repeat(64) }]; r.completionStatus = 'CHECKS_REPORTED_PASS'; return r;
}
test('zero provider exit does not promote product completion; receipt roundtrips', () => {
  const r = validateReceipt(receipt()); assert.equal(r.completionStatus, 'NOT_VERIFIED');
  assert.deepEqual(parseReceipt(serializeReceipt(r)), r);
  assert.equal(validateReceipt(reportedPass()).evidenceTrust, 'UNVERIFIED_INPUT');
  assert.throws(() => { r.provider.authMode = 'API'; }, TypeError);
});
for (const outcome of ['UNKNOWN', 'INTERRUPTED']) {
  test(`${outcome} requires reconciliation, not previous success`, () => {
    const r = reportedPass(); r.session = { outcome, exitCode: null, reference: null };
    assert.throws(() => validateReceipt(r), /UNCERTAIN_SESSION_REQUIRES_RECONCILIATION/);
    r.completionStatus = 'UNKNOWN_RECONCILE'; assert.equal(validateReceipt(r).completionStatus, 'UNKNOWN_RECONCILE');
  });
}
test('missing, stale, failed, partial and duplicate checks cannot represent a current reported pass', () => {
  for (const change of [
    r => { r.checks = []; }, r => { r.checks[0].status = 'FAILED'; }, r => { r.checks[0].status = 'UNKNOWN'; },
    r => { r.checks[0].sourceIdentity = { revision: 'old', sha256: 'e'.repeat(64) }; },
    r => { r.checks[0].evidencePaths = []; }, r => { r.artifacts = []; }, r => { r.unresolvedFailures = ['still broken']; },
    r => { r.session.exitCode = 1; }, r => { r.checks.push(r.checks[0]); }, r => { r.artifacts.push(r.artifacts[0]); },
  ]) { const r = reportedPass(); change(r); assert.throws(() => validateReceipt(r), BridgeError); }
});
test('receipt cannot claim authority or carry raw provider output and secret fields', () => {
  for (const change of [
    r => { r.evidenceTrust = 'VERIFIED'; }, r => { r.completionStatus = 'COMPLETE'; },
    r => { r.provider.token = 'synthetic'; }, r => { r.session.stdout = 'synthetic'; },
    r => { r.unresolvedFailures = ['cookie=synthetic']; }, r => { r.artifacts = [{ path: '../out', sha256: 'd'.repeat(64) }]; },
    r => { r.session.exitCode = null; }, r => { r.session.outcome = 'NOT_RUN'; },
  ]) { const r = receipt(); change(r); assert.throws(() => validateReceipt(r), BridgeError); }
});
test('task digest/source binding rejects a receipt for another task and exposes stale source', () => {
  const r = receipt(); const t = task(); r.taskSha256 = taskPacket(t).sha256;
  assert.deepEqual(bindReceiptToTask(r, t), r);
  assert.equal(receiptSourceState(r, t.sourceIdentity), 'MATCHES_DECLARED_SOURCE');
  assert.equal(receiptSourceState(r, { revision: 'r2', sha256: 'f'.repeat(64) }), 'STALE');
  for (const change of [x => { x.taskId = 'other'; }, x => { x.taskSha256 = 'd'.repeat(64); }, x => { x.sourceIdentity = { revision: 'other', sha256: 'e'.repeat(64) }; }]) {
    const wrong = structuredClone(r); change(wrong); assert.throws(() => bindReceiptToTask(wrong, t), /RECEIPT_TASK_MISMATCH/);
  }
});
