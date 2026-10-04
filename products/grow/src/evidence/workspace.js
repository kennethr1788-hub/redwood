import path from 'node:path';
import {atomicWrite} from '../core/store.js';
import {durableWrite} from '../export/index.js';
import {importGscCsv,importQueryCsv,importQueryList,detectImportConflicts,serializeEvidenceImport} from './import/index.js';
const kinds={GSC_CSV:importGscCsv,QUERY_CSV:importQueryCsv,QUERY_LIST:importQueryList};
export async function addEvidence(p,dir,input){
 if(!kinds[input.kind]||typeof input.base64!=='string'||input.base64.length>700000)throw Error('Choose a supported UTF-8 evidence file under 512 KB.');
 const raw=Buffer.from(input.base64,'base64');if(raw.length>512*1024||raw.toString('base64')!==input.base64)throw Error('Invalid or oversized evidence bytes.');
 const history=p.evidenceImports||[];if(history.length>=20)throw Error('This workspace retains at most 20 imports. Start a separate cohort workspace.');
 const metadata={...input.metadata,importedAt:new Date().toISOString()};delete metadata.importId;
 const normalized=kinds[input.kind](raw,{metadata,...(input.kind==='QUERY_CSV'?{mapping:input.mapping}:{}),limits:{bytes:512*1024,rows:1000,warnings:80}});
 const conflicts=detectImportConflicts(normalized,history.map(e=>e.normalized));
 if(conflicts.conflicts.some(c=>c.code==='DUPLICATE_FILE_HASH'||c.code==='IMPORT_ID_COLLISION'))throw Error('This exact evidence is already imported. Reuse its provenance; do not count it twice.');
 const base=`evidence/${normalized.importId}`;
 // Immutable content-addressed receipt; project JSON is the admission authority.
 await durableWrite(path.join(dir,base+'.csv'),raw);
 await atomicWrite(path.join(dir,base+'.json'),serializeEvidenceImport(normalized));
 p.evidenceImports=[...history,{id:normalized.importId,normalized,conflicts,rawFile:base+'.csv',normalizedFile:base+'.json'}];
 if(p.topicMap)p.topicMap.stale=true;
 p.exports=(p.exports||[]).map(e=>({...e,stale:true}));
 return p;
}
