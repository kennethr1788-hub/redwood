import { json, shape, token, requireThat, safeUrl, cost, STATES } from './contract.mjs';
import { validateAsset } from './assets.mjs';

// Only a trusted transport/tool receipt mapper may supply this envelope. Neither
// an LLM completion string nor a portable JSON file is authenticated evidence.
export function receipt(value, request, assetHosts = []) {
  const r = json(value);
  shape(r, ['requestId', 'inputDigest', 'connectorId', 'mode', 'providerRequestId', 'state', 'evidence', 'statusUrl', 'cancelUrl', 'outputRefs', 'outputAssets', 'actualCost', 'usage']);
  requireThat(['requestId', 'inputDigest', 'connectorId', 'mode'].every(k => r[k] === request[k]), 'RECEIPT_BINDING');
  requireThat(STATES.includes(r.state) && !['DRAFT', 'CANCEL_REQUESTED'].includes(r.state), 'RECEIPT_STATE');
  requireThat(r.evidence === (request.mode === 'DIRECT_API' ? 'PROVIDER_API' : 'OFFICIAL_CONNECTOR_TOOL'), 'RECEIPT_EVIDENCE');
  if (r.providerRequestId !== null) token(r.providerRequestId);
  if (request.providerRequestId !== null) requireThat(r.providerRequestId === request.providerRequestId, 'PROVIDER_ID_CHANGED');
  if (['SUBMITTED', 'PROCESSING'].includes(r.state)) requireThat(r.providerRequestId !== null, 'PROVIDER_ID_REQUIRED');
  for (const field of ['statusUrl', 'cancelUrl']) if (r[field] !== null) {
    requireThat(request.connectorId === 'higgsfield' && request.mode === 'DIRECT_API', 'UNEXPECTED_CONTROL_URL');
    safeUrl(r[field], ['api.higgsfield.ai']);
    requireThat(r[field] === `https://api.higgsfield.ai/requests/${r.providerRequestId}/${field === 'statusUrl' ? 'status' : 'cancel'}`, 'CONTROL_URL_MISMATCH');
  }
  requireThat(Array.isArray(r.outputRefs) && r.outputRefs.length <= 8);
  r.outputRefs.forEach(ref => {
    shape(ref, ['kind', 'url']);
    requireThat(ref.kind === (request.action === 'VIDEO_GENERATION' ? 'video' : 'audio'));
    safeUrl(ref.url, assetHosts);
  });
  r.actualCost = cost(r.actualCost, request.mode);
  requireThat(Array.isArray(r.outputAssets) && r.outputAssets.length <= 8);
  requireThat(r.outputAssets.length === 0 || r.state === 'SUCCEEDED');
  r.outputAssets = r.outputAssets.map(a => validateAsset(a, { ...request, providerRequestId: r.providerRequestId }));
  requireThat(r.state !== 'SUCCEEDED' || r.outputRefs.length + r.outputAssets.length > 0, 'OUTPUT_REQUIRED');
  if (r.usage !== null) { shape(r.usage, ['characters']); requireThat(Number.isSafeInteger(r.usage.characters) && r.usage.characters >= 0 && r.usage.characters <= 10000000); }
  return r;
}
export function envelope(request, fields = {}) {
  return { requestId: request.requestId, inputDigest: request.inputDigest, connectorId: request.connectorId, mode: request.mode,
    providerRequestId: request.providerRequestId, state: 'UNKNOWN_RECONCILE', evidence: request.mode === 'DIRECT_API' ? 'PROVIDER_API' : 'OFFICIAL_CONNECTOR_TOOL',
    statusUrl: null, cancelUrl: null, outputRefs: [], outputAssets: [], actualCost: null, usage: null, ...fields };
}
