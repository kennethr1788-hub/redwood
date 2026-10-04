import type { Flow, VerificationRun } from './verification';
export type Tool = "codex" | "claude" | "cursor" | "gemini" | "manual";
export type Check = { status: "passed" | "failed"; at: string; log: string };
export type Project = {
  schemaVersion: 1;
  id: string;
  name: string;
  brief: string;
  reference: string;
  tool: Tool;
  createdAt: string;
  updatedAt: string;
  imported: boolean;
  previewPort?: number;
  flow?: Flow;
  verification?: VerificationRun;
  verificationHistory?: VerificationRun[];
  restore?: { id: string; at: string; target: string; paths: string[]; outcome: string; verificationRequired: boolean; verificationRunId?: string; postStatus?: string };
  checks?: Partial<Record<"install" | "typecheck" | "build" | "test", Check>>;
};
export type Runtime = {
  status: "stopped" | "starting" | "running" | "failed";
  url?: string;
  log: string;
};
export type Detail = {
  project: Project;
  path: string;
  runtime: Runtime;
  git: { branch: string; files: string; history: string };
  handoff: { command: string; prompt: string };
  trusted: boolean;
  busy: string | null;
  files: string[];
  verificationState: string;
  identityError?: string;
  resume?: import('../../../../integrations/resume/index.mjs').Resume;
  resumeError?: string;
};
