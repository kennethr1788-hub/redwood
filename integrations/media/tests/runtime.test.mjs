import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended;
}

test('running launcher API uses integrated doctor; zero-connector Studio/Grow setup and restart need no media account', {timeout: 20000}, async t => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'media-runtime-'));
  // Labeled owner-list fixtures test setup routing only. Real product suites run
  // separately; these fixtures do not assert media or product completion.
  const owner = http.createServer((req, res) => {
    assert.equal(req.url, '/api/projects');
    res.writeHead(200, {'Content-Type': 'application/json'}); res.end('[]');
  });
  const ownerPort = await listen(owner);
  const reservation = http.createServer(); const port = await listen(reservation); await close(reservation);
  const origin = `http://127.0.0.1:${port}`;
  let child, stderr = '';
  t.after(async () => { await stop(child); await close(owner); await fs.rm(work, {recursive: true, force: true}); });
  async function api(route, body) {
    const response = await fetch(origin + '/api/' + route, {method: body ? 'POST' : 'GET',
      headers: {'X-LaunchForge': '1', 'Content-Type': 'application/json'},
      ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(2000)});
    assert.equal(response.status, 200); return response.json();
  }
  async function start() {
    child = spawn(process.execPath, ['launcher/server.mjs'], {cwd: root, stdio: ['ignore', 'ignore', 'pipe'],
      env: {...process.env, LF_LAUNCHER_PORT: String(port), LF_BUILD_PORT: String(ownerPort),
        LF_STUDIO_PORT: String(ownerPort), LF_GROW_PORT: String(ownerPort), LF_CONNECTIONS_DIR: path.join(work, 'connections')}});
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-2000); });
    let last;
    for (let i = 0; i < 60; i++) {
      assert.equal(child.exitCode, null, stderr);
      try { return await api('status'); } catch (error) { last = error; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw last;
  }
  const before = await start();
  function checkDoctor(doctor) {
    assert.equal(doctor.mediaIntegration, 'OFFLINE_QUALIFIED');
    assert.equal(doctor.providerRuntimeQualification, 'NOT_RUN');
    assert.equal(doctor.selectionStatus, 'NO_CONNECTOR_REQUIREMENTS');
    assert.equal(doctor.baseline, 'UNAFFECTED_BY_CONNECTORS');
    assert.equal(doctor.productCompletion, 'NOT_ASSESSED');
    const media = doctor.rows.filter(r => ['higgsfield', 'elevenlabs'].includes(r.connectorId));
    assert.equal(media.length, 2);
    assert.deepEqual(media.find(r => r.connectorId === 'higgsfield').capabilityStates,
      [{capability: 'VIDEO_GENERATION', state: 'UNKNOWN'}]);
    for (const row of media) {
      assert.equal(row.status, 'UNKNOWN'); assert.equal(row.authenticated, null);
      assert.equal(row.actionAuthorization, 'NOT_GRANTED');
    }
  }
  checkDoctor(before.doctor);
  const context = {projectName: 'Media integration fixture', desiredOutcome: 'Review existing local product work.', selectedAgentAdapterId: 'manual'};
  for (const [startingPoint, product] of [['APP_OR_RECORDING', 'studio'], ['GROW_INPUTS', 'grow']]) {
    const result = await api('setup', {...context, startingPoint});
    assert.equal(result.setup.product, product); assert.equal(result.setup.readiness.state, 'READY');
    assert.deepEqual(result.setup.connectors, []); checkDoctor(result.doctor);
  }
  const unobserved = await api('setup', {...context, startingPoint: 'APP_OR_RECORDING', selectedAgentAdapterId: 'codex'});
  assert.equal(unobserved.setup.readiness.state, 'UNKNOWN');
  await stop(child);
  const after = await start(); checkDoctor(after.doctor);
  assert.deepEqual(after.doctor.rows, before.doctor.rows);
  await close(owner);
  const offline = await api('setup', {...context, startingPoint: 'APP_OR_RECORDING'});
  assert.equal(offline.setup.readiness.state, 'NEEDS_SETUP'); checkDoctor(offline.doctor);
});
