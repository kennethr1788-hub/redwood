import { jsonData, shape, oneOf, identifier, text, freeze, requireValue } from '../agents/contract.mjs';
import { boundedJSON, revision } from '../resume/validation.mjs';
import { completion } from '../resume/contracts.mjs';
import { CONNECTION_STATES } from '../connectors/registry.mjs';
import { DISPLAY_NAMES } from '../../launcher/src/display-names.js';

export const LIMITS = freeze({ questionChars: 2000, answerChars: 2400, nextStepChars: 500,
  promptChars: 4000, contextBytes: 32768, corpusBytes: 108000, sectionChars: 6000, documentBytes: 6000,
  retrievedSections: 3, checkpointBytes: 2048, timeoutMs: 60000 });
export const ROLE_ID = 'advisor';
export const DEFAULT_DISPLAY_NAME = `${DISPLAY_NAMES.umbrella} ${DISPLAY_NAMES.advisor}`;
export const RUNTIME_IDS = freeze(['codex', 'claude']);
export const INTENTS = freeze(['HELP', 'PREPARE_CODING_PROMPT', 'NAVIGATE']);
export const DESTINATIONS = freeze(['build', 'studio', 'grow', 'connections']);

// Reuse the bridge's descriptor-safe JSON copy and resume's broader secret checks.
// No pattern matcher is a general DLP guarantee. No raw text is persisted here.
export function data(value) { return boundedJSON(jsonData(value), 32768); }
export function safeText(value, max) { text(value, max); boundedJSON({ value }); return value; }
export function runtimeId(value) { if (value !== null) oneOf(value, RUNTIME_IDS); return value; }
export function validateConfig(input) {
  const c = data(input);
  shape(c, ['projectId', 'runtimeId'], ['displayName']);
  identifier(c.projectId); runtimeId(c.runtimeId);
  if (c.displayName !== undefined) safeText(c.displayName, 80);
  return freeze({ ...c, displayName: c.displayName ?? DEFAULT_DISPLAY_NAME });
}
export function validateState(input, projectId) {
  if (input === null) return null;
  shape(input, ['projectId', 'product', 'revision', 'freshness', 'completionState']);
  requireValue(input.projectId === projectId, 'PROJECT_MISMATCH');
  oneOf(input.product, ['build', 'studio', 'grow']); revision(input.revision);
  oneOf(input.freshness, ['CURRENT', 'STALE', 'UNKNOWN']); completion(input.completionState);
  requireValue(input.freshness !== 'CURRENT' || input.revision !== null, 'CURRENT_REQUIRES_REVISION');
  return freeze(input);
}
export function validateQuestion(input, projectId) {
  const q = data(input);
  shape(q, ['question'], ['intent', 'state', 'supportIntent', 'liveContext']); safeText(q.question, LIMITS.questionChars);
  // The engine handles unsupported action intents as a bounded refusal.
  if (q.intent !== undefined) identifier(q.intent);
  if (q.supportIntent !== undefined) identifier(q.supportIntent);
  return freeze({ question: q.question, intent: q.intent ?? 'HELP', state: validateState(q.state ?? null, projectId),
    ...(q.supportIntent === undefined ? {} : { supportIntent: q.supportIntent }), liveContext: validateLiveContext(q.liveContext ?? null, projectId) });
}
export function validateLiveContext(c, projectId) {
  if (c === null) return null;
  shape(c, ['projectId', 'page', 'receipt', 'connector']);
  requireValue(c.projectId === projectId, 'PROJECT_MISMATCH');
  oneOf(c.page, [null, 'home', 'build', 'studio', 'grow', 'connections']);
  if (c.receipt !== null) {
    shape(c.receipt, ['product', 'revision', 'status', 'errorCode']);
    oneOf(c.receipt.product, ['build', 'studio', 'grow']); revision(c.receipt.revision);
    oneOf(c.receipt.status, ['PASSED', 'FAILED', 'RUNNING', 'UNKNOWN']);
    if (c.receipt.errorCode !== null) identifier(c.receipt.errorCode);
  }
  if (c.connector !== null) {
    shape(c.connector, ['id', 'status']); oneOf(c.connector.id, ['codex', 'claude', 'higgsfield', 'elevenlabs']);
    oneOf(c.connector.status, CONNECTION_STATES);
  }
  return freeze(c);
}
export function validateModelAnswer(input) {
  const a = data(input);
  shape(a, ['answer', 'nextStep', 'navigateTo']);
  safeText(a.answer, LIMITS.answerChars); safeText(a.nextStep, LIMITS.nextStepChars);
  if (a.navigateTo !== null) oneOf(a.navigateTo, DESTINATIONS);
  requireValue(!/(?:<\/?(?:think|analysis|reasoning)\b|chain[ -]of[ -]thought|hidden (?:lens|lenses|reasoning)|general\/coherence|product\/minimalism|internal (?:guidance|lens|lenses)|system prompt|\b(?:coherence|safety|continuity|integrations)\s*(?:lens|perspective)\b)/i.test(a.answer + '\n' + a.nextStep), 'INTERNAL_OUTPUT_REJECTED');
  return freeze(a);
}
