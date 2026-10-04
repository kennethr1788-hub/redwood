import { createConversation } from './engine.mjs';
import { parseCheckpoint } from './continuity.mjs';
import { requireValue } from '../agents/contract.mjs';

export { LIMITS } from './contracts.mjs';
export { retrieveHelp, classifySupportIntent, KNOWLEDGE_VERSION } from './knowledge.mjs';

// Pure local-help factory. Native transport is wired only by trusted launcher code.
export function createAdvisor(config) {
  requireValue(arguments.length === 1, 'NATIVE_TRANSPORT_NOT_QUALIFIED');
  return createConversation(config);
}
export function reopenAdvisor(json, expectedProjectId) {
  requireValue(arguments.length === 2, 'NATIVE_TRANSPORT_NOT_QUALIFIED');
  const checkpoint = parseCheckpoint(json, expectedProjectId);
  return createConversation({ projectId: checkpoint.projectId, runtimeId: checkpoint.runtimeId }, { checkpoint });
}
