// No raw console, network bodies, cookies, headers, storage, screenshots or traces.
const fs=require('node:fs');
module.exports=class {
 constructor(options){this.output=options.outputFile;this.tests=[];this.errors=[];}
 onError(){this.errors.push('Playwright runner error (inspect local command log).');}
 onTestEnd(test,result){
  if(this.tests.length>=100)return;
  const diagnostics=[];
  for(const error of (result.errors||[]).slice(0,3))diagnostics.push(String(error.message||'Assertion failed').replace(/\u001b\[[0-9;]*m/g,'').replace(/https?:\/\/[^\s)]+/g,'[URL omitted]').replace(/(?:Bearer\s+\S+|(?:token|password|secret|api[_-]?key|cookie|authorization)\s*[=:]\s*[^\s,;]+)/gi,'[credential omitted]').replace(/(?:\/[\w.~-]+){3,}/g,'[local path omitted]').slice(0,500));
  for(const attachment of result.attachments||[]) {
   if(attachment.name!=='launchforge-diagnostics'||!attachment.body||attachment.body.length>16000)continue;
   try {const d=JSON.parse(attachment.body.toString());for(const e of d.slice(0,20)){
    if(e.kind==='console-error'||e.kind==='page-exception')diagnostics.push(e.kind+' observed (text omitted)');
    if(e.kind==='request-failed')diagnostics.push('Request failed (URL/body/headers omitted)');
    if(e.kind==='http-error'&&Number.isInteger(e.status)&&e.status>=400&&e.status<=599)diagnostics.push('HTTP '+e.status+' (URL/body/headers omitted)');
   }}catch{diagnostics.push('Invalid diagnostics attachment omitted.');}
  }
  this.tests.push({status:result.status,diagnostics:diagnostics.slice(0,20),instrumented:result.attachments.some(a=>a.name==='launchforge-diagnostics')});
 }
 onEnd(){fs.writeFileSync(this.output,JSON.stringify({tests:this.tests,errors:this.errors.slice(0,5)}));}
};
