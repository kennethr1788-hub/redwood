export type Resume = {schemaVersion: 1; derived: true; projectId: string; projectName: string; product: string;
  sourceIdentity: string | null; currentRevision: string | null; currentStage: string; completionState: string;
  nextRecommendedAction: {kind: string; summary: string; targetPath: string}; unresolvedItems: {id: string; summary: string}[]};
export function deriveResume(state: unknown): Resume;
export function serializeResume(record: unknown): string;
export function renderResumeMarkdown(record: unknown): string;
export function parseResume(value: string): Resume;
export function inspectResume(cached: unknown, state: unknown): {status: string; record: Resume};
export function createAgentTaskResumeInput(cached: unknown, state: unknown, path?: string): {kind: string; path: string; summary: string};
