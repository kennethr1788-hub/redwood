import {DISPLAY_NAMES as names, applyHelpDisplayNames} from './display-names.js';

const storageKey = 'launchforge-advisor-v1';
/** @param {import('./types').Doctor} doctor */
export function mediaSummary(doctor) {
  const media = doctor.rows.filter(row => ['higgsfield','elevenlabs'].includes(row.connectorId));
  const verified = media.filter(row => row.freshness === 'CURRENT' && row.capabilityStates.some(c => c.state === 'VERIFIED'));
  if (verified.length) return 'Optional media capability checked for the recorded scope: ' + verified.map(row =>
    `${row.displayName} (${row.mode || 'unknown mode'}; ${row.qualificationScope || 'recorded local scope'}; checked ${row.lastCheckedAt || 'time unknown'}).`).join(' ') +
    ' Other modes and actions need their own checks and authorization.';
  if (media.some(row => row.freshness === 'STALE_OR_UNBOUND')) return 'Optional media support is available. Prior capability checks are stale or unbound; check the current mode and scope in Connections.';
  return doctor.mediaIntegration === 'OFFLINE_QUALIFIED'
    ? 'Optional media support is available. Account capability has not been checked.'
    : 'Optional media support has not been checked. Local work needs no media connection.';
}
/** @param {(route: string, data?: Record<string, unknown>) => Promise<any>} api */
export function initializeAdvisor(api) {
  const form = /** @type {HTMLFormElement} */ (document.querySelector('#advisor-form'));
  const product = /** @type {HTMLSelectElement} */ (document.querySelector('#advisor-product'));
  const project = /** @type {HTMLSelectElement} */ (document.querySelector('#advisor-project'));
  const runtime = /** @type {HTMLSelectElement} */ (document.querySelector('#advisor-runtime'));
  const question = /** @type {HTMLTextAreaElement} */ (document.querySelector('#advisor-question'));
  const result = document.querySelector('#advisor-result');
  const notice = document.querySelector('#advisor-selection-status');
  let checkpoint = null;
  let version = 0;
  const node = (tag, text) => { const el = document.createElement(tag); el.textContent = text; return el; };
  // Display existing text as a note. Never interpret returned HTML or create links from it.
  function appendAnswer(text) {
    for (const block of text.split(/\n\s*\n/).filter(Boolean)) {
      const lines = block.split('\n');
      if (/^#{1,3} /.test(lines[0])) {
        result.append(node('h4', lines.shift().replace(/^#{1,3} /, '')));
      }
      if (lines.length) {
        const paragraph = node('p', lines.join('\n')); paragraph.className = 'answer-text'; result.append(paragraph);
      }
    }
  }
  function nextAction(text) {
    const section = node('div', ''); section.className = 'answer-next';
    section.append(node('h4', 'Next action'), node('p', text)); result.append(section);
  }
  function showMode(state = 'IDLE') {
    const codex = runtime.value === 'codex';
    const labels = {IDLE: codex ? 'Codex-backed expert selected' : 'Local deterministic help selected',
      LOADING: codex ? 'Asking Codex…' : 'Reading local help…', CODEX: 'Codex-backed answer',
      FALLBACK: 'Local help fallback', HANDOFF: 'Coding-agent prompt prepared'};
    document.querySelector('#advisor-mode').textContent = labels[state];
    document.querySelector('#advisor-nav-mode').textContent = codex ? 'Codex expert' : 'Local fallback';
    document.querySelector('#advisor-host').setAttribute('data-state', state === 'IDLE' ? (codex ? 'CODEX_SELECTED' : 'LOCAL_HELP') : state);
  }
  function clearReply() { version++; result.replaceChildren(); showMode(); }
  function resetProjects() { project.replaceChildren(new Option('General help — no project selected', '')); }
  function restore() {
    try {
      const saved = localStorage.getItem(storageKey);
      if (!saved || new TextEncoder().encode(saved).length > 2048) return;
      const c = JSON.parse(saved);
      if (typeof c.projectId !== 'string' || !['codex','claude',null].includes(c.runtimeId)) return;
      const match = /^(build|studio|grow)\.([a-z0-9][a-z0-9-]{0,59})$/.exec(c.projectId);
      if (!match) return;
      product.value = match[1]; runtime.value = c.runtimeId === 'codex' ? 'codex' : '';
      if (match[2] !== 'workspace') { project.add(new Option('Saved project — state will be read again', match[2])); project.value = match[2]; }
      checkpoint = c.runtimeId === 'claude' ? null : saved;
    } catch { /* Storage is optional; current state is never restored from it. */ }
  }
  resetProjects(); restore(); showMode();
  const initial = window.location.hash.slice(1);
  if (['build','studio','grow'].includes(initial) && initial !== product.value) { product.value = initial; resetProjects(); checkpoint = null; }
  product.addEventListener('change', () => { resetProjects(); clearReply(); notice.textContent = 'Read current projects, or ask for general help.'; });
  project.addEventListener('change', clearReply); runtime.addEventListener('change', clearReply);
  window.addEventListener('selected-work', event => {
    const selection = /** @type {CustomEvent} */ (event).detail;
    if (!['build','studio','grow'].includes(selection.product)) return;
    product.value = selection.product; resetProjects();
    if (selection.projectId) { project.add(new Option('Selected project — state will be read again', selection.projectId)); project.value = selection.projectId; }
    clearReply(); notice.textContent = 'Current state is read from the selected product for each question.';
  });
  document.querySelector('#advisor-read-projects').addEventListener('click', async () => {
    const revision = ++version; const owner = product.value; const previous = project.value;
    result.replaceChildren(); showMode(); notice.textContent = 'Reading current projects…';
    try {
      const projects = await api('advisor-projects/' + owner);
      if (revision !== version || owner !== product.value) return;
      resetProjects();
      for (const item of projects) project.add(new Option(item.name, item.id));
      if (projects.some(p => p.id === previous)) project.value = previous;
      notice.textContent = projects.length ? 'Choose a current project, or ask for general help.' : 'No current projects. General help remains available.';
    } catch { if (revision === version) { resetProjects(); notice.textContent = 'Current projects are unavailable. Start the product; general help remains available.'; } }
  });
  // The host handles only explicit navigation/copy clicks; the leaf cannot execute either.
  form.addEventListener('submit', async event => {
    event.preventDefault(); const revision = ++version;
    const submitter = /** @type {HTMLButtonElement} */ (/** @type {SubmitEvent} */ (event).submitter);
    const buttons = form.querySelectorAll('button[type="submit"]'); buttons.forEach(b => /** @type {HTMLButtonElement} */ (b).disabled = true);
    showMode('LOADING');
    result.replaceChildren(node('p', runtime.value === 'codex' ? 'Reading current state for your Codex-backed ' + names.advisor + '…' : 'Reading current state and local deterministic help…'));
    try {
      const value = await api('advisor', {product: product.value, projectId: project.value || null,
        runtimeId: runtime.value || null, question: question.value, intent: submitter?.value || 'HELP', checkpoint});
      if (revision !== version) return;
      const reply = value.reply;
      showMode(reply.answerSource === 'CODEX' ? 'CODEX' : reply.status === 'HANDOFF_PREPARED' ? 'HANDOFF' : runtime.value === 'codex' ? 'FALLBACK' : 'IDLE');
      checkpoint = value.checkpoint;
      try { if (typeof checkpoint === 'string' && new TextEncoder().encode(checkpoint).length <= 2048) localStorage.setItem(storageKey, checkpoint); } catch { /* Help works without persistence. */ }
      const title = node('h3', names.advisor); result.replaceChildren(title);
      if (reply.currentState) result.append(node('p', names[reply.currentState.product] + ' · Completion: ' + reply.currentState.completionState + ' · Freshness: ' + reply.currentState.freshness));
      else result.append(node('p', 'Current project state has not been supplied. No completion is inferred.'));
      // Answer contracts expose the useful deterministic frame without transport-engine jargon.
      if (reply.answerSource === 'CODEX' || reply.status === 'HANDOFF_PREPARED') {
        appendAnswer(reply.answer);
        nextAction(reply.nextStep);
      } else if (reply.answerContract) {
        const frame = reply.answerContract;
        if (frame.id === 'HIGGSFIELD_SETUP') {
          result.append(node('p', applyHelpDisplayNames(frame.whatFailed.split('. ')[0] + '.')));
          const details = node('details', ''); details.append(node('summary', 'Connection details'));
          for (const text of [frame.whatFailed, frame.whatRemainsValid, frame.nextUserAction]) details.append(node('p', applyHelpDisplayNames(text))); result.append(details);
        } else for (const text of [frame.whatFailed, frame.whatRemainsValid, frame.nextUserAction]) result.append(node('p', applyHelpDisplayNames(text)));
      } else {
        const text = ['BRIDGE_UNAVAILABLE','SETUP_REQUIRED'].includes(reply.status) ? reply.answer.split('\n\n').slice(1).join('\n\n') : reply.answer;
        appendAnswer(applyHelpDisplayNames(text || reply.answer));
        nextAction(applyHelpDisplayNames(reply.nextStep));
      }
      if (reply.codingPrompt) {
        const prompt = node('pre', reply.codingPrompt); prompt.id = 'advisor-prompt';
        const copy = node('button', 'Copy coding-agent prompt'); copy.type = 'button';
        copy.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(prompt.textContent); notice.textContent = 'Prompt copied. Review it in your coding agent; nothing was executed here.'; }
          catch { const range = document.createRange(); range.selectNodeContents(prompt); const s = getSelection(); s?.removeAllRanges(); s?.addRange(range); notice.textContent = 'Select and copy the prompt. Nothing was executed here.'; }
        }); result.append(prompt, copy);
      }
      if (['build','studio','grow','connections'].includes(reply.navigateTo)) {
        const link = node('a', 'Open ' + (names[reply.navigateTo] || 'Connections')); link.href = '#' + reply.navigateTo; result.append(link);
      }
      notice.textContent = reply.answerSource === 'CODEX'
        ? `Codex-backed ${names.advisor} answer. ${names.build} owns implementation; nothing was changed.`
        : `Local ${names.advisor} help. Coding-agent prompts remain available; nothing was executed.`;
    } catch { if (revision === version) { showMode(); result.replaceChildren(node('p', 'Could not read an ' + names.advisor + ' response. Keep the question short, omit private values, and check that the launcher is running.')); } }
    finally { buttons.forEach(b => /** @type {HTMLButtonElement} */ (b).disabled = false); }
  });
}
