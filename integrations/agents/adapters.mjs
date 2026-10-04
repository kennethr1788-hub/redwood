import path from 'node:path';
import { freeze, requireValue, jsonData, shape, oneOf, list, validateWorkspace, taskPacket } from './contract.mjs';

export const AUTH_MODES = freeze(['ACCOUNT', 'API', 'SERVICE', 'UNKNOWN']);
export const AUTH_STATES = freeze(['AUTHENTICATED', 'UNAUTHENTICATED', 'UNKNOWN']);
const manifests = [
  ['codex', 'OpenAI Codex CLI', ['codex'], ['login', 'status'], ['AGENTS.md', 'AGENTS.override.md'], ['ACCOUNT', 'API']],
  ['claude', 'Anthropic Claude Code', ['claude', 'claude.exe'], ['auth', 'status'], ['CLAUDE.md', '.claude/rules/', 'AGENTS.md (version dependent)'], ['ACCOUNT', 'API']],
  ['cursor', 'Cursor Agent CLI', ['agent', 'cursor-agent'], ['status'], ['AGENTS.md', 'CLAUDE.md', '.cursor/rules/'], ['ACCOUNT', 'API']],
  ['gemini', 'Google Gemini CLI', ['gemini'], null, ['GEMINI.md'], ['API', 'SERVICE']],
  ['manual', 'Manual / Generic handoff', [], null, [], []],
];
export const ADAPTERS = freeze(Object.fromEntries(manifests.map(([id, displayName, binaryNames, authArgv, rulesFiles, headlessModes]) => [id, {
  id, displayName, binaryNames, versionArgv: id === 'manual' ? null : ['--version'], authArgv, rulesFiles,
  capabilities: {
    declaration: 'DOCUMENTED_NOT_RUNTIME_VERIFIED',
    interactive: id !== 'manual', localRead: id !== 'manual', localEdit: id !== 'manual', localShell: id !== 'manual',
    headlessModes, nativeApprovals: id !== 'manual', manualHandoff: true,
    headlessPolicy: id === 'codex' ? 'READ_ONLY' : id === 'cursor' ? 'PROPOSE_ONLY' : 'NATIVE_PERMISSIONS',
  },
}])));
export function adapter(id) {
  requireValue(typeof id === 'string' && Object.hasOwn(ADAPTERS, id), 'UNKNOWN_ADAPTER');
  return ADAPTERS[id];
}
function executableFor(id, executable) {
  const a = adapter(id);
  validateWorkspace(executable);
  requireValue(a.binaryNames.includes(path.posix.basename(executable)), 'CLIENT_BINARY_NAME_MISMATCH');
  // A name/version is not provenance. The integration owner must identify the official installation.
  return executable;
}
function command(id, executable, cwd, argv) {
  return { executable: executableFor(id, executable), argv, cwd: validateWorkspace(cwd), shell: false };
}
export function versionProbe(id, input) {
  const a = adapter(id);
  if (!a.versionArgv) return null;
  const o = jsonData(input); shape(o, ['executable', 'workspace']);
  return freeze(command(id, o.executable, o.workspace, [...a.versionArgv]));
}
export function authStatusProbe(id, input) {
  const a = adapter(id);
  if (!a.authArgv) return null;
  const o = jsonData(input); shape(o, ['executable', 'workspace']);
  return freeze(command(id, o.executable, o.workspace, [...a.authArgv]));
}
export function validateAuth(input) {
  const a = jsonData(input); shape(a, ['status', 'mode']);
  oneOf(a.status, AUTH_STATES); oneOf(a.mode, AUTH_MODES);
  requireValue(a.status === 'AUTHENTICATED' || a.mode === 'UNKNOWN', 'AUTH_STATE_CONFLICT');
  return freeze(a);
}

// Projection only. No raw output, email, account identifier, endpoint, or credential survives.
export function parseAuthStatus(id, output) {
  adapter(id);
  const unknown = () => freeze({ status: 'UNKNOWN', mode: 'UNKNOWN' });
  if (!output || !Number.isInteger(output.exitCode) || ![0, 1].includes(output.exitCode)) return unknown();
  const stdout = output.stdout ?? ''; const stderr = output.stderr ?? '';
  if (![stdout, stderr].every(s => typeof s === 'string' && s.length <= 8192 && !/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(s))) return unknown();
  // Do not strip ANSI into a possibly misleading success phrase.
  if ((stdout + stderr).includes('\x1b')) return unknown();
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
  if (id === 'claude') {
    if (stderr.trim()) return unknown();
    let v; try { v = JSON.parse(stdout); } catch { return unknown(); }
    if (!v || Array.isArray(v) || typeof v !== 'object') return unknown();
    if (output.exitCode === 1 && v.loggedIn === false && v.authMethod === 'none') return freeze({ status: 'UNAUTHENTICATED', mode: 'UNKNOWN' });
    if (output.exitCode !== 0 || v.loggedIn !== true) return unknown();
    const modes = { 'claude.ai': 'ACCOUNT', api_key: 'API', api_key_helper: 'API', third_party: 'SERVICE' };
    const mode = typeof v.authMethod === 'string' && Object.hasOwn(modes, v.authMethod) ? modes[v.authMethod] : undefined;
    return freeze({ status: 'AUTHENTICATED', mode: mode ?? 'UNKNOWN' });
  }
  if (id === 'codex') {
    if (output.exitCode === 1 && combined === 'Not logged in') return freeze({ status: 'UNAUTHENTICATED', mode: 'UNKNOWN' });
    if (output.exitCode !== 0) return unknown();
    if (combined === 'Logged in using ChatGPT') return freeze({ status: 'AUTHENTICATED', mode: 'ACCOUNT' });
    if (/^Logged in using an API key(?: - [^\r\n]+)?$/.test(combined)) return freeze({ status: 'AUTHENTICATED', mode: 'API' });
  }
  // Cursor human output documents sign-in, not a stable billing-mode schema. Fail closed.
  // Gemini has no qualified machine auth-status command in this revision.
  return unknown();
}

