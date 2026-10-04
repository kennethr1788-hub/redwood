#!/usr/bin/env node
// Explicit local entry for the existing media leaf. It does not add an HTTP
// executor, launcher action, background poller, or credential configuration.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { projectCompletedObservation } from './local-doctor.mjs';
import { RequestJournal } from './journal.mjs';
import { createHiggsfieldCliAccount } from './higgsfield-cli.mjs';
import { checkedRoot, verifyAsset } from './assets.mjs';
import { requireThat, sha256 } from './contract.mjs';

function run(executable, args) {
  return new Promise((resolveRun, reject) => execFile(executable, args,
    { encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 },
    (error, stdout) => error ? reject(Error('LOCAL_PROBE_FAILED')) : resolveRun(stdout)));
}

const args = process.argv.slice(2), operation = args.shift();
const options = {};
for (let i = 0; i < args.length; i += 2) {
  requireThat(/^--[a-z-]+$/.test(args[i]) && typeof args[i + 1] === 'string', 'INVALID_ARGUMENTS');
  requireThat(!Object.hasOwn(options, args[i]), 'DUPLICATE_ARGUMENT'); options[args[i]] = args[i + 1];
}
const allowed = ['--state-root', '--request', '--max-account-credits', '--higgsfield', '--ffprobe', '--ffmpeg', '--request-id', '--allow-submit', '--connections-root'];
requireThat(Object.keys(options).every(k => allowed.includes(k)), 'INVALID_ARGUMENTS');
requireThat(['preflight', 'submit', 'poll', 'reconcile', 'inspect'].includes(operation), 'INVALID_OPERATION');
requireThat(isAbsolute(options['--state-root'] ?? ''), 'PRIVATE_ROOT_REQUIRED');
const root = resolve(options['--state-root']); checkedRoot(root);
const assetRoot = join(root, 'assets'); mkdirSync(assetRoot, { mode: 0o700, recursive: true }); checkedRoot(assetRoot);
const journal = new RequestJournal({ root });
try {
  if (operation === 'inspect') {
    const r = journal.get(options['--request-id']);
    console.log(JSON.stringify({ record: r, assetIntegrity: r.outputAssets.map(a => ({ path: a.path, sha256: a.sha256, valid: verifyAsset(assetRoot, a), review: a.review })) }));
  } else {
    for (const key of ['--higgsfield', '--ffprobe', '--ffmpeg']) requireThat(isAbsolute(options[key] ?? ''), 'EXECUTABLE_REQUIRED');
    const probe = async (bytes, kind) => {
      const file = join(assetRoot, `probe-${randomUUID()}.mp4`);
      writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
      try {
        const meta = JSON.parse(await run(options['--ffprobe'], ['-v', 'error', '-protocol_whitelist', 'file', '-show_streams', '-show_format', '-of', 'json', file]));
        const stream = meta.streams?.find(s => s.codec_type === kind);
        requireThat(stream && Number(meta.format?.duration) > 0, 'PROBE_FAILED');
        await run(options['--ffmpeg'], ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-i', file, '-f', 'null', '-']);
        return { sha256: sha256(bytes), kind, valid: true, durationMs: Math.round(Number(meta.format.duration) * 1000), codec: stream.codec_name };
      } finally { unlinkSync(file); }
    };
    const adapter = createHiggsfieldCliAccount({ journal, assetRoot, probe, executable: options['--higgsfield'],
      authorize: async ({ operation: action, preflight }) => action === 'SUBMIT' && options['--allow-submit'] === 'yes' && preflight !== null,
      onObservation: async observation => {
        const tmp = join(root, `observation-${randomUUID()}.json`);
        writeFileSync(tmp, JSON.stringify(observation, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        renameSync(tmp, join(root, `${observation.kind.toLowerCase()}-observation.json`));
        projectCompletedObservation(observation, { directory: options['--connections-root'] });
      } });
    if (['preflight', 'submit'].includes(operation)) {
      requireThat(isAbsolute(options['--request'] ?? ''), 'REQUEST_REQUIRED');
      requireThat(operation !== 'submit' || options['--allow-submit'] === 'yes', 'NOT_AUTHORIZED');
      const spec = JSON.parse(readFileSync(options['--request'], 'utf8'));
      const prepared = await adapter.prepare(spec, { maxAccountCredits: Number(options['--max-account-credits']) });
      console.log(JSON.stringify({ preflight: prepared }));
      if (operation === 'submit') console.log(JSON.stringify({ record: await adapter.submit(prepared) }));
    } else if (operation === 'reconcile' && options['--request']) {
      requireThat(isAbsolute(options['--request']), 'REQUEST_REQUIRED');
      console.log(JSON.stringify({ record: await adapter.reconcileSubmission(options['--request-id'], JSON.parse(readFileSync(options['--request'], 'utf8'))) }));
    } else console.log(JSON.stringify({ record: await adapter[operation](options['--request-id']) }));
  }
} catch (error) { console.error(JSON.stringify({ error: /^[A-Z_]+$/.test(error.message) ? error.message : 'MEDIA_OPERATION_FAILED' })); process.exitCode = 1; }
finally { journal.close(); }
