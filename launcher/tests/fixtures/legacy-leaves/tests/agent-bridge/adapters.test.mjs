import test from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS, adapter, versionProbe, authStatusProbe, launchPlan, headlessPlan, parseAuthStatus, parseVersion } from '../../integrations/agents/adapters.mjs';
import { BridgeError, taskPacket } from '../../integrations/agents/contract.mjs';
import { task, options } from './fixtures.mjs';

test('registry is bounded and immutable; generic always has an exact manual handoff', () => {
  assert.deepEqual(Object.keys(ADAPTERS), ['codex', 'claude', 'cursor', 'gemini', 'manual']);
  for (const id of ['shell', '__proto__', 'constructor']) assert.throws(() => adapter(id), BridgeError);
  assert.throws(() => { ADAPTERS.codex.authArgv[0] = 'exec'; }, TypeError);
  assert.equal(versionProbe('manual', {}), null); assert.equal(authStatusProbe('manual', {}), null);
  const handoff = launchPlan('manual', {}, task());
  assert.equal(handoff.kind, 'MANUAL_HANDOFF'); assert.equal(handoff.executionAuthorized, false);
  assert.deepEqual(handoff.packet, taskPacket(task())); assert.equal(handoff.executable, undefined);
  assert.throws(() => headlessPlan('manual', {}, task()), BridgeError);
});
for (const id of ['codex', 'claude', 'cursor', 'gemini']) {
  test(`${id} probe and interactive descriptions are deterministic and submit no prompt`, () => {
    const t = task(); const o = options(id); const p = { executable: o.executable, workspace: t.workspace };
    assert.deepEqual(versionProbe(id, p), { executable: o.executable, argv: ['--version'], cwd: t.workspace, shell: false });
    const expected = { codex: ['login', 'status'], claude: ['auth', 'status'], cursor: ['status'], gemini: null }[id];
    assert.deepEqual(authStatusProbe(id, p)?.argv ?? null, expected);
    const a = launchPlan(id, o, t); assert.deepEqual(a, launchPlan(id, o, t));
    assert.deepEqual(a.argv, []); assert.equal(a.shell, false); assert.equal(a.requiresTTY, true);
    assert.equal(a.executionAuthorized, false); assert.equal(a.taskSubmittedByLaunch, false);
    assert.equal(a.packet.sha256, taskPacket(t).sha256);
    assert.equal(a.billing, 'PROVIDER_ACCOUNT_LIMITS_NOT_VERIFIED');
  });
  test(`${id} rejects PATH lookups, shell templates and wrong executable names`, () => {
    for (const executable of [id, `x && ${id}`, '/opt/not-that-client', `/opt/evil;/${id}`, `/opt/../${id}`]) {
      assert.throws(() => versionProbe(id, { executable, workspace: task().workspace }), BridgeError);
    }
  });
  test(`${id} API is explicit and never silently inferred from status`, () => {
    const api = options(id, 'API'); const p = headlessPlan(id, api, task());
    assert.equal(p.billing, 'EXPLICIT_API_OR_SERVICE_USAGE_BILLING');
    assert.equal(p.requestedAuthMode, 'API');
    const wrong = options(id); wrong.auth.mode = 'API';
    assert.throws(() => launchPlan(id, wrong, task()), BridgeError);
  });
}
test('all headless providers receive byte-identical canonical semantics as one argv item', () => {
  const t = task(); t.objective = '--dangerously-bypass-approvals-and-sandbox; $(touch canary)';
  const body = taskPacket(t).markdown;
  for (const id of ['codex', 'claude', 'cursor', 'gemini']) {
    const p = headlessPlan(id, options(id, 'API'), t);
    assert.equal(p.argv.filter(a => a === body).length, 1);
    assert.equal(p.packet.markdown, body); assert.equal(p.cwd, t.workspace); assert.equal(p.shell, false);
    assert.deepEqual(p, headlessPlan(id, options(id, 'API'), t));
    assert.equal(p.argv.some(a => ['--force', '--yolo', '--trust', '--approve-mcps', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-skip-permissions'].includes(a)), false);
  }
  assert.deepEqual(headlessPlan('codex', options('codex'), t).argv.slice(0, -1), ['exec', '--sandbox', 'read-only', '--json', '--']);
  assert.deepEqual(headlessPlan('claude', options('claude'), t).argv.slice(0, -1), ['-p', '--output-format', 'json', '--permission-mode', 'default']);
  assert.deepEqual(headlessPlan('cursor', options('cursor'), t).argv.slice(0, -1), ['-p', '--output-format', 'json']);
  assert.equal(headlessPlan('cursor', options('cursor'), t).effectivePermissions, 'PROPOSE_ONLY');
});
test('Gemini cached-account vendor support does not waive R1 unknown-auth headless gate', () => {
  assert.throws(() => headlessPlan('gemini', options('gemini'), task()), /HEADLESS_AUTH_NOT_QUALIFIED/);
  const unknown = options('gemini', 'API'); unknown.auth = { status: 'UNKNOWN', mode: 'UNKNOWN' };
  assert.throws(() => headlessPlan('gemini', unknown, task()), /HEADLESS_AUTH_UNKNOWN/);
  assert.equal(launchPlan('gemini', options('gemini'), task()).kind, 'INTERACTIVE_HANDOFF');
  assert.equal(headlessPlan('gemini', options('gemini', 'SERVICE'), task()).requestedAuthMode, 'SERVICE');
});
test('unknown/signed-out auth never builds a headless request', () => {
  for (const id of ['codex', 'claude', 'cursor', 'gemini']) for (const status of ['UNKNOWN', 'UNAUTHENTICATED']) {
    const o = options(id, 'API'); o.auth = { status, mode: 'UNKNOWN' };
    assert.throws(() => headlessPlan(id, o, task()), /HEADLESS_AUTH_UNKNOWN/);
  }
});
test('subscription mode rejects billing/routing environment overrides using names alone', () => {
  const keys = { codex: ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'], claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_OAUTH_TOKEN'], cursor: ['CURSOR_API_KEY', 'CURSOR_API_ENDPOINT'], gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI'] };
  for (const [id, names] of Object.entries(keys)) for (const name of names) {
    const o = options(id); o.environmentKeys.push(name);
    assert.throws(() => launchPlan(id, o, task()), /BILLING_OVERRIDE_REQUIRES_RECONCILIATION/);
  }
  const o = options('claude'); o.environmentKeys = ['ANTHROPIC_API_KEY=canary'];
  assert.throws(() => launchPlan('claude', o, task()), /ENVIRONMENT_NAMES_ONLY/);
  o.environmentKeys = []; o.env = { ANTHROPIC_API_KEY: 'canary' };
  assert.throws(() => launchPlan('claude', o, task()), /SCHEMA_FIELDS_REJECTED/);
});
test('Codex auth projection retains category only, including stderr status and API-key output', () => {
  assert.deepEqual(parseAuthStatus('codex', { exitCode: 0, stderr: 'Logged in using ChatGPT\n' }), { status: 'AUTHENTICATED', mode: 'ACCOUNT' });
  const parsed = parseAuthStatus('codex', { exitCode: 0, stdout: 'Logged in using an API key - synthetic-sensitive-value' });
  assert.deepEqual(parsed, { status: 'AUTHENTICATED', mode: 'API' });
  assert.equal(JSON.stringify(parsed).includes('synthetic'), false);
  assert.deepEqual(parseAuthStatus('codex', { exitCode: 1, stderr: 'Not logged in' }), { status: 'UNAUTHENTICATED', mode: 'UNKNOWN' });
});
test('Claude JSON projection discards credential/account/config fields and distinguishes native modes', () => {
  for (const [method, mode] of [['claude.ai', 'ACCOUNT'], ['api_key', 'API'], ['api_key_helper', 'API'], ['third_party', 'SERVICE'], ['oauth_token', 'UNKNOWN'], ['__proto__', 'UNKNOWN']]) {
    const stdout = JSON.stringify({ loggedIn: true, authMethod: method, email: 'synthetic@example.invalid', apiKey: 'canary', configDirectory: '/private/canary' });
    const p = parseAuthStatus('claude', { exitCode: 0, stdout });
    assert.deepEqual(p, { status: 'AUTHENTICATED', mode });
    assert.equal(JSON.stringify(p).includes('canary'), false);
  }
  assert.deepEqual(parseAuthStatus('claude', { exitCode: 1, stdout: '{"loggedIn":false,"authMethod":"none"}' }), { status: 'UNAUTHENTICATED', mode: 'UNKNOWN' });
});
test('conflicting/malformed/oversized/auth failures never become an account pass', () => {
  for (const output of [null, { exitCode: 0, stdout: 'Logged in using ChatGPT\nNot logged in' }, { exitCode: 0, stdout: '\x1b[32mLogged in using ChatGPT' }, { exitCode: 2, stdout: 'Logged in using ChatGPT' }, { exitCode: null }, { exitCode: 0, stdout: 'x'.repeat(8193) }, { exitCode: 0, stdout: 'please log in' }]) {
    assert.deepEqual(parseAuthStatus('codex', output), { status: 'UNKNOWN', mode: 'UNKNOWN' });
  }
  for (const stdout of ['{', 'null', '[]', '{"loggedIn":false,"authMethod":"claude.ai"}', '{"loggedIn":"true","authMethod":"claude.ai"}']) {
    assert.deepEqual(parseAuthStatus('claude', { exitCode: 0, stdout }), { status: 'UNKNOWN', mode: 'UNKNOWN' });
  }
  assert.deepEqual(parseAuthStatus('cursor', { exitCode: 0, stdout: 'Logged in as synthetic@example.invalid' }), { status: 'UNKNOWN', mode: 'UNKNOWN' });
  assert.deepEqual(parseAuthStatus('gemini', { exitCode: 0, stdout: 'authenticated' }), { status: 'UNKNOWN', mode: 'UNKNOWN' });
});
test('version parsers discard everything but qualified version formats', () => {
  for (const [id, output, version] of [['codex', 'codex-cli 0.159.2', '0.159.2'], ['claude', '2.1.126 (Claude Code)', '2.1.126'], ['cursor', '2026.09.02-c22c1a3', '2026.09.02-c22c1a3'], ['gemini', '0.35.0', '0.35.0']]) {
    assert.equal(parseVersion(id, { exitCode: 0, stdout: output + '\n' }), version);
    assert.equal(parseVersion(id, { exitCode: 1, stdout: output }), null);
    assert.equal(parseVersion(id, { exitCode: 0, stdout: output + '\nprivate data' }), null);
    assert.equal(parseVersion(id, { exitCode: 0, stdout: output, stderr: 17 }), null);
  }
});
