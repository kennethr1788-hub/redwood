import { execFile } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { plan, digest, sha256, requireThat, shape, token, MediaError } from './contract.mjs';
import { MediaRunner } from './runner.mjs';
import { envelope } from './receipt.mjs';
import { collectAudio, importAsset } from './assets.mjs';

// Qualified through the provider-owned CLI, not the dollar-billed API catalog.
// Deliberately one observed text-to-video model; no generic provider router.
const MODEL = 'grok_video';
const CDN_HOSTS = ['d8j0ntlcm91z4.cloudfront.net'];
const STATES = { queued: 'SUBMITTED', pending: 'SUBMITTED', processing: 'PROCESSING', in_progress: 'PROCESSING', completed: 'SUCCEEDED', failed: 'FAILED', nsfw: 'FAILED', canceled: 'CANCELLED', cancelled: 'CANCELLED' };

/** Credentials stay with the official CLI. Never call auth token, log raw
 * responses, forward stderr, use a shell, or retry a create command. */
export function nativeCommand(executable, args, signal) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 20000, signal, windowsHide: true }, (error, stdout) => {
      if (error) return reject(new MediaError('CLI_RESULT_UNKNOWN'));
      try { resolve(JSON.parse(stdout)); } catch { reject(new MediaError('CLI_RESULT_UNKNOWN')); }
    });
  });
}

async function downloadAsset(value, signal) {
  let url; try { url = new URL(value); } catch { throw new MediaError('UNAPPROVED_ASSET_HOST'); }
  requireThat(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && CDN_HOSTS.includes(url.hostname), 'UNAPPROVED_ASSET_HOST');
  // Query credentials, if present, exist only in this request closure. The
  // receipt and journal contain the local imported asset, never this URL.
  const response = await fetch(url, { redirect: 'error', signal });
  requireThat(response.ok && !response.redirected, 'ASSET_DOWNLOAD_UNKNOWN');
  return collectAudio(response.body, signal);
}

