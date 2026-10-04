// Read-only shell adapter. The browser supplies selection/question, never state or transport.
import {createAdvisor, reopenAdvisor} from '../integrations/advisor/index.mjs';
import {createConversation} from '../integrations/advisor/engine.mjs';
import {parseCheckpoint} from '../integrations/advisor/continuity.mjs';
import {data, safeText, validateState} from '../integrations/advisor/contracts.mjs';
import {shape, oneOf, requireValue} from '../integrations/agents/contract.mjs';
import {ResumeRecord} from '../integrations/resume/contracts.mjs';
import {DISPLAY_NAMES} from './src/display-names.js';

const products = ['build', 'studio', 'grow'];
function selection(product, id) {
  oneOf(product, products);
  requireValue(id === null || (typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,59}$/.test(id)), 'PROJECT_SELECTION');
  return product + '.' + (id ?? 'workspace');
}
export async function advisorProjects(product, ownerGet) {
  selection(product, null);
  const value = await ownerGet(product, '/api/projects');
  const list = product === 'build' ? value.projects : value;
  requireValue(Array.isArray(list), 'OWNER_LIST');
  return list.slice(0, 32).map(p => { requireValue(p && p.id !== null && p.id !== undefined, 'OWNER_PROJECT_ID'); selection(product, p.id); safeText(p.name, 100); return {id: p.id, name: p.name}; });
}
export async function currentProjection(product, id, ownerGet) {
  const projectId = selection(product, id);
  if (id === null) return {state: null, receipt: null};
  try {
    if (product === 'build') {
      const record = ResumeRecord.parse(await ownerGet(product, '/api/projects/' + id + '/resume'));
      requireValue(record.product === product && record.projectId === id, 'OWNER_IDENTITY');
      const stale = ['STALE', 'OUTPUT_STALE_OR_MISSING'].includes(record.completionState);
      const current = record.currentRevision !== null && record.completionState !== 'UNKNOWN';
      const state = validateState({projectId, product, revision: record.currentRevision,
        freshness: stale ? 'STALE' : current ? 'CURRENT' : 'UNKNOWN', completionState: record.completionState}, projectId);
      const observed = record.receipts.find(r => r.kind === 'VERIFICATION' && r.freshness === 'CURRENT' && r.binding.revision === record.currentRevision);
      const receipt = observed ? {product, revision: record.currentRevision,
        status: ['PASSED','FAILED','RUNNING'].includes(observed.status) ? observed.status : 'UNKNOWN', errorCode: null} : null;
      return {state, receipt};
    }
    if (product === 'studio') {
      const view = await ownerGet(product, '/api/projects/' + id);
      requireValue(view.studio?.id === id && Number.isSafeInteger(view.studio.revision) && view.studio.revision >= 0 && Array.isArray(view.exports), 'OWNER_IDENTITY');
      requireValue(view.exports.length <= 32 && view.exports.every(f => f && (f.stale === undefined || typeof f.stale === 'boolean')), 'OWNER_EXPORTS');
      // Studio's GET rechecks source binding and every export hash. It owns stale/rendered truth.
      const stale = view.exports.some(f => f.stale === true);
      return {state: validateState({projectId, product, revision: String(view.studio.revision),
        freshness: stale ? 'STALE' : 'CURRENT', completionState: stale ? 'STALE' : view.exports.length ? 'RENDERED' : 'NOT_RUN'}, projectId), receipt: null};
    }
    // Grow's ordinary project GET can invalidate/save inputs. Use its narrow no-write projection.
    const state = await ownerGet(product, '/api/projects/' + id + '/advisor-context');
    requireValue(state.projectId === id && state.product === product, 'OWNER_IDENTITY');
    return {state: validateState({...state, projectId}, projectId), receipt: null};
  } catch { return {state: null, receipt: null}; }
}
export async function askAdvisor(input, ownerGet, doctor, {transport = null, signal, timeoutMs} = {}) {
  const q = data(input);
  shape(q, ['product','projectId','runtimeId','question','intent','checkpoint']);
  const projectId = selection(q.product, q.projectId);
  oneOf(q.runtimeId, [null, 'codex', 'claude']);
  oneOf(q.intent, ['HELP', 'PREPARE_CODING_PROMPT', 'NAVIGATE']);
  safeText(q.question, 2000);
  requireValue(q.checkpoint === null || (typeof q.checkpoint === 'string' && Buffer.byteLength(q.checkpoint) <= 2048), 'CHECKPOINT_LIMIT');
  let session;
  if (q.checkpoint !== null) {
    // Reopen validates exact fields, topics and project. Corrupt/cross-project data is discarded.
    try { session = reopenAdvisor(q.checkpoint, projectId); } catch { /* No cached facts are used. */ }
  }
  if (!session || session.runtime.runtimeId !== q.runtimeId) session = createAdvisor({projectId, runtimeId: q.runtimeId, displayName: DISPLAY_NAMES.advisor});
  // Only trusted launcher code supplies the native transport; request-body fields stay closed.
  if (q.runtimeId === 'codex' && q.intent !== 'PREPARE_CODING_PROMPT' && transport !== null) {
    session = createConversation({projectId, runtimeId: 'codex', displayName: DISPLAY_NAMES.advisor},
      {checkpoint: parseCheckpoint(session.checkpoint(), projectId), transport, ...(timeoutMs === undefined ? {} : {timeoutMs})});
  }
  const projection = await currentProjection(q.product, q.projectId, ownerGet);
  const connectorId = /higgsfield/i.test(q.question) ? 'higgsfield' : /elevenlabs/i.test(q.question) ? 'elevenlabs' : q.runtimeId;
  const row = doctor.rows.find(r => r.connectorId === connectorId);
  const question = {question: q.question, intent: q.intent, state: projection.state,
    liveContext: {projectId, page: q.product, receipt: projection.receipt, connector: row ? {id: connectorId, status: row.status} : null}};
  let result = await session.ask(question, {signal});
  const nativeStatus = result.status;
  if (['RUNTIME_ERROR', 'TIMED_OUT', 'INVALID_RESPONSE'].includes(nativeStatus)) {
    const local = reopenAdvisor(session.checkpoint(), projectId);
    const fallback = await local.ask(question);
    result = {...fallback, modelCalls: result.modelCalls,
      answer: 'Codex could not answer this time. Here is local Advisor help.\n\n' + fallback.answer.split('\n\n').slice(1).join('\n\n')};
  }
  return {reply: {...result, answerSource: result.status === 'ANSWERED' ? 'CODEX' : 'LOCAL', nativeStatus,
    displayName: DISPLAY_NAMES.advisor}, checkpoint: session.checkpoint(),
    selection: {product: q.product, projectId: q.projectId}, mediaIntegration: doctor.mediaIntegration};
}
