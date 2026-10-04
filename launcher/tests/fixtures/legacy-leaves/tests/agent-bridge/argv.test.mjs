import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { headlessPlan } from '../../integrations/agents/adapters.mjs';
import { task, options } from './fixtures.mjs';

test('real argv transport to an inert Node fixture preserves metacharacters without executing them', t => {
  const dir = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
  const root = mkdtempSync(dir + "/.runtime-café's space-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const input = task(); input.workspace = root;
  input.objective = 'Literal $(touch CANARY) and `touch CANARY` ; echo x > CANARY';
  const fixture = fileURLToPath(new URL('./argv-recorder.mjs', import.meta.url));
  for (const id of ['codex', 'claude', 'cursor', 'gemini']) {
    const plan = headlessPlan(id, options(id, 'API'), input);
    // Run only the inert fixture with the constructed argv, never plan.executable.
    const result = spawnSync(process.execPath, [fixture, ...plan.argv], { cwd: plan.cwd, shell: false, env: {}, encoding: 'utf8', timeout: 5000, maxBuffer: 131072 });
    assert.equal(result.status, 0); assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { argv: plan.argv, cwd: plan.cwd });
    assert.equal(existsSync(root + '/CANARY'), false);
  }
});