export function createHiggsfieldCliAccount({ journal, assetRoot, probe, executable,
  authorize = async () => false, onObservation = async () => {}, clock = Date.now,
  command = nativeCommand, download = downloadAsset }) {
  requireThat(isAbsolute(executable) && typeof probe === 'function', 'TRANSPORT_CONFIGURATION_REQUIRED');
  const st = lstatSync(executable);
  requireThat(st.isFile() && !st.isSymbolicLink(), 'UNSAFE_EXECUTABLE');
  const executableDigest = sha256(readFileSync(executable));
  const prepared = new WeakMap(), active = new Map();
  const call = (args, signal) => {
    requireThat(sha256(readFileSync(executable)) === executableDigest, 'EXECUTABLE_CHANGED');
    return command(executable, [...args, '--json'], signal);
  };
  async function account(signal) {
    const workspace = await call(['workspace', 'status'], signal);
    token(workspace.id);
    const status = await call(['account', 'status'], signal);
    requireThat(Number.isFinite(status.credits) && status.credits >= 0, 'ACCOUNT_BALANCE_UNKNOWN');
    requireThat(typeof status.subscription_plan_type === 'string', 'ACCOUNT_STATUS_UNKNOWN');
    return { scopeIdentity: digest({ connectorId: 'higgsfield', mode: 'AGENT_ACCOUNT', workspaceId: workspace.id }),
      credits: status.credits, plan: status.subscription_plan_type };
  }
  const inputArgs = p => [MODEL, '--prompt', p.input.prompt, '--duration', String(p.input.durationSeconds), '--aspect_ratio', p.input.aspectRatio];
  async function estimate(p, signal) {
    const value = await call(['generate', 'cost', ...inputArgs(p)], signal);
    const credits = value.credits_exact ?? value.credits;
    requireThat(Number.isFinite(credits) && credits > 0 && /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(String(credits)), 'COST_UNKNOWN');
    return credits;
  }
  async function readExisting(r, signal) {
    requireThat(r.providerRequestId !== null, 'MANUAL_RECONCILE_REQUIRED');
    requireThat((await account(signal)).scopeIdentity === r.scopeIdentity, 'ACCOUNT_CHANGED');
    const job = await call(['generate', 'get', r.providerRequestId], signal);
    requireThat(job.id === r.providerRequestId && job.job_type === MODEL, 'PROVIDER_JOB_MISMATCH');
    requireThat(Object.hasOwn(STATES, job.status), 'UNKNOWN_PROVIDER_STATE');
    const state = STATES[job.status];
    if (state !== 'SUCCEEDED') return envelope(r, { state });
    requireThat(typeof job.result_url === 'string', 'OUTPUT_REQUIRED');
    const bytes = await download(job.result_url, signal);
    const asset = await importAsset({ root: assetRoot, bytes, kind: 'video', requestId: r.requestId, providerRequestId: r.providerRequestId, probe, signal });
    const result = envelope(r, { state, outputAssets: [asset] });
    await onObservation({ schemaVersion: 1, kind: 'COMPLETED', connectorId: 'higgsfield', mode: 'AGENT_ACCOUNT',
      action: 'VIDEO_GENERATION', modelId: MODEL, scopeIdentity: r.scopeIdentity, inputDigest: r.inputDigest,
      requestId: r.requestId, providerRequestId: r.providerRequestId, checkedAt: clock(),
      evidenceDigest: digest({ requestId: r.requestId, providerRequestId: r.providerRequestId, sha256: asset.sha256 }),
      outputSha256: asset.sha256, review: 'UNREVIEWED' });
    return result;
  }
  const transport = {
    connectorId: 'higgsfield', mode: 'AGENT_ACCOUNT',
    async submit(r, p, signal) {
      const admitted = active.get(p.effectDigest);
      requireThat(admitted && admitted.expiresAt > clock(), 'PREFLIGHT_REQUIRED');
      const current = await account(signal);
      requireThat(current.scopeIdentity === p.scopeIdentity, 'ACCOUNT_CHANGED');
      const credits = await estimate(p, signal);
      requireThat(credits <= admitted.maxCredits && credits <= current.credits && credits <= admitted.credits, 'COST_EXCEEDS_AUTHORIZATION');
      // Arm/durable effect identity is owned by MediaRunner before this call.
      // No --wait: persist the provider ID before download or long polling.
      const response = await call(['generate', 'create', ...inputArgs(p)], signal);
      // Native 1.1.20 without --wait emits string IDs (JSON []string), not
      // the job objects returned by get/list or create --wait. Keep this a
      // single acknowledgement: never select one ID from a multi-job reply.
      const jobs = Array.isArray(response) ? response : Array.isArray(response?.jobs) ? response.jobs : [response];
      requireThat(jobs.length === 1, 'UNEXPECTED_JOB_COUNT');
      const job = jobs[0];
      const id = typeof job === 'string' && Array.isArray(response) ? job : job?.id;
      token(id);
      requireThat(job?.job_type === undefined || job.job_type === MODEL, 'PROVIDER_JOB_MISMATCH');
      // Even an immediately completed response is read by exact ID on the next
      // explicit poll. This commits acceptance before consuming any asset URL.
      return envelope(r, { providerRequestId: id, state: 'PROCESSING' });
    },
    poll: readExisting, reconcile: readExisting,
  };
  const runner = new MediaRunner({ journal, transport, clock, timeoutMs: 60000,
    authorize: ({ operation, request }) => authorize({ operation, request, preflight: active.get(request.effectDigest)?.summary ?? null }) });
  return Object.freeze({
    async prepare(spec, { maxAccountCredits }) {
      shape(spec, ['intentId', 'sourceIdentity', 'input']);
      requireThat(Number.isFinite(maxAccountCredits) && maxAccountCredits > 0, 'BUDGET_REQUIRED');
      requireThat(spec.input?.modelId === MODEL && spec.input.durationSeconds <= 15, 'MODEL_NOT_QUALIFIED');
      const acct = await account();
      const p = plan({ ...spec, connectorId: 'higgsfield', mode: 'AGENT_ACCOUNT', action: 'VIDEO_GENERATION', scopeIdentity: acct.scopeIdentity });
      const model = await call(['model', 'get', MODEL]);
      requireThat(model.job_type === MODEL && model.type === 'video' && Array.isArray(model.params), 'MODEL_NOT_QUALIFIED');
      requireThat(['prompt', 'duration', 'aspect_ratio'].every(name => model.params.some(x => x.name === name)), 'MODEL_NOT_QUALIFIED');
      requireThat(model.params.find(x => x.name === 'aspect_ratio')?.enum?.includes(p.input.aspectRatio), 'MODEL_NOT_QUALIFIED');
      const credits = await estimate(p);
      requireThat(credits <= maxAccountCredits && credits <= acct.credits, 'COST_EXCEEDS_AUTHORIZATION');
      const checkedAt = clock(), expiresAt = checkedAt + 30000;
      const summary = { schemaVersion: 1, kind: 'PREFLIGHT', connectorId: 'higgsfield', mode: 'AGENT_ACCOUNT',
        action: 'VIDEO_GENERATION', modelId: MODEL, scopeIdentity: p.scopeIdentity, inputDigest: p.inputDigest,
        authenticated: true, accountCredits: acct.credits, subscriptionPlan: acct.plan,
        expectedAccountCredits: credits, maxAccountCredits, executableDigest, modelSchemaDigest: digest(model), checkedAt, expiresAt };
      summary.evidenceDigest = digest(summary);
      const observation = { connectorId: 'higgsfield', mode: 'AGENT_ACCOUNT', action: 'VIDEO_GENERATION', scopeIdentity: p.scopeIdentity,
        modelId: MODEL, detected: true, authenticated: true, verified: true, checkedAt, expiresAt, evidenceDigest: summary.evidenceDigest };
      const quote = { cost: { amount: String(credits), unit: 'ACCOUNT_CREDITS' }, inputDigest: p.inputDigest, expiresAt, source: 'PROVIDER_ESTIMATE' };
      const handle = Object.freeze({ ...summary });
      prepared.set(handle, { p, observation, quote, summary, expiresAt, maxCredits: maxAccountCredits, credits });
      await onObservation(summary);
      return handle;
    },
    async submit(handle) {
      const entry = prepared.get(handle); requireThat(entry && entry.expiresAt > clock(), 'PREFLIGHT_REQUIRED');
      active.set(entry.p.effectDigest, entry);
      try { return await runner.submit(entry.p, entry.observation, entry.quote); }
      finally { active.delete(entry.p.effectDigest); prepared.delete(handle); }
    },
    async reconcileSubmission(id, spec) {
      // Explicit recovery only. A lost create reply never causes another
      // create. Reconstruct the immutable effect, then require one exact native
      // history match in the original submission window and current account.
      const r = journal.get(id);
      requireThat(r.state === 'UNKNOWN_RECONCILE' && r.providerRequestId === null, 'RECONCILE_NOT_REQUIRED');
      shape(spec, ['intentId', 'sourceIdentity', 'input']);
      const acct = await account();
      const p = plan({ ...spec, connectorId: 'higgsfield', mode: 'AGENT_ACCOUNT', action: 'VIDEO_GENERATION', scopeIdentity: acct.scopeIdentity });
      requireThat(p.effectDigest === r.effectDigest && p.input.modelId === MODEL, 'PLAN_MISMATCH');
      const matches = job => job.job_type === MODEL && job.params?.prompt === p.input.prompt &&
        job.params.duration === p.input.durationSeconds && job.params.aspect_ratio === p.input.aspectRatio &&
        Number.isFinite(Date.parse(job.created_at)) && Date.parse(job.created_at) >= r.submittedAt - 1000 && Date.parse(job.created_at) <= r.submittedAt + 60000;
      const jobs = await call(['generate', 'list', '--video', '--size', '10']);
      requireThat(Array.isArray(jobs), 'MANUAL_RECONCILE_REQUIRED');
      const candidates = jobs.filter(matches);
      requireThat(candidates.length === 1, 'MANUAL_RECONCILE_REQUIRED'); token(candidates[0].id);
      const job = await call(['generate', 'get', candidates[0].id]);
      requireThat(job.id === candidates[0].id && matches(job), 'PROVIDER_JOB_MISMATCH');
      journal.observe(id, r.revision, envelope(r, { providerRequestId: job.id, state: 'PROCESSING' }));
      return runner.reconcile(id);
    },
    poll: id => runner.poll(id), reconcile: id => runner.reconcile(id),
  });
}
