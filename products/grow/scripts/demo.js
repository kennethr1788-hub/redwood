// Fictional, local-only fixture. No provider or external site is involved.
import {createServer} from 'node:http';
import {mkdir,readFile,copyFile,access} from 'node:fs/promises';
import path from 'node:path';
import {createApp} from '../src/server.js';
const root=path.resolve('.work/demo-source');await mkdir(root,{recursive:true});
const entry=path.join(root,'index.html');try{await access(entry);}catch{await copyFile('tests/fixtures/field-notes.html',entry);}
const origin='http://127.0.0.1:4384';
const fixture=createServer(async(req,res)=>{
 try{
  if(req.url==='/robots.txt'){res.end('User-agent: *\nAllow: /\n');return;}
  if(req.url==='/sitemap.xml'){res.setHeader('Content-Type','application/xml');res.end(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url><url><loc>${origin}/features</loc></url></urlset>`);return;}
  if(req.url==='/unavailable'){res.writeHead(503);res.end('Demonstration failure: the source is unavailable.');return;}
  res.setHeader('Content-Type','text/html');res.end(req.url==='/features'?'<html><head><title>Field Notes features</title></head><body><h1>A shared space for the details</h1><p>Keep your project notes and next steps together.</p></body></html>':await readFile(entry));
 }catch(e){res.writeHead(500);res.end(e.message);}
});
fixture.on('error',e=>{console.error(e.message);process.exit(1);});
await new Promise(r=>fixture.listen(4384,'127.0.0.1',r));
const app=createApp({allowedLocalOrigin:origin});app.server.on('error',e=>{console.error(e.message);fixture.close();process.exitCode=1;});
app.server.listen(4383,'127.0.0.1',()=>console.log(`Grow demo: http://127.0.0.1:4383\nProduct URL: ${origin}\nOptional source checkout: ${root}\nFictional Field Notes fixture. Local source edits persist across restarts.`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{app.server.close();fixture.close();});
