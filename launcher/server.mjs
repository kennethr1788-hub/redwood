import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createOnboarding} from '../integrations/onboarding/index.mjs';
import {supportDoctor} from '../integrations/connectors/support-doctor.mjs';
import {readLocalObservations} from '../integrations/connectors/local-observations.mjs';
import {ResumeRecord} from '../integrations/resume/contracts.mjs';
import {advisorProjects, askAdvisor} from './advisor-host.mjs';
import {createCodexTransport} from '../integrations/advisor/codex.mjs';
import {DISPLAY_NAMES} from './src/display-names.js';

const root = fileURLToPath(new URL('./dist/', import.meta.url));
const port = Number(process.env.LF_LAUNCHER_PORT || 4191);
const ports = {build: Number(process.env.LF_BUILD_PORT || 4177), studio: Number(process.env.LF_STUDIO_PORT || 4318), grow: Number(process.env.LF_GROW_PORT || 4383)};
for (const p of [port, ...Object.values(ports)]) if (!Number.isInteger(p) || p < 1024 || p > 65535) throw Error('Ports must be integers from 1024 to 65535.');
const origin = `http://127.0.0.1:${port}`;
const targets = Object.fromEntries(Object.entries(ports).map(([name, value]) => [name, `http://127.0.0.1:${value}`]));
const connectionsDir = path.resolve(process.env.LF_CONNECTIONS_DIR || path.join(fileURLToPath(new URL('./', import.meta.url)), '.local/connections'));
const localDoctor = () => supportDoctor(new Date().toISOString(), readLocalObservations(connectionsDir));
const advisorTransport = createCodexTransport();
async function ownerGet(product, suffix) {
  const response = await fetch(targets[product] + suffix, {headers: {'X-LaunchForge': '1'}, redirect: 'error', signal: AbortSignal.timeout(2000)});
  if (!response.ok) throw Error('Start the selected product, then check again.');
  // Stream-bounded read: a wrong/unrelated loopback listener cannot exhaust memory.
  let length = 0; const chunks = [];
  for await (const chunk of response.body) { length += chunk.length; if (length > 262144) throw Error('Owner response exceeds the bounded contract.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function body(req) {
  let bytes = 0; const chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 8192) throw Error('Setup input too large.'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
function send(res, status, value) { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(value)); }
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 403, {error: 'Use the configured local launcher address.'});
    const url = new URL(req.url, origin);
    if (url.pathname.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      if (req.headers['x-launchforge'] !== '1' || (req.headers.origin && req.headers.origin !== origin) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) return send(res, 403, {error: 'Use the local launcher.'});
      if (req.method === 'GET' && url.pathname === '/api/status') return send(res, 200, {targets, doctor: localDoctor()});
      const advisorList = /^\/api\/advisor-projects\/(build|studio|grow)$/.exec(url.pathname);
      if (req.method === 'GET' && advisorList) return send(res, 200, await advisorProjects(advisorList[1], ownerGet));
      if (req.method === 'POST' && url.pathname === '/api/advisor') {
        const controller = new AbortController();
        const cancel = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', cancel);
        try { return send(res, 200, await askAdvisor(await body(req), ownerGet, localDoctor(),
          {transport: advisorTransport, signal: controller.signal})); }
        finally { res.off('close', cancel); }
      }
      if (req.method === 'GET' && url.pathname === '/api/build-projects') {
        const result = await ownerGet('build', '/api/projects');
        if (!Array.isArray(result.projects) || typeof result.workspace !== 'string') throw Error('Build owner response is not recognized.');
        return send(res, 200, result.projects.slice(0, 32).map(p => {
          if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(p.id) || typeof p.name !== 'string' || p.name.length > 100) throw Error('Invalid project navigation data.');
          return {id: p.id, name: p.name, product: 'build'};
        }));
      }
      const match = /^\/api\/build-resume\/([a-z0-9][a-z0-9-]{0,59})$/.exec(url.pathname);
      if (req.method === 'GET' && match) {
        const record = ResumeRecord.parse(await ownerGet('build', '/api/projects/' + match[1] + '/resume'));
        if (record.projectId !== match[1] || record.product !== 'build') throw Error('Resume identity mismatch.');
        return send(res, 200, record);
      }
      if (req.method === 'POST' && url.pathname === '/api/setup') {
        const input = await body(req);
        const allowed = ['startingPoint', 'projectName', 'desiredOutcome', 'audience', 'selectedAgentAdapterId'];
        if (!input || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) throw Error('Unsupported setup fields.');
        if (!['codex', 'claude', 'cursor', 'gemini', 'manual'].includes(input.selectedAgentAdapterId)) throw Error('Choose a supported adapter.');
        const product = {IDEA: 'build', REPO: 'build', APP_OR_RECORDING: 'studio', GROW_INPUTS: 'grow'}[input.startingPoint];
        if (!product) throw Error('Choose a starting point.');
        if (typeof input.projectName !== 'string' || input.projectName.length > 80 || typeof input.desiredOutcome !== 'string' || (product === 'build' && input.desiredOutcome.trim().length < 10)) throw Error('Context does not meet product intake limits.');
        let core = 'NEEDS_SETUP';
        try {
          const owner = await ownerGet(product, '/api/projects');
          if (product === 'build' ? Array.isArray(owner.projects) && typeof owner.workspace === 'string' : Array.isArray(owner)) core = 'VERIFIED';
        } catch { /* An offline/invalid owner remains NEEDS_SETUP; no cached readiness. */ }
        const setup = createOnboarding({...input, schemaVersion: 1, connectors: [], doctor: {checkedAt: new Date().toISOString(), checks: [
          {id: product + '-entry', scope: 'CORE', status: core, summary: core === 'VERIFIED' ? 'Local product responds; executable trust and action prerequisites remain in that product.' : 'Start this product using its local command, then check again.'},
          {id: input.selectedAgentAdapterId, scope: 'AGENT', status: input.selectedAgentAdapterId === 'manual' ? 'VERIFIED' : 'UNKNOWN', summary: input.selectedAgentAdapterId === 'manual' ? 'Manual handoff needs no provider connection.' : 'Provider runtime and authentication have not been checked. Manual handoff remains available.'},
        ]}});
        return send(res, 200, {setup, target: targets[product], doctor: localDoctor()});
      }
      return send(res, 404, {error: 'Unknown launcher operation.'});
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, {error: 'Read only static content.'});
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
    if (!/^(index\.html|assets\/[a-zA-Z0-9_.-]+)$/.test(relative)) return send(res, 404, {error: 'Not found.'});
    const content = await readFile(path.join(root, relative));
    res.setHeader('Content-Type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.woff2') ? 'font/woff2' : relative.endsWith('.woff') ? 'font/woff' : 'text/html');
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch { send(res, 400, {error: 'Could not complete setup or read current product state. Check inputs and start the owning product; no state was changed.'}); }
});
server.listen(port, '127.0.0.1', () => console.log(`${DISPLAY_NAMES.umbrella} launcher: ${origin}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); server.closeAllConnections(); });