const billingKeys = {
  codex: /^(?:OPENAI_|CODEX_(?:API_KEY|ACCESS_TOKEN|HOME))/,
  claude: /^(?:ANTHROPIC_|CLAUDE_CODE_(?:OAUTH_TOKEN|USE_|API_KEY)|CLAUDE_CONFIG_DIR|AWS_|GOOGLE_)/,
  cursor: /^(?:CURSOR_(?:API_|AGENT)|AGENT_CLI_|AWS_)/,
  gemini: /^(?:GEMINI_|GOOGLE_|GCLOUD_|CLOUDSDK_)/,
};

/** Returns a description, never execution authority. It does not inspect env/config or spawn. */
export function launchPlan(id, input, task) {
  adapter(id);
  const o = jsonData(input);
  if (id === 'manual') {
    shape(o, []);
    return freeze({ kind: 'MANUAL_HANDOFF', adapterId: id, executionAuthorized: false, packet: taskPacket(task) });
  }
  shape(o, ['executable', 'mode', 'auth', 'environmentKeys']);
  oneOf(o.mode, ['ACCOUNT', 'API', 'SERVICE']);
  requireValue(o.mode !== 'SERVICE' || id === 'gemini', 'AUTH_MODE_NOT_QUALIFIED');
  const auth = validateAuth(o.auth);
  list(o.environmentKeys, k => requireValue(typeof k === 'string' && /^[A-Z_][A-Z0-9_]{0,100}$/.test(k), 'ENVIRONMENT_NAMES_ONLY'), 0, 256);
  if (o.mode === 'ACCOUNT') requireValue(!o.environmentKeys.some(k => billingKeys[id].test(k)), 'BILLING_OVERRIDE_REQUIRES_RECONCILIATION');
  requireValue(auth.mode === 'UNKNOWN' || auth.mode === o.mode, 'AUTH_MODE_MISMATCH');
  const packet = taskPacket(task);
  return freeze({ kind: 'INTERACTIVE_HANDOFF', adapterId: id, ...command(id, o.executable, task.workspace, []),
    requiresTTY: true, executionAuthorized: false, requestedAuthMode: o.mode, observedAuth: auth,
    billing: o.mode === 'ACCOUNT' ? 'PROVIDER_ACCOUNT_LIMITS_NOT_VERIFIED' : 'EXPLICIT_API_OR_SERVICE_USAGE_BILLING',
    packet, taskSubmittedByLaunch: false,
    requiredBeforeExecution: ['IDENTIFY_OFFICIAL_BINARY', 'RECHECK_LOCAL_PATHS', 'REVIEW_NATIVE_AUTH_CONFIG_AND_ENVIRONMENT', 'USER_AUTHORIZATION'],
  });
}

export function headlessPlan(id, input, task) {
  const a = adapter(id);
  requireValue(id !== 'manual', 'MANUAL_HAS_NO_EXECUTION');
  const plan = launchPlan(id, input, task);
  requireValue(a.capabilities.headlessModes.includes(plan.requestedAuthMode), 'HEADLESS_AUTH_NOT_QUALIFIED');
  requireValue(plan.observedAuth.status === 'AUTHENTICATED' && plan.observedAuth.mode === plan.requestedAuthMode, 'HEADLESS_AUTH_UNKNOWN');
  const prompt = plan.packet.markdown;
  const argv = {
    codex: ['exec', '--sandbox', 'read-only', '--json', '--', prompt],
    claude: ['-p', '--output-format', 'json', '--permission-mode', 'default', prompt],
    cursor: ['-p', '--output-format', 'json', prompt],
    gemini: ['--prompt', prompt, '--output-format', 'json', '--approval-mode', 'default'],
  }[id];
  return freeze({ ...plan, kind: 'HEADLESS_COMMAND_DESCRIPTION', argv, requiresTTY: false,
    taskSubmittedByLaunch: true, effectivePermissions: a.capabilities.headlessPolicy,
    requiredBeforeExecution: [...plan.requiredBeforeExecution, 'REPROBE_AUTH_IN_EXACT_CHILD_ENVIRONMENT', 'BOUND_TIME_OUTPUT_AND_PROCESS_OWNERSHIP'],
  });
}

export function parseVersion(id, output) {
  adapter(id);
  if (!output || output.exitCode !== 0 || typeof output.stdout !== 'string' || output.stdout.length > 200) return null;
  const stderr = output.stderr ?? '';
  if (typeof stderr !== 'string' || stderr.trim()) return null;
  const patterns = {
    codex: /^codex-cli (\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/,
    claude: /^(\d+\.\d+\.\d+) \(Claude Code\)$/,
    cursor: /^(\d{4}\.\d{2}\.\d{2}-[a-f0-9]+)$/,
    gemini: /^(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/,
  };
  return patterns[id]?.exec(output.stdout.trim())?.[1] ?? null;
}
