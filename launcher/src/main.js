import "./styles.css";
import {initializeAdvisor, mediaSummary} from "./advisor.js";
import {DISPLAY_NAMES as names} from "./display-names.js";
import {initializeShell, updateShellContext, shellContextVersion, shellShowsProjects} from "./shell.js";

initializeShell();
initializeAdvisor(api);

const status = document.querySelector("#copy-status");

/** @param {string} message */
function announce(message) {
  if (!status) return;
  status.textContent = "";
  window.requestAnimationFrame(() => {
    status.textContent = message;
  });
}

/** @param {string} id */
async function copyCommand(id) {
  const code = document.querySelector(`#${id} code`);
  if (!code) return;
  const text = code.textContent.replace(/\s+$/, "");
  try {
    await navigator.clipboard.writeText(text);
    announce("Copied the start command. This page does not run it.");
  } catch {
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    announce("Clipboard unavailable. The command is selected so you can copy it.");
  }
}

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", () => {
    const id = button.getAttribute("data-copy");
    if (id) copyCommand(id);
  });
});

const form = document.querySelector('form');
const setupResult = document.querySelector('#setup-result');
const recentResult = document.querySelector('#recent-projects');
const resumeResult = document.querySelector('#resume-result');
/** @type {Record<string, string> | null} */
let targets = null;
/** @template {keyof HTMLElementTagNameMap} T @param {T} tag @param {string} text */
const element = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };
/** @param {string} route @param {Record<string, unknown>} [data] */
async function api(route, data) {
  const response = await fetch('/api/' + route, {method: data ? 'POST' : 'GET', headers: {'X-LaunchForge': '1', ...(data ? {'Content-Type': 'application/json'} : {})}, ...(data ? {body: JSON.stringify(data)} : {})});
  const value = await response.json();
  if (!response.ok) throw Error(value.error || 'Current state is unavailable.');
  return value;
}
/** @param {import('./types').Doctor} doctor */
function doctorRows(doctor) {
  document.querySelector('#media-summary').textContent = mediaSummary(doctor);
  const container = document.querySelector('#doctor-rows'); container.replaceChildren();
  const roles = {codex: 'Primary · coding and ' + names.advisor, higgsfield: 'Optional · media', elevenlabs: 'Not required · competition scope excludes ElevenLabs'};
  const order = {codex: 0, higgsfield: 1, elevenlabs: 3};
  for (const row of [...doctor.rows].sort((a, b) => (order[a.connectorId] ?? 2) - (order[b.connectorId] ?? 2))) {
    const block = element('details', ''); block.className = 'connection-row';
    const summary = element('summary', '');
    const billingText = !row.billingMode || row.billingMode === 'UNKNOWN' ? 'Unknown — review in the native client' : row.billingLabel;
    const billing = element('span', 'Billing: ' + billingText); billing.className = 'billing';
    summary.append(element('strong', row.displayName), element('span', roles[row.connectorId] || 'Optional · coding-tool handoff'), element('span', 'Evidence: ' + row.status), billing);
    const details = element('dl', '');
    const state = value => value === true ? 'YES' : value === false ? 'NO' : 'UNKNOWN';
    for (const [label, value] of [
      ['Installed / detected', state(row.detected)], ['Authenticated', state(row.authenticated)],
      ['Capability verification', row.capabilityStates.map(c => c.capability + ': ' + c.state).join(', ')],
      ['Checked mode / scope', [row.mode || 'UNKNOWN', row.qualificationScope || 'No recorded scope'].join(' / ')],
      ['Freshness / last checked', [row.freshness || 'UNKNOWN', row.lastCheckedAt || 'Not checked'].join(' / ')],
      ['Authorized actions', 'NONE granted by this shell'], ['Billing mode', billingText],
    ]) details.append(element('dt', label), element('dd', value));
    block.append(summary, details); container.append(block);
  }
}
async function statusCheck() {
  const value = await api('status'); targets = value.targets; doctorRows(value.doctor);
  for (const [product, url] of Object.entries(targets)) {
    const link = document.querySelector(`#${product} .address a`); /** @type {HTMLAnchorElement} */ (link).href = url; link.textContent = url;
  }
}
statusCheck().catch(() => { document.querySelector('#doctor-rows').textContent = 'Connections unavailable. Compile the launcher, then run npm start. Product start commands remain available in the product navigation.'; });
let setupRevision = 0;
function invalidateSetup() { setupRevision++; setupResult.replaceChildren(); }
form.addEventListener('input', invalidateSetup);
form.addEventListener('change', invalidateSetup);
form.addEventListener('submit', async event => {
  const revision = ++setupRevision;
  event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
  setupResult.replaceChildren(element('p', 'Checking the local product…'));
  try {
    const input = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, String(value)]));
    for (const key of ['projectName', 'desiredOutcome', 'audience']) input[key] = input[key].replace(/\s+/gu, ' ').trim();
    if (!input.audience) delete input.audience;
    const {setup, target, doctor} = await api('setup', input);
    if (revision !== setupRevision) return;
    doctorRows(doctor);
    const coreReady = setup.doctor.checks.some(check => check.id === setup.product + '-entry' && check.scope === 'CORE' && check.status === 'VERIFIED');
    const entry = element('p', 'Local ' + names[setup.product] + ' entry: ' + (coreReady ? 'ready.' : 'needs setup.')); entry.dataset.testid = 'entry-state';
    const state = element('strong', setup.readiness.state); state.dataset.testid = 'setup-state';
    const evidence = element('p', 'Setup evidence: '); evidence.append(state); setupResult.replaceChildren(entry, evidence);
    for (const check of setup.doctor.checks) setupResult.append(element('p', check.summary));
    setupResult.append(element('p', 'Optional connectors selected: 0. ' + mediaSummary(doctor)));
    if (coreReady) {
      const context = {startingPoint: setup.startingPoint, projectName: setup.projectName, desiredOutcome: setup.desiredOutcome, selectedAgentAdapterId: setup.selectedAgentAdapterId};
      if (setup.audience) context.audience = setup.audience;
      const link = element('a', 'Continue to ' + names[setup.product] + (setup.selectedAgentAdapterId === 'manual' ? '' : ' — native-client handoff')); link.className = 'continue';
      link.href = setup.product === 'build' ? target + '/#setup=' + encodeURIComponent(JSON.stringify(context)) : target;
      link.rel = 'noreferrer'; setupResult.append(link);
      if (setup.selectedAgentAdapterId !== 'manual') setupResult.append(element('p', 'Continue into the local product with your selected coding tool. Review the prepared task in its native client; authentication and billing have not been checked here. Opening the product does not launch or authorize the agent. Manual copy/paste handoff remains available.'));
      if (setup.product !== 'build') {
        setupResult.append(element('p', 'Open the product and paste this context into its existing intake. Setup does not create or change its project.'));
        const details = element('details', ''); details.append(element('summary', 'Review context to copy'), element('pre', JSON.stringify(context, null, 2))); setupResult.append(details);
      }
    }
    if (setup.selectedAgentAdapterId !== 'manual') {
      const fallback = element('button', 'Use manual handoff instead'); fallback.type = 'button';
      fallback.addEventListener('click', () => { /** @type {HTMLSelectElement} */ (form.elements.namedItem('selectedAgentAdapterId')).value = 'manual'; form.requestSubmit(); }); setupResult.append(fallback);
    }
  } catch (error) { if (revision === setupRevision) setupResult.replaceChildren(element('p', error.message)); }
  finally { button.disabled = false; }
});
// No source paths, credentials, readiness or completion claims are cached here.
function pointers() {
  try {
    const text = localStorage.getItem('launchforge-recent-v1'); if (!text || text.length > 8192) return [];
    const value = JSON.parse(text);
    if (value.schemaVersion !== 1 || !Array.isArray(value.projects) || value.projects.length > 16) return [];
    return value.projects.filter(p => p && Object.keys(p).length === 2 && p.product === 'build' && typeof p.id === 'string' && /^[a-z0-9][a-z0-9-]{0,59}$/.test(p.id));
  } catch { return []; }
}
/** @param {string} id */
function remember(id) {
  try { localStorage.setItem('launchforge-recent-v1', JSON.stringify({schemaVersion: 1, projects: [{product: 'build', id}, ...pointers().filter(p => p.id !== id)].slice(0, 16)})); } catch { /* Navigation remains usable with storage disabled. */ }
}
let resumeRevision = 0;
/** @param {string} id */
async function reopen(id) {
  const revision = ++resumeRevision;
  const contextVersion = shellContextVersion();
  resumeResult.replaceChildren(element('p', 'Reading current project state…'));
  updateShellContext(names.build, 'Reading current project state…');
  try {
    if (!targets) await statusCheck();
    const record = await api('build-resume/' + id);
    if (revision !== resumeRevision) return;
    remember(id);
    if (contextVersion === shellContextVersion()) window.dispatchEvent(new CustomEvent('selected-work', {detail: {product: 'build', projectId: id}}));
    if (contextVersion === shellContextVersion()) updateShellContext(names.build + ' · ' + record.projectName, record.nextRecommendedAction.summary);
    const title = element('h3', record.projectName); const state = element('strong', record.completionState); state.dataset.testid = 'recent-state';
    resumeResult.replaceChildren(title, state, element('p', record.nextRecommendedAction.summary));
    for (const issue of record.unresolvedItems) resumeResult.append(element('p', issue.summary));
    const link = element('a', 'Open current ' + names.build + ' project'); link.className = 'continue'; link.href = targets.build + '/project/' + id; link.rel = 'noreferrer'; resumeResult.append(link);
  } catch (error) { if (revision !== resumeRevision) return; resumeResult.replaceChildren(element('p', error.message + ' No cached completion is shown.')); if (contextVersion === shellContextVersion()) updateShellContext(names.build, 'Current state unavailable. Start the product and read it again.'); }
}
let listRevision = 0;
async function listProjects() {
  const revision = ++listRevision; resumeRevision++;
  if (shellShowsProjects()) updateShellContext(names.build, 'Choose a project from the current owner list, or start with what you have.');
  recentResult.replaceChildren(element('p', 'Reading ' + names.build + '…')); resumeResult.replaceChildren();
  try {
    const projects = await api('build-projects');
    if (revision !== listRevision) return;
    const saved = pointers();
    projects.sort((a, b) => Number(saved.some(p => p.id === b.id)) - Number(saved.some(p => p.id === a.id)));
    const list = element('ul', ''); list.className = 'recent-list';
    for (const project of projects) {
      const item = element('li', ''); const button = element('button', 'Resume ' + project.name); button.type = 'button'; button.addEventListener('click', () => void reopen(project.id)); item.append(button); list.append(item);
    }
    recentResult.replaceChildren(projects.length ? list : element('p', 'No ' + names.build + ' projects yet. Use setup to start your first project.'));
  } catch (error) { if (revision !== listRevision) return; recentResult.replaceChildren(element('p', error.message)); }
}
document.querySelector('#refresh-projects').addEventListener('click', () => void listProjects());
if (pointers().length) void listProjects();
