import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { checkPlan, requireThat, token, MediaError } from './contract.mjs';
import { collectAudio, readBoundFile, importAsset, MAX_ASSET_BYTES } from './assets.mjs';
import { envelope } from './receipt.mjs';

export const ELEVENLABS_INTERFACE = Object.freeze({
  sdk: '@elevenlabs/elevenlabs-js', version: '2.70.0', license: 'MIT',
  api: 'https://api.elevenlabs.io', hostedMcp: 'https://api.elevenlabs.io/v1/mcp',
  directCapabilities: ['TEXT_TO_SPEECH', 'AUDIO_ISOLATION'], accountCapabilities: ['TEXT_TO_SPEECH'],
  cancellation: 'NO_QUALIFIED_REMOTE_CANCEL_FOR_INITIAL_ENDPOINTS',
  reconciliation: 'MANUAL_PROVIDER_HISTORY_OR_SUPPORT_RECEIPT_REQUIRED',
});

// Required injected fetch: constructing or importing this module never opts into
// live network. The caller owns the narrowly admitted egress implementation.
function guardedFetch(fetchImpl) {
  return async (input, options) => {
    try {
      const url = new URL(String(input));
      requireThat(url.origin === 'https://api.elevenlabs.io' && !url.username && !url.password && !url.hash && !/%|\\/.test(url.href), 'UNAPPROVED_HOST');
      requireThat(options.method === 'POST' && (/^\/v1\/text-to-speech\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.pathname === '/v1/audio-isolation'), 'UNAPPROVED_ENDPOINT');
      requireThat([...url.searchParams.keys()].every(k => k === 'output_format'), 'UNAPPROVED_QUERY');
      const response = await fetchImpl(url.href, { ...options, redirect: 'error' });
      requireThat(!response.redirected, 'PROVIDER_RESPONSE_UNKNOWN');
      if (response.status >= 300) {
        await response.body?.cancel().catch(() => {});
        return new Response('{}', { status: response.status });
      }
      return response;
    } catch {
      // SDK 2.70.0 clears its timeout after fetch resolves, not in finally.
      // Resolve a sanitized error response so its timer is released on network
      // errors too. Runner still records UNKNOWN, never provider FAILED.
      return new Response('{}', { status: 599 });
    }
  };
}

export function elevenLabsTransport({ credentialRef, resolveCredential, fetch: fetchImpl, inputRoot, assetRoot, probe }) {
  token(credentialRef);
  requireThat(typeof resolveCredential === 'function' && typeof fetchImpl === 'function' && typeof probe === 'function', 'TRANSPORT_CONFIGURATION_REQUIRED');
  return Object.freeze({
    connectorId: 'elevenlabs', mode: 'DIRECT_API',
    async submit(request, value, signal, accepted) {
      try {
        const p = checkPlan(value);
        requireThat(p.connectorId === 'elevenlabs' && p.mode === 'DIRECT_API' && request.effectDigest === p.effectDigest, 'PLAN_MISMATCH');
        requireThat(!signal.aborted, 'INTERRUPTED');
        // Reference only in adapter closure; no env fallback, config scan or log.
        const apiKey = await resolveCredential(credentialRef);
        requireThat(typeof apiKey === 'string' && /^[\x21-\x7e]{1,512}$/.test(apiKey), 'CREDENTIAL_UNAVAILABLE');
        requireThat(!signal.aborted, 'INTERRUPTED');
        const client = new ElevenLabsClient({ apiKey, baseUrl: ELEVENLABS_INTERFACE.api, fetch: guardedFetch(fetchImpl), maxRetries: 0, logging: { silent: true } });
        const options = { maxRetries: 0, timeoutInSeconds: 30, abortSignal: signal };
        let response;
        if (p.action === 'TEXT_TO_SPEECH') {
          const { voiceId, ...body } = p.input;
          response = await client.textToSpeech.convert(voiceId, body, options).withRawResponse();
        } else {
          const bytes = readBoundFile(inputRoot, p.input.audio);
          const audio = new File([bytes], 'source-audio', { type: p.input.audio.mime });
          response = await client.audioIsolation.convert({ audio, fileFormat: p.input.fileFormat }, options).withRawResponse();
        }
        const headers = response.rawResponse.headers;
        const providerRequestId = headers.get('request-id');
        if (providerRequestId !== null) token(providerRequestId);
        const base = envelope(request, { providerRequestId });
        // Persist the accepted identity even if later usage/media fields fail.
        accepted({ ...base, state: providerRequestId ? 'PROCESSING' : 'UNKNOWN_RECONCILE' });
        const characters = headers.get('character-cost');
        requireThat(characters === null || /^(?:0|[1-9][0-9]{0,6})$/.test(characters), 'INVALID_USAGE');
        base.usage = characters === null ? null : { characters: Number(characters) };
        const bytes = await collectAudio(response.data, signal);
        requireThat(!signal.aborted && bytes.length <= MAX_ASSET_BYTES, 'INTERRUPTED');
        const asset = await importAsset({ root: assetRoot, bytes, kind: 'audio', requestId: request.requestId, providerRequestId, probe, signal });
        requireThat(!signal.aborted, 'INTERRUPTED');
        return { ...base, state: 'SUCCEEDED', outputAssets: [asset] };
      } catch { throw new MediaError('DELIVERY_UNKNOWN'); }
    },
    // Do not fake a poll/cancel endpoint or retry a potentially billed request.
    async reconcile() { throw new MediaError('MANUAL_RECONCILE_REQUIRED'); },
  });
}
