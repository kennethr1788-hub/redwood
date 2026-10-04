export function sha256(value: string | Buffer): string;
export const PROHIBITED_EFFECTS: readonly string[];
export type AgentTask = {schemaVersion: number; taskId: string; product: string; action: string; workspace: string; createdAt: string;
 sourceIdentity: {revision: string; sha256: string}; objective: string; inputs: {path: string; sha256: string}[]; preserve: string[]; acceptance: string[];
 allowedEffects: string[]; prohibitedEffects: readonly string[]; commands: {argv: string[]; cwd: string}[]; evidencePaths: string[]; expectedReceiptPath: string};
export function validateTask(input: unknown): AgentTask;
export function parseTask(value: string): AgentTask;
export type Packet = {json: string; markdown: string; sha256: string; files: {path: string; content: string}[]};
export function taskPacket(task: unknown): Packet;
