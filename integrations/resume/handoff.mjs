import { inspectResume } from './derive.mjs';
import { renderResumeMarkdown } from './serialization.mjs';
import { fail, relativePath } from './validation.mjs';

/** Append the returned value to a provider-neutral AgentTask.inputs array.
 * This owns one input shape, not a second AgentTask protocol or runner.
 * A future bridge mapper can attach it without changing provider permissions.
 */
export function createAgentTaskResumeInput(cachedResume, currentNormalizedState, resumePath = '.launchforge/resume.json') {
  relativePath(resumePath);
  const checked = inspectResume(cachedResume, currentNormalizedState);
  if (checked.status !== 'CURRENT') fail('Regenerate stale resume before agent handoff');
  return Object.freeze({ kind: 'PROJECT_RESUME', path: resumePath, summary: renderResumeMarkdown(checked.record) });
}
