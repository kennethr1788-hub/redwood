import {randomUUID,createHash} from 'node:crypto';
import {buildTopicMap,appendTopicOverride} from './topic-map.js';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
function selected(p,ids){if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length)throw Error('Select evidence imports for this topic map.');return ids.map(id=>{const entry=p.evidenceImports?.find(e=>e.id===id);if(!entry)throw Error('Unknown evidence import.');return entry.normalized;});}
export function buildWorkspaceTopics(p,b){
 const previous=p.topicMap?.input,importIds=b.importIds??previous?.importIds;
 const pages=b.pages??previous?.pages??(p.audit?.pages||[]).filter(a=>a.status>=200&&a.status<400).map(a=>({url:a.url,...(a.title?{title:a.title}:{}),status:a.status}));
 const input={imports:selected(p,importIds),pages,overrides:previous?.overrides||[],settings:(p.productPack?.cta.destination||p.url)?{proposalBaseUrl:p.productPack?.cta.destination||p.url}:{}};
 const result=buildTopicMap(input),saved={importIds,pages,overrides:input.overrides,settings:input.settings};
 p.topicMap={input:saved,result,revision:hash({saved,result}),stale:false,notice:'Supplied page inventory and lexical proposals require human review. No demand metrics are inferred.'};
 p.exports=(p.exports||[]).map(e=>({...e,stale:true}));return p;
}
export function overrideWorkspaceTopics(p,b){
 const current=p.topicMap;if(!current||current.stale||b.revision!==current.revision)throw Error('Topic map changed or is stale. Rebuild and review again.');
 if(b.reviewed!==true)throw Error('Review this topic override first.');
 const full={...current.input,imports:selected(p,current.input.importIds)};delete full.importIds;
 const next=appendTopicOverride(full,{...b.operation,operationId:randomUUID()});
 const result=buildTopicMap(next),input={...current.input,overrides:next.overrides};
 p.topicMap={...current,input,result,revision:hash({input,result}),stale:false};p.exports=(p.exports||[]).map(e=>({...e,stale:true}));return p;
}
