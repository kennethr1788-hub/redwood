import { randomUUID } from 'node:crypto';
import { canonicalJson, parseJson, freeze, shape, identifier, oneOf, requireValue } from '../agents/contract.mjs';
import { LIMITS, data, runtimeId } from './contracts.mjs';
import { normalizeTopics } from './knowledge.mjs';
export function validateCheckpoint(input, expectedProjectId) {
  const c = data(input);
  shape(c, ['schemaVersion', 'projectId', 'conversationId', 'runtimeId', 'style', 'lastTopicIds', 'unresolvedTopicIds']);
  requireValue(c.schemaVersion === 1 && c.projectId === expectedProjectId, 'CHECKPOINT_PROJECT_OR_VERSION');
  identifier(c.projectId); identifier(c.conversationId); runtimeId(c.runtimeId);
  oneOf(c.style, ['concise', 'step-by-step']);
  c.lastTopicIds = normalizeTopics(c.lastTopicIds); c.unresolvedTopicIds = normalizeTopics(c.unresolvedTopicIds);
  requireValue(Buffer.byteLength(canonicalJson(c)) <= LIMITS.checkpointBytes, 'CHECKPOINT_LIMIT');
  return freeze(c);
}
export function newCheckpoint(config) {
  return validateCheckpoint({ schemaVersion: 1, projectId: config.projectId, conversationId: randomUUID(),
    runtimeId: config.runtimeId, style: 'concise', lastTopicIds: [], unresolvedTopicIds: [] }, config.projectId);
}
export function parseCheckpoint(json, projectId) {
  requireValue(typeof json === 'string' && Buffer.byteLength(json) <= LIMITS.checkpointBytes, 'CHECKPOINT_LIMIT');
  return validateCheckpoint(parseJson(json), projectId);
}
export function remember(input, checkpoint) {
  const update = data(input); shape(update, ['style', 'unresolvedTopicIds']);
  return validateCheckpoint({ ...checkpoint, ...update }, checkpoint.projectId);
}
export function checkpointText(checkpoint) { return canonicalJson(validateCheckpoint(checkpoint, checkpoint.projectId)); }
