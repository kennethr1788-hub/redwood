// Ordinary Playwright fixture; copy beside the owned test. Also runs outside LaunchForge.
import {test as base,expect} from '@playwright/test';
export {expect};
export const test=base.extend({page:async({page},use,testInfo)=>{
 const events:{kind:string;status?:number}[]=[];
 const add=(kind:string,status?:number)=>{if(events.length<20)events.push({kind,status});};
 page.on('console',m=>{if(m.type()==='error')add('console-error');});
 page.on('pageerror',()=>add('page-exception'));
 page.on('requestfailed',()=>add('request-failed'));
 page.on('response',r=>{if(r.status()>=400)add('http-error',r.status());});
 try{await use(page);}finally{await testInfo.attach('launchforge-diagnostics',{body:JSON.stringify(events),contentType:'application/json'});}
}});
