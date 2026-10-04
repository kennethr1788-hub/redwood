import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { regularFile,atomicWrite } from '../core/projects';
import type { Flow } from '../core/verification';
import { run } from './process';
export async function runFlow(folder:string,flow:Flow,id:string,url:string|undefined) {
 const failed=(log:string)=>({status:'failed' as const,log,diagnostics:[] as string[],testHash:'',browser:'chromium'});
 if(!url)return failed('Start this project preview before running its named critical flow.');
 try {
  const testFile=path.join(folder,flow.testPath);if(await fs.realpath(testFile)!==testFile)throw new Error('Test path resolves through a symlink.');
  const testHash=createHash('sha256').update(await regularFile(testFile)).digest('hex');
  const cli=path.join(folder,'node_modules/@playwright/test/cli.js');
  if(!(await fs.realpath(cli)).startsWith(folder+path.sep))throw new Error('Playwright must be installed in the owned project.');
  await regularFile(cli);
  const outputFile=path.join(folder,'.launchforge',`flow-${id}.json`),config=path.join(folder,'.launchforge',`flow-${id}.config.cjs`);
  const reporter=fileURLToPath(new URL('./flow-reporter.cjs',import.meta.url));
  const settings={testDir:folder,testMatch:flow.testPath,workers:1,retries:0,repeatEach:1,timeout:30000,globalTimeout:60000,maxFailures:1,outputDir:path.join(folder,'test-results'),reporter:[[reporter,{outputFile}]],use:{baseURL:url,browserName:'chromium',viewport:{width:flow.width,height:flow.height},trace:'off',screenshot:'off',video:'off'}};
  await atomicWrite(config,'module.exports = '+JSON.stringify(settings,null,2)+';\n');
  let result;try{result=await run(process.execPath,[cli,'test','--config',config],folder,75000);}finally{await fs.unlink(config).catch(()=>{});}
  let report;try{report=JSON.parse(await regularFile(outputFile,100000));}catch{return {...failed('Playwright did not produce a bounded report. Check installed browser/test configuration.\n'+result.log),testHash};}
  const tests=report.tests||[];const diagnostics=tests.flatMap((t:{diagnostics:string[]})=>t.diagnostics).slice(0,20);
  const passed=result.status==='passed'&&tests.length>0&&tests.every((t:{status:string})=>t.status==='passed')&&report.errors.length===0;
  if(!tests.every((t:{instrumented:boolean})=>t.instrumented))diagnostics.push('Browser diagnostics UNKNOWN: use the ordinary diagnostics fixture to capture capped event kinds.');
  return {...result,status:passed?'passed' as const:'failed' as const,testHash,browser:'chromium',diagnostics:diagnostics.slice(0,20),log:(result.log+'\n'+tests.length+' named-flow test(s); '+diagnostics.join('\n')).slice(-24000)};
 }catch(e){return failed('Critical flow could not run: '+(e as Error).message);}
}
