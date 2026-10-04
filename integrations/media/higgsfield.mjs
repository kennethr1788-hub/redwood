import { checkPlan, safeUrl, requireThat, token, json, shape, cost } from './contract.mjs';
import { envelope } from './receipt.mjs';

export const HIGGSFIELD_DISCOVERY = Object.freeze({
  catalog: 'https://console.higgsfield.ai', documentation: 'https://docs.higgsfield.ai/docs/llms.txt',
  accountConnector: 'https://mcp.higgsfield.ai/mcp',
  rule: 'Model-specific official schema plus account/mode capability evidence required; OpenAPI is supplementary.',
});
// Discovery is injected from an official catalog/tool owner, never scraped or
// inferred from account-mode names. Schema must cover this R1 parameter subset.
export function catalogEntry(value) {
  const c = json(value);
  shape(c, ['modelId', 'endpoint', 'documentation', 'schemaDigest', 'capability', 'environment', 'parametersVerified']);
  requireThat(c.capability === 'VIDEO_GENERATION' && c.environment === 'PRODUCTION' && c.parametersVerified === true, 'MODEL_NOT_QUALIFIED');
  requireThat(/^[a-z0-9_-]+(?:\/[a-z0-9_-]+){1,6}$/.test(c.modelId));
  safeUrl(c.endpoint, ['api.higgsfield.ai']);
  requireThat(c.endpoint === `https://api.higgsfield.ai/${c.modelId}`, 'MODEL_ENDPOINT_MISMATCH');
  safeUrl(c.documentation, ['docs.higgsfield.ai']); requireThat(/^[a-f0-9]{64}$/.test(c.schemaDigest));
  return c;
}
export function normalizeHiggsfield(body, request) {
  const b = json(body);
  // Allow vendor expansion but project only these fields; never store error prose.
  requireThat(b && typeof b === 'object'); token(b.request_id);
  const states = { queued: 'SUBMITTED', in_progress: 'PROCESSING', completed: 'SUCCEEDED', failed: 'FAILED', nsfw: 'FAILED', canceled: 'CANCELLED' };
  requireThat(Object.hasOwn(states, b.status), 'UNKNOWN_PROVIDER_STATE');
  return envelope(request, { providerRequestId: b.request_id, state: states[b.status],
    statusUrl: b.status_url ?? request.providerReceipt?.statusUrl ?? null,
    cancelUrl: b.cancel_url ?? request.providerReceipt?.cancelUrl ?? null,
    outputRefs: b.video ? [{ kind: 'video', url: b.video.url }] : [],
  });
}
/** Official HTTP interface, no built-in fetch or credentials. exchange is a
 * private server-side transport that resolves credentialRef, rejects redirects,
 * bounds response bytes and honors AbortSignal. No provider request in tests. */
export function higgsfieldTransport({ credentialRef, exchange, catalog }) {
  token(credentialRef); requireThat(typeof exchange === 'function');
  const entries = catalog.map(catalogEntry); requireThat(entries.length > 0 && entries.length <= 64);
  async function send(url, method, request, signal, body = null, idempotencyKey = null) {
    safeUrl(url, ['api.higgsfield.ai']);
    const result = await exchange({ url, method, body, credentialRef, idempotencyKey, redirect: 'error', maxRetries: 0, maxResponseBytes: 131072, signal });
    requireThat(result && Number.isInteger(result.status), 'INVALID_RESPONSE');
    return result;
  }
  async function status(request, signal) {
    requireThat(request.providerRequestId && request.providerReceipt?.statusUrl, 'MANUAL_RECONCILE_REQUIRED');
    const result = await send(request.providerReceipt.statusUrl, 'GET', request, signal);
    requireThat(result.status === 200, 'STATUS_UNKNOWN');
    return normalizeHiggsfield(result.body, request);
  }
  return Object.freeze({
    connectorId: 'higgsfield', mode: 'DIRECT_API',
    async submit(request, value, signal) {
      const p = checkPlan(value); requireThat(p.connectorId === 'higgsfield' && p.mode === 'DIRECT_API');
      const entry = entries.find(c => c.modelId === p.input.modelId); requireThat(entry, 'MODEL_NOT_QUALIFIED');
      const body = { prompt: p.input.prompt, duration: p.input.durationSeconds, aspect_ratio: p.input.aspectRatio };
      const response = await send(entry.endpoint, 'POST', request, signal, body, request.requestId);
      requireThat(response.status === 200 || response.status === 202, 'SUBMIT_UNKNOWN');
      return normalizeHiggsfield(response.body, request);
    },
    poll: status, reconcile: status,
    async cancel(request, signal) {
      requireThat(request.providerReceipt?.cancelUrl, 'CANCEL_UNAVAILABLE');
      const result = await send(request.providerReceipt.cancelUrl, 'POST', request, signal);
      requireThat(result.status === 202, 'CANCEL_UNCONFIRMED');
      return null;
    },
    async estimate(value, signal) {
      const p = checkPlan(value); requireThat(p.mode === 'DIRECT_API' && p.connectorId === 'higgsfield');
      const entry = entries.find(c => c.modelId === p.input.modelId); requireThat(entry, 'MODEL_NOT_QUALIFIED');
      const result = await send(`https://api.higgsfield.ai/estimate/${entry.modelId}`, 'POST', null, signal,
        { prompt: p.input.prompt, duration: p.input.durationSeconds, aspect_ratio: p.input.aspectRatio });
      requireThat(result.status === 200, 'ESTIMATE_UNKNOWN');
      const body = json(result.body);
      return { inputDigest: p.inputDigest, cost: body.usd === undefined ? null : cost({ amount: body.usd, unit: 'USD' }, 'DIRECT_API'), source: 'PROVIDER_ESTIMATE' };
    },
  });
}

export function accountTask(request, value) {
  const p = checkPlan(value); requireThat(p.mode === 'AGENT_ACCOUNT', 'TRANSPORT_MODE_MISMATCH');
  requireThat(p.effectDigest === request.effectDigest && p.inputDigest === request.inputDigest, 'PLAN_MISMATCH');
  return { schemaVersion: 1, requestId: request.requestId, inputDigest: p.inputDigest, sourceIdentity: p.sourceIdentity,
    connectorId: p.connectorId, mode: p.mode, billingMode: p.billingMode, action: p.action, input: p.input,
    connectorUrl: p.connectorId === 'higgsfield' ? 'https://mcp.higgsfield.ai/mcp' : 'https://api.elevenlabs.io/v1/mcp',
    executionAuthorized: false, requireProviderReceipt: true, allowApiFallback: false,
    prohibitedEffects: ['TOKEN_EXPORT', 'PUBLISH', 'SOURCE_REPLACEMENT', 'BLIND_RESUBMIT'],
  };
}
// A compatible native agent/client owns auth and tool invocation. This module
// never launches it, copies its token or promotes its final prose to a receipt.
export function accountTransport({ connectorId, invoke, reconcile, cancel }) {
  requireThat(['higgsfield', 'elevenlabs'].includes(connectorId) && typeof invoke === 'function');
  return { connectorId, mode: 'AGENT_ACCOUNT',
    submit: (r, p, signal) => invoke(accountTask(r, p), signal),
    ...(reconcile ? { reconcile, poll: reconcile } : {}), ...(cancel ? { cancel } : {}),
  };
}
