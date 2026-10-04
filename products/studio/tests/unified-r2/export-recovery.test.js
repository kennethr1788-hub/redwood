import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import path from 'node:path';import os from 'node:os';
import {Store} from '../../src/core/store.js';import {qualifyFFmpeg,runNative} from '../../src/render/native.js';import {renderProject} from '../../src/render/index.js';
test('failed install and failed rollback preserve the prior export in staging for recovery',async()=>{
 const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),'lf-render-recovery-'));const originalRename=fs.promises.rename;
 try{
  const {binary,encoder}=await qualifyFFmpeg();const source=path.join(root,'source.mp4');await runNative(binary,['-y','-f','lavfi','-i','testsrc2=size=640x360:rate=30:duration=1','-c:v',encoder,...(encoder==='h264_videotoolbox'?['-allow_sw','1']:[]),source]);
  const store=new Store(path.join(root,'projects'));await store.init();const p=await store.importMedia(source,{name:'Rollback fault fixture'}),dir=store.dir(p.studio.id),destination=path.join(dir,'exports');await fs.promises.mkdir(destination);await fs.promises.writeFile(path.join(destination,'retained.txt'),'prior verified artifact must survive');
  fs.promises.rename=async(a,b)=>{if(b===destination)throw Object.assign(Error('Injected publication/rollback I/O failure'),{code:'EACCES'});return originalRename(a,b);};syncBuiltinESMExports();
  await assert.rejects(()=>renderProject({projectDir:dir,...p}),/Injected/);
  const staging=(await fs.promises.readdir(dir)).find(n=>n.startsWith('.render-'));assert.ok(staging,'recoverable staging was deleted');assert.equal(await fs.promises.readFile(path.join(dir,staging,'previous-exports/retained.txt'),'utf8'),'prior verified artifact must survive');assert.equal((await store.get(p.studio.id)).exports.length,0);
 }finally{fs.promises.rename=originalRename;syncBuiltinESMExports();await fs.promises.rm(root,{recursive:true,force:true});}
});
