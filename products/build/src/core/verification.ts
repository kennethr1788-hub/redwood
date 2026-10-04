import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
export const flowSchema = z.object({
  name: z.string().trim().min(1).max(100),
  testPath: z.string().regex(/^(tests|e2e)\/[a-zA-Z0-9_./-]+\.(spec|test)\.[cm]?[jt]sx?$/).refine(v => !v.split('/').some(s => s === '..' || s === '.' || !s)),
  outcome: z.string().trim().min(10).max(1000),
  preserve: z.string().max(1000).default('Preserve existing source, data, and official-client boundaries.'),
  width: z.number().int().min(320).max(1920).default(1280),
  height: z.number().int().min(480).max(1200).default(800),
});
export const runSchema = z.object({
  id: z.string().uuid(), identity: z.string().length(64), startedAt: z.string(), endedAt: z.string().optional(),
  status: z.enum(['RUNNING','PASSED','FAILED','CHANGED_DURING_RUN']),
  checks: z.record(z.string(), z.object({status:z.enum(['passed','failed','NOT_RUN_IN_THIS_RUN']), log:z.string().max(24000),at:z.string()})),
  flow: flowSchema.optional(), testHash:z.string().optional(), browser:z.string().max(100).optional(),
  diagnostics:z.array(z.string().max(500)).max(20).default([]), packet:z.string().max(20000).optional(),
});
export type Flow = z.infer<typeof flowSchema>;
export type VerificationRun = z.infer<typeof runSchema>;
const ignored = new Set(['.git','node_modules','.DS_Store']);
const generatedAtRoot = new Set(['dist','.launchforge','test-results','playwright-report']);
// Bounded walk of this explicit owned project only. No following links or parent roots.
export async function sourceIdentity(root:string, flow?:Flow) {
 const hash=createHash('sha256').update('source-identity-v2\0');let count=0,bytes=0;
 async function visit(dir:string,depth:number) {
  if(depth>16)throw new Error('Source identity exceeds the 16-directory bound.');
  const entries=await fs.readdir(dir,{withFileTypes:true});
  if(entries.length>2048)throw new Error('Source identity exceeds the file bound.');
  for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
   if(ignored.has(entry.name)||(depth===0&&generatedAtRoot.has(entry.name)))continue;
   const file=path.join(dir,entry.name),relative=path.relative(root,file);
   if(++count>2048)throw new Error('Source identity exceeds 2048 entries.');
   const s=await fs.lstat(file);
   if(s.isSymbolicLink())throw new Error('Source identity refuses symlinks: '+relative);
   if(s.isDirectory()){await visit(file,depth+1);continue;}
   if(!s.isFile()||s.size>8_000_000||(bytes+=s.size)>32_000_000)throw new Error('Source identity requires regular files within 8 MB each / 32 MB total.');
   const b=await fs.readFile(file);hash.update(relative+'\0'+(s.mode&0o777)+'\0'+b.length+'\0').update(b);
  }
 }
 await visit(root,0);hash.update(JSON.stringify(flow||null));return hash.digest('hex');
}
export function freshness(run:VerificationRun|undefined,current:string|null) {
 if(!run)return 'NOT_RUN';
 if(!current)return 'UNKNOWN';
 if(run.identity!==current || run.status==='CHANGED_DURING_RUN')return 'STALE';
 if(run.status==='RUNNING')return 'INCOMPLETE';
 return run.status==='PASSED'?(run.flow?'CURRENT_PASS':'CURRENT_CHECKS_PASS_NO_FLOW'):'CURRENT_FAIL';
}
// Only small excerpts leave local check history for a manually reviewed repair packet.
export function diagnostic(value:string) {
 // Portable packets must not include assertion values or arbitrary command output.
 // Extract only fixed error classes/codes and event kinds; full output stays local.
 const codes=[...new Set(value.match(/\bTS[0-9]{4}\b|\b(?:TimeoutError|AssertionError|SyntaxError|TypeError|ReferenceError)\b|Exit: (?:[0-9]{1,3}|SIG[A-Z]{2,8})|console-error|page-exception|Request failed|HTTP [45][0-9]{2}|Test timeout of [0-9]{1,6}ms exceeded/g)||[])];
 return (codes.join('; ') || 'Command/test failed; no safely portable error code was found.')+' Full command output and assertion values omitted; inspect local Checks.';
}
