import { freeze } from '../agents/contract.mjs';
import { DISPLAY_NAMES as names } from '../../launcher/src/display-names.js';

// A deterministic frame for recurring support cases; model prose cannot overwrite
// it. No cause, repaired source, validated output or provider login is inferred.
export function answerContract(intent, state, liveContext) {
  const id = intent.contract;
  if (id === null) return null;
  if (id === 'HIGGSFIELD_SETUP') {
    const connector = liveContext?.connector?.id === 'higgsfield' ? liveContext.connector : null;
    return freeze({ id,
      whatFailed: 'Higgsfield support is available. ' + (connector ? `Supplied Higgsfield Doctor status: ${connector.status}.` : 'Current Higgsfield Doctor status is UNKNOWN because no matching current row was supplied.') +
        ' Usable capability remains UNKNOWN from this status-only projection. No connection or generation was attempted here.',
      whatRemainsValid: `R1B media support is available and OFFLINE_QUALIFIED. Read current Connections for mode-specific live qualification; this status-only projection does not establish it. Local ${names.build}, ${names.studio} and ${names.grow} do not depend on this optional connector. Support availability and a Doctor label do not grant authentication, billing coverage or action authorization.`,
      nextUserAction: `Read Connections and its current mode, capability and billing details. Continue supported local work; do not enter credentials into ${names.advisor}. Generation needs a separately qualified executor and explicit authorization.`,
      codingPromptUseful: 'NO' });
  }
  const product = id === 'BUILD_VERIFICATION_FAILED' ? 'build' : 'studio';
  const current = state?.product === product ? state : null;
  const receipt = current && current.freshness === 'CURRENT' && liveContext?.receipt?.product === product &&
    liveContext.receipt.revision === current.revision ? liveContext.receipt : null;
  const observed = current ? `Supplied ${names[product]} state: ${current.completionState}; freshness ${current.freshness}.` : `Current ${names[product]} state is UNKNOWN because it was not supplied.`;
  const error = receipt?.status === 'FAILED' && receipt.errorCode && /FAIL|FAILED/.test(current.completionState)
    ? ` Current matching receipt reports ${receipt.errorCode}.` : ' The failure cause has not been established here.';
  return freeze({ id,
    whatFailed: observed + error,
    whatRemainsValid: product === 'build'
      ? 'A failed check alone does not establish source loss. Other checks remain unverified unless current receipts prove them; old passes are historical.'
      : `A stale render alone does not establish timeline loss. Timeline and output existence, freshness and visual quality must be checked by ${names.studio}.`,
    nextUserAction: product === 'build'
      ? `Open the current ${names.build} check output. Inspect the failed step; after a user-directed repair, run fresh checks in ${names.build}.`
      : `Open ${names.studio} and inspect the current saved timeline, existing render job and output state before rerendering. Review the resulting video.`,
    codingPromptUseful: product === 'build' ? 'MAYBE' : 'NO' });
}
