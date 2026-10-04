import type {Packet} from './contract.mjs';
export const ADAPTERS: Record<string, {id: string; displayName: string; capabilities: {declaration: string; headlessModes: string[]; headlessPolicy: string}}>;
export function launchPlan(id: string, options: unknown, task: unknown): {kind: string; adapterId: string; executionAuthorized: false; packet: Packet; executable?: string; argv?: string[]; cwd?: string; shell?: false};
export function headlessPlan(id: string, options: unknown, task: unknown): unknown;
