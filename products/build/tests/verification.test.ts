import {test,expect} from 'vitest';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {sourceIdentity,freshness,flowSchema,diagnostic} from '../src/core/verification';
import {runFlow} from '../src/preview/flow';
test('source, test, config and lock changes stale evidence; generated output does not',async()=>{
 const root=await fs.mkdtemp(path.resolve('.local/freshness-'));
 try{await fs.mkdir(path.join(root,'src'));await fs.mkdir(path.join(root,'tests'));
 for(const name of ['src/main.ts','tests/user.spec.ts','vite.config.ts','package-lock.json'])await fs.writeFile(path.join(root,name),'first');
 const identity=await sourceIdentity(root);
 for(const name of ['src/main.ts','tests/user.spec.ts','vite.config.ts','package-lock.json']){await fs.writeFile(path.join(root,name),'changed');expect(await sourceIdentity(root)).not.toBe(identity);await fs.writeFile(path.join(root,name),'first');}
 await fs.mkdir(path.join(root,'dist'));await fs.writeFile(path.join(root,'dist/output'),'generated');expect(await sourceIdentity(root)).toBe(identity);
 await fs.symlink(path.join(root,'src'),path.join(root,'link'));await expect(sourceIdentity(root)).rejects.toThrow('symlink');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('flow paths and missing test/dependency fail clearly without writes',async()=>{
 expect(()=>flowSchema.parse({name:'a',testPath:'tests/../escape.spec.ts',outcome:'meaningful outcome'})).toThrow();
 const root=await fs.mkdtemp(path.resolve('.local/missing-flow-'));
 try{const flow=flowSchema.parse({name:'save',testPath:'tests/save.spec.ts',outcome:'A saved item survives reload'});const r=await runFlow(root,flow,'id','http://127.0.0.1:59999');expect(r.status).toBe('failed');expect(r.log).toContain('could not run');expect(await fs.readdir(root)).toEqual([]);await fs.mkdir(path.join(root,'tests'));await fs.writeFile(path.join(root,flow.testPath),'test source');const missing=await runFlow(root,flow,'id','http://127.0.0.1:59999');expect(missing.status).toBe('failed');expect(missing.log).toContain('playwright');}finally{await fs.rm(root,{recursive:true,force:true});}
});
test('legacy/missing identity and incomplete runs never become current passes; packet excerpts bounded',()=>{
 expect(freshness(undefined,'x')).toBe('NOT_RUN');
 expect(diagnostic('token=SECRET https://example.test/private?token=abc '+ 'x'.repeat(1000))).not.toContain('SECRET');expect(diagnostic('x'.repeat(1000)).length).toBeLessThan(500);expect(diagnostic('Expected secret-value to equal other-value')).not.toContain('secret-value');expect(diagnostic('TS2322 Exit: 2')).toContain('TS2322');
});
test('nested source output-named directories and executable modes are verification inputs',async()=>{
 const root=await fs.mkdtemp(path.resolve('.local/nested-freshness-'));
 try{const nested=path.join(root,'src/dist/critical.ts');await fs.mkdir(path.dirname(nested),{recursive:true});await fs.writeFile(nested,'export const critical = 1');const first=await sourceIdentity(root);await fs.writeFile(nested,'export const critical = 2');expect(freshness({identity:first,status:'PASSED',flow:{name:'meaningful'}} as any,await sourceIdentity(root))).toBe('STALE');const second=await sourceIdentity(root);await fs.chmod(nested,0o755);expect(await sourceIdentity(root)).not.toBe(second);}finally{await fs.rm(root,{recursive:true,force:true});}
});
