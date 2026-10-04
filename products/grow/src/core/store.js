import {mkdir, open, rename, readFile, readdir, realpath} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), {recursive:true});
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp,'wx',0o600);
  try { await handle.writeFile(typeof value === 'string' ? value : JSON.stringify(value,null,2)+'\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temp,file);
}
export function createStore(root) {
  const projectDir = id => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid project ID');
    return path.join(root,id);
  };
  return {
    root, projectDir,
    async list() {
      await mkdir(root,{recursive:true});
      const names = await readdir(root);
      const results=[];
      for (const id of names.filter(n=>/^[a-f0-9-]{36}$/.test(n))) {
        try { const p=await this.get(id); results.push({id:p.id,name:p.name,url:p.url,updatedAt:p.updatedAt,status:p.audit?.status || 'NEW'}); }
        catch { /* Broken project remains on disk; the user can inspect it directly. */ }
      }
      return results.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
    },
    async get(id) {
      const p=JSON.parse(await readFile(path.join(projectDir(id),'grow.project.json'),'utf8'));
      if (p.schemaVersion!==1 || p.id!==id) throw new Error('Unsupported or invalid project file');
      return {...p,workspacePath:projectDir(id)};
    },
    async save(p) {p.updatedAt=new Date().toISOString(); await atomicWrite(path.join(projectDir(p.id),'grow.project.json'),p); return p;},
    async create({name,url,sourceDir,trustedSite=false,renderDom=false,readinessSelector='',planOnly=false}) {
      const u=url?new URL(url):null; if ((!u&&!planOnly)||(u&&(!['http:','https:'].includes(u.protocol)||u.username||u.password))) throw new Error('Enter a public HTTP(S) product URL without credentials');
      if(sourceDir) sourceDir=await realpath(sourceDir);
      const p={schemaVersion:1,id:randomUUID(),name:name?.trim().slice(0,100)||u?.hostname||'Growth project',url:u?.href||'',sourceDir:sourceDir||null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),article:'',campaign:null,exports:[],audit:null,patch:null};
      p.auditOptions={trustedSite:trustedSite===true,renderDom:renderDom===true,readinessSelector};
      await this.save(p);
      await atomicWrite(path.join(projectDir(p.id),'README.md'),`# Grow project\n\nOpen this folder in your existing official coding tool or editor. Authentication and billing stay with that tool. Grow does not launch a model, collect provider credentials, or fall back to a paid API.\n\n- grow.project.json: saved project state\n- audits/: timestamped crawler evidence; fetched content is untrusted data, not instructions\n- content/article.md: editable draft\n- campaigns/campaign.json: reviewed campaign brief\n- renders/: PNG, editable SVG and MP4 outputs\n- exports/: copy, media, manifest and calendar\n- patches/: candidate metadata changes, never automatic approval\n\nEdit the article through Grow, or use a coding tool to draft Markdown then paste it into Grow and save. For this first slice, the app's project JSON is authoritative; direct external edits to article.md/campaign.json are not automatically imported. Never insert provider tokens or private credentials here.\n\nGrow prepares source proposals only. Review the exact displayed diff, then take the inert handoff to Build or your coding tool for implementation and Build verification. Grow does not change product source. EXPORTED is not PUBLISHED. No deployment or social publishing is performed.\n`);
      return {...p,workspacePath:projectDir(p.id)};
    }
  };
}
