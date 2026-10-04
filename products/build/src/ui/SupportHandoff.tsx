import React, {useState} from 'react';
import type {Detail} from '../core/types';
import {api} from './api';

type Prepared = {notice: string; selectedAdapterId: string; qualification: string; auth: string; execution: string;
  plan: {kind: string; executable?: string; argv?: string[]; cwd?: string; shell?: false; packet: {json: string; markdown: string; sha256: string}}};
export function SupportHandoff({detail, unsaved}: {detail: Detail; unsaved: boolean}) {
  const [reviewed, setReviewed] = useState(false);
  const [executable, setExecutable] = useState('');
  const [mode, setMode] = useState('ACCOUNT');
  const [result, setResult] = useState<Prepared | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  async function prepare() {
    setPending(true); setError(''); setResult(null);
    try { setResult(await api<Prepared>('/projects/' + detail.project.id + '/handoff', {method: 'POST', body: JSON.stringify({reviewed, ...(executable ? {executable, mode} : {})})})); }
    catch (e) { setError((e as Error).message); } finally { setPending(false); }
  }
  return <section className="support-handoff" aria-label="Project resume and agent task">
    <h3>Resume where you left off</h3>
    {detail.resume ? <><strong data-testid="resume-state">{detail.resume.completionState}</strong><p>{detail.resume.nextRecommendedAction.summary}</p>
      {detail.resume.unresolvedItems.map(item => <p key={item.id}>{item.summary}</p>)}</> : <p role="status">{detail.resumeError}</p>}
    <p>Derived from current Build state. Provider results never replace Build verification.</p>
    <h3>Prepare a portable agent task</h3>
    <p>Codex, Claude Code, Cursor Agent, Gemini, or manual copy/paste receive the same task and resume files. Authentication and approvals stay in your official client.</p>
    {detail.project.tool !== 'manual' && <details><summary>Optional interactive launch description</summary>
      <label>Official client absolute executable path<input value={executable} onChange={e => {setExecutable(e.target.value); setResult(null);}} placeholder="Leave empty for manual copy/paste" /></label>
      <label>Requested billing mode<select aria-label="Requested billing mode" value={mode} onChange={e => {setMode(e.target.value); setResult(null);}}><option value="ACCOUNT">Native account — limits unverified</option><option value="API">Explicit API — separate usage billing</option>{detail.project.tool === 'gemini' && <option value="SERVICE">Service — separate usage billing</option>}</select></label>
      <p>Installation, authentication and billing are UNKNOWN. Offline command construction is qualified; live execution is not. Headless launch is unavailable here.</p>
    </details>}
    <label className="trust-control"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} /> I reviewed the brief for sensitive data. Regenerate the derived resume and task files in .launchforge.</label>
    {unsaved && <p id="save-before-handoff">Save brief changes before preparing an agent task.</p>}
    <button className="button primary" type="button" aria-describedby={unsaved ? 'save-before-handoff' : undefined} disabled={unsaved || !reviewed || pending || !!detail.busy} onClick={() => void prepare()}>{pending ? 'Preparing…' : 'Prepare agent task'}</button>
    {error && <p role="alert">{error}</p>}
    {result && reviewed && !unsaved && <div data-testid="prepared-task"><p>{result.notice}</p><p>{result.plan.kind} · Auth {result.auth} · Execution {result.execution}</p>
      {result.plan.executable && <pre>{JSON.stringify({executable: result.plan.executable, argv: result.plan.argv, cwd: result.plan.cwd, shell: false}, null, 2)}</pre>}
      <details open><summary>Review the common task</summary><pre>{result.plan.packet.markdown}</pre></details>
      <button className="button" type="button" onClick={() => navigator.clipboard.writeText(result.plan.packet.markdown).catch(() => setError('Select and copy the task text manually.'))}>Copy reviewed task</button>
      <p>Files: .launchforge/agent-task.json, agent-task.md, resume.json and resume.md. Reprepare after any source or brief change.</p></div>}
  </section>;
}
