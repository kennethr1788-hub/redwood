// Native conversational transport, owned by the local launcher, never browser configuration.
import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parseAuthStatus} from '../agents/adapters.mjs';
import {LIMITS, validateModelAnswer} from './contracts.mjs';

export const CODEX_VERSION = 'codex-cli 0.159.2';
const schema = {type: 'object', additionalProperties: false,
  properties: {answer: {type: 'string'}, nextStep: {type: 'string'},
    navigateTo: {type: ['string', 'null'], enum: ['build', 'studio', 'grow', 'connections', null]}},
  required: ['answer', 'nextStep', 'navigateTo']};
const error = code => Object.assign(new Error(code), {code});
const publicErrorTerms = new Set(['skip_host_skill_discovery', 'suppress_unstable_features_warning']);

// Error fields only, never a trace/logger. Bound before inspecting; redact before
// truncating the retained message. A prompt echo is withheld in its entirety.
export function sanitizeNativeFailure(event, privateText = '') {
  const fields = [event?.code, event?.message, event?.error?.code, event?.error?.message];
  let message = fields.filter(v => typeof v === 'string').map(v => Buffer.from(v).subarray(0, 4096).toString('utf8')).join(' ').slice(0, 8192);
  const contextLines = privateText.split('\n').filter(line => line.length >= 12);
  if (contextLines.some(line => message.includes(line) || (line.length > 80 && message.includes(line.slice(0, 80))))) message = '[CONTEXT_ECHO_WITHHELD]';
  message = message.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/-----BEGIN[\s\S]*?(?:-----END[^\n]*|$)/g, '[KEY]')
    .replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, '[URL]')
    .replace(/(?:[A-Za-z]:\\|~\/|\/)[^\s"'<>]*/g, '[PATH]')
    .replace(/\b(?:bearer|basic)\s+[^\s,;"']+/gi, '[AUTH]')
    .replace(/\b(?:authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[SECRET]')
    .replace(/\b[A-Za-z0-9_+\/.=-]{24,}\b/g, token => publicErrorTerms.has(token) ? token : '[OPAQUE]')
    .replace(/[^\S ]+/g, ' ').trim();
  while (Buffer.byteLength(message) > 768) message = message.slice(0, -1);
  return Object.freeze({kind: event?.type === 'turn.failed' ? 'TURN_FAILED' : 'NATIVE_ERROR', message: message || '[NO_SAFE_ERROR_TEXT]'});
}

export function codexEnvironment(source) {
  // Provider-owned default HOME auth only. Never inherit API keys, endpoints, proxy,
  // alternate CODEX_HOME, Node injection, SSH agents or other provider credentials.
  return Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'USER', 'LOGNAME', 'LANG']
    .filter(key => typeof source[key] === 'string').map(key => [key, source[key]]));
}

export function codexArguments(cwd) {
  const disabled = ['shell_tool', 'shell_snapshot', 'apps', 'plugins', 'hooks',
    'multi_agent', 'multi_agent_v2', 'memories', 'browser_use', 'computer_use',
    'in_app_browser', 'image_generation', 'skill_mcp_dependency_install', 'tool_suggest'];
  const config = ['forced_login_method="chatgpt"', 'model_provider="openai"',
    'web_search="disabled"', 'mcp_servers={}', 'project_doc_max_bytes=0',
    'skills.include_instructions=false', 'features.skip_host_skill_discovery=true',
    'suppress_unstable_features_warning=true',
    'memories.generate_memories=false', 'memories.use_memories=false',
    'check_for_update_on_startup=false', 'shell_environment_policy.inherit="none"',
    'model_reasoning_effort="low"',
    `log_dir=${JSON.stringify(cwd)}`, `sqlite_home=${JSON.stringify(cwd)}`];
  return ['--no-daemon', '-a', 'never', 'exec', '--strict-config', '--ignore-user-config', '--ignore-rules',
    '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--json', '--color', 'never',
    '-C', cwd, '--output-schema', path.join(cwd, 'answer.schema.json'),
    ...disabled.flatMap(name => ['--disable', name]), ...config.flatMap(value => ['-c', value]), '-'];
}

// One owned child, bounded streams, no shell, no retry. Resolve only after close;
// abort never releases the transport's busy latch while native work is alive.
export function runCodexProcess(executable, argv, {cwd, env, signal, input = '',
  onEvent = null, timeoutMs = LIMITS.timeoutMs} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(error('CANCELLED'));
    const child = spawn(executable, argv, {cwd, env, shell: false, detached: true,
      stdio: ['pipe', 'pipe', 'pipe']});
    let failure; let timer; let forceTimer; let bytes = 0; let pending = '';
    let stdout = ''; let stderr = '';
    const stop = cause => {
      failure ??= typeof cause === 'string' ? error(cause) : Object.assign(error('INVALID_NATIVE_OUTPUT'),
        cause?.nativeFailure ? {nativeFailure: cause.nativeFailure} : {});
      // Signal errors must not discard the process receipt (the prior Claude defect).
      const kill = signal => {
        try { process.kill(-child.pid, signal); }
        catch { try { child.kill(signal); } catch { /* close still owns settlement */ } }
      };
      kill('SIGTERM');
      forceTimer ??= setTimeout(() => kill('SIGKILL'), 200);
    };
    const abort = () => stop('CANCELLED');
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    timer = setTimeout(() => stop('TIMED_OUT'), timeoutMs);
    child.on('error', () => { failure ??= error('RUNTIME_UNAVAILABLE'); });
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 131072) return stop('OUTPUT_LIMIT');
      if (!onEvent) { stdout += chunk; return; }
      pending += chunk;
      let index;
      while ((index = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        if (line.trim() && !failure) {
          try { onEvent(JSON.parse(line)); } catch (cause) { stop(cause); }
        }
      }
    });
    child.stderr.on('data', chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 131072) return stop('OUTPUT_LIMIT');
      // Only status probes need text; model stderr and traces are discarded.
      if (!onEvent) stderr += chunk;
    });
    child.on('close', (exitCode, exitSignal) => {
      clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', abort);
      if (onEvent && pending.trim() && !failure) {
        try { onEvent(JSON.parse(pending)); } catch (cause) {
          failure = Object.assign(error('INVALID_NATIVE_OUTPUT'), cause?.nativeFailure ? {nativeFailure: cause.nativeFailure} : {});
        }
      }
      if (failure) { failure.process = {pid: child.pid, exitCode, signal: exitSignal}; reject(failure); }
      else resolve({pid: child.pid, exitCode, signal: exitSignal, stdout, stderr});
    });
    child.stdin.end(input);
  });
}

