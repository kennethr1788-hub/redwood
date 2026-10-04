import { adapter } from '../agents/adapters.mjs';
import { freeze } from '../agents/contract.mjs';
import { runtimeId } from './contracts.mjs';

// The pure local-help factory never executes native processes. The launcher owns
// the bounded Codex transport separately; browser config cannot supply one.
export function nativeRuntime(id) {
  runtimeId(id);
  return freeze({ runtimeId: id, displayName: id === null ? null : adapter(id).displayName,
    status: id === null ? 'SETUP_REQUIRED' : 'BRIDGE_UNAVAILABLE',
    executionAuthority: 'NONE', sourceEditAuthority: 'NONE', modelCalls: 0,
    billing: 'EXISTING_SUBSCRIPTION_FIRST', transportQualified: false });
}
