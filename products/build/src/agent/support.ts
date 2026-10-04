import {lstat} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Project} from '../core/types';
import {sourceIdentity} from '../core/verification';
import {mapBuildState} from '../../../../integrations/resume/owner-adapters.mjs';
import {deriveResume, serializeResume, renderResumeMarkdown, parseResume, inspectResume, createAgentTaskResumeInput} from '../../../../integrations/resume/index.mjs';
import {readBounded, writeDerived} from '../../../../integrations/resume/files.mjs';
import {launchPlan} from '../../../../integrations/agents/adapters.mjs';
import {validateTask, parseTask, sha256, PROHIBITED_EFFECTS} from '../../../../integrations/agents/contract.mjs';
import {inspectTaskPaths} from '../../../../integrations/agents/local-paths.mjs';

export const prepareSchema = z.object({reviewed: z.literal(true), executable: z.string().max(2048).optional(),
  mode: z.enum(['ACCOUNT', 'API', 'SERVICE']).optional()}).strict();

export async function buildResume(project: Project, folder: string, identity: string | null, openedAt = new Date().toISOString()) {
  const instructions: string[] = [];
  for (const file of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    try { const stat = await lstat(path.join(folder, file)); if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) instructions.push(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const normalized = mapBuildState(project, identity, openedAt, instructions);
  const record = deriveResume(normalized);
  return {normalized, record};
}

export async function prepareHandoff(project: Project, folder: string, raw: unknown) {
  const options = prepareSchema.parse(raw);
  const before = await readBounded(folder, '.launchforge/project.json');
  if (JSON.parse(before.toString()).updatedAt !== project.updatedAt) throw Error('Project changed; reopen before preparing a task.');
  const identity = await sourceIdentity(folder, project.flow);
  const {normalized, record} = await buildResume(project, folder, identity);
  const resumeJson = serializeResume(record);
  const resumeMarkdown = renderResumeMarkdown(record);
  const resumeInput = createAgentTaskResumeInput(record, normalized);
  // User prose is validated as data, never interpolated into a shell command.
  const task = validateTask({schemaVersion: 1, taskId: randomUUID(), product: 'build', action: 'CONTINUE_PROJECT',
    workspace: folder, createdAt: new Date().toISOString(), sourceIdentity: {revision: identity, sha256: identity},
    objective: 'Continue the user project described in the reviewed, hash-bound .launchforge/brief.md. Use the fresh resume to identify the next local action; preserve the full brief and existing instructions.',
    inputs: [{path: '.launchforge/brief.md', sha256: sha256(await readBounded(folder, '.launchforge/brief.md'))},
      {path: resumeInput.path, sha256: sha256(resumeJson)}, {path: '.launchforge/resume.md', sha256: sha256(resumeMarkdown)}],
    preserve: ['Preserve current source, user edits and project instructions.', 'Resume is derived context; inspect the current product state before acting.'],
    acceptance: ['Return to Build and run fresh verification on the resulting source.', project.flow?.outcome ?? 'Define a meaningful critical flow; a starter is not a completed custom application.'],
    allowedEffects: ['READ_WORKSPACE', 'EDIT_WORKSPACE', 'RUN_LOCAL_CHECKS'], prohibitedEffects: PROHIBITED_EFFECTS,
    commands: ['typecheck', 'build', 'test'].map(name => ({argv: ['npm', 'run', name], cwd: '.'})),
    evidencePaths: ['.launchforge/project.json'], expectedReceiptPath: '.launchforge/provider-result.json'});
  const manual = launchPlan('manual', {}, task);
  // No auth evidence is manufactured or accepted from browser input. Headless is unavailable.
  const plan = project.tool !== 'manual' && options.executable ? launchPlan(project.tool, {
    executable: options.executable, mode: options.mode ?? 'ACCOUNT', auth: {status: 'UNKNOWN', mode: 'UNKNOWN'}, environmentKeys: [],
  }, task) : manual;
  // These paths can be replaced only by this explicitly reviewed regeneration operation.
  for (const relative of ['.launchforge/resume.json', '.launchforge/resume.md', '.launchforge/agent-task.json', '.launchforge/agent-task.md']) {
    const {containedFile} = await import('../../../../integrations/resume/files.mjs');
    await containedFile(folder, relative, true);
  }
  if (await sourceIdentity(folder, project.flow) !== identity || !before.equals(await readBounded(folder, '.launchforge/project.json'))) throw Error('Project changed; regenerate the handoff.');
  await writeDerived(folder, '.launchforge/resume.json', resumeJson);
  await writeDerived(folder, '.launchforge/resume.md', resumeMarkdown);
  inspectTaskPaths(task);
  for (const input of task.inputs) if (sha256(await readBounded(folder, input.path)) !== input.sha256) throw Error('Handoff input changed.');
  for (const file of plan.packet.files) await writeDerived(folder, file.path, file.content);
  if (inspectResume(parseResume((await readBounded(folder, '.launchforge/resume.json')).toString()), normalized).status !== 'CURRENT') throw Error('Resume readback mismatch.');
  const readback = parseTask((await readBounded(folder, '.launchforge/agent-task.json')).toString());
  for (const input of task.inputs) if (sha256(await readBounded(folder, input.path)) !== input.sha256) throw Error('Handoff input changed during readback.');
  for (const file of plan.packet.files) if (!(await readBounded(folder, file.path)).equals(Buffer.from(file.content))) throw Error('Task packet readback mismatch.');
  if (readback.taskId !== task.taskId || await sourceIdentity(folder, project.flow) !== identity || !before.equals(await readBounded(folder, '.launchforge/project.json'))) throw Error('Handoff is stale; regenerate before use.');
  return {selectedAdapterId: project.tool, plan, resume: record, qualification: 'OFFLINE_CONTRACT_ONLY',
    auth: 'UNKNOWN', execution: 'NOT_RUN', productCompletion: 'NOT_ASSESSED',
    notice: 'Review packet text and native client mode before copy/paste. This description cannot execute a client, prove its installation or billing, or authorize an action. No environment or auth probe was run.'};
}