export function codexAnswerStream(privateText = '') {
  let answer = null; let complete = false;
  return {
    consume(event) {
      if (event.type === 'turn.failed' || event.type === 'error') throw Object.assign(error('NATIVE_ERROR'),
        {nativeFailure: sanitizeNativeFailure(event, privateText)});
      if (event.type === 'turn.completed') { complete = true; return; }
      if (event.type === 'thread.started' || event.type === 'turn.started') return;
      if (!['item.started', 'item.updated', 'item.completed'].includes(event.type)) throw error('NATIVE_EVENT');
      const item = event.item;
      if (item?.type === 'error') throw Object.assign(error('NATIVE_ERROR'),
        {nativeFailure: sanitizeNativeFailure(item, privateText)});
      if (item?.type === 'reasoning') return; // Discard immediately; never store or expose.
      if (item?.type === 'todo_list') return; // In-memory planning is not a product effect.
      if (item?.type === 'agent_message') {
        if (event.type !== 'item.completed') return;
        if (typeof item.text !== 'string' || Buffer.byteLength(item.text) > 12000) throw error('ANSWER_LIMIT');
        // Commentary is not an answer. Final output must satisfy the existing contract.
        if (item.phase === 'commentary') return;
        if (answer !== null) throw error('MULTIPLE_ANSWERS');
        answer = validateModelAnswer(JSON.parse(item.text));
        return;
      }
      // Defense in depth only: native read-only sandbox/settings prevent effects.
      // Do not accept a run that unexpectedly attempted implementation or egress.
      throw error('UNEXPECTED_NATIVE_ACTION');
    },
    finish() { if (!complete || answer === null) throw error('INCOMPLETE_ANSWER'); return answer; },
  };
}

export function createCodexTransport({execute = runCodexProcess, executable = 'codex', env = process.env} = {}) {
  let busy = false;
  return Object.freeze({runtimeId: 'codex', async complete(request, {signal} = {}) {
    if (busy) throw error('NATIVE_BUSY');
    busy = true;
    let cwd;
    try {
      const nativeEnv = codexEnvironment(env);
      if (!nativeEnv.HOME) throw error('NATIVE_HOME_REQUIRED');
      cwd = await mkdtemp(path.join(tmpdir(), 'redwood-advisor-'));
      const probe = argv => execute(executable, argv, {cwd, env: nativeEnv, signal, timeoutMs: 5000});
      const version = await probe(['--version']);
      if (version.exitCode !== 0 || version.stdout.trim() !== CODEX_VERSION) throw error('NATIVE_VERSION_UNQUALIFIED');
      const auth = parseAuthStatus('codex', await probe(['login', 'status']));
      if (auth.status !== 'AUTHENTICATED' || auth.mode !== 'ACCOUNT') throw error('NATIVE_ACCOUNT_REQUIRED');
      if (request.runtimeId !== 'codex' || Buffer.byteLength(JSON.stringify(request.context)) > LIMITS.contextBytes
          || !Array.isArray(request.context.knowledge) || request.context.knowledge.length > 3) throw error('CONTEXT_LIMIT');
      await writeFile(path.join(cwd, 'answer.schema.json'), JSON.stringify(schema), {mode: 0o600, flag: 'wx'});
      const input = request.system + '\n\nUse only this supplied support context; do not inspect a repository or execute a repair.\n' + JSON.stringify(request.context);
      const stream = codexAnswerStream(input + '\n' + request.context.question + '\n' + request.context.knowledge.map(d => d.body).join('\n'));
      const result = await execute(executable, codexArguments(cwd), {cwd, env: nativeEnv, signal,
        input,
        onEvent: event => stream.consume(event)});
      if (result.exitCode !== 0) throw error('NATIVE_FAILED');
      return stream.finish();
    } finally {
      try { if (cwd) await rm(cwd, {recursive: true, force: true}); }
      finally { busy = false; }
    }
  }});
}
