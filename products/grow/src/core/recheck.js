/** Compare the same native lab finding on the same observed URL, never aggregate scores. */
export function compareAudits(before, after) {
  if (!before?.runId) return null;
  const result = {status:'COMPARED', baselineRunId:before.runId, currentRunId:after.runId, changes:[], unverified:[], limitation:'Observed lab comparison only. No deployment, field performance, ranking or answer-engine inclusion is certified.'};
  const previous = before.lab?.reports || [], current = after.lab?.reports || [];
  if (after.status === 'FAILED' || !previous.length || !current.length || before.runId === after.runId) { result.status='INCOMPLETE'; result.unverified=previous.map(r=>r.url); return result; }
  for (const old of previous) {
    const next=current.find(r=>(r.requestedUrl||r.url)===(old.requestedUrl||old.url));
    const fresh=next && Number.isFinite(Date.parse(next.fetchTime)) && Date.parse(next.fetchTime)>Date.parse(old.fetchTime) && old.sha256 && next.sha256 && old.sha256!==next.sha256;
    const sameConfig=old.configSettings && next?.configSettings && JSON.stringify(old.configSettings)===JSON.stringify(next.configSettings);
    if (!fresh || !sameConfig || !next || old.runtimeError || next.runtimeError || old.version !== next.version || old.url !== next.url) {
      result.status='INCOMPLETE'; result.unverified.push(old.url); continue;
    }
    for (const item of old.observations || []) {
      const newer=next.observations?.find(a=>a.id===item.id);
      const measurable=a=>a && typeof a.score==='number' && Number.isFinite(a.score) && a.score>=0 && a.score<=1 && !a.errorMessage && a.state!=='ERROR' && ['binary','numeric'].includes(a.scoreDisplayMode);
      if (!measurable(item)||!measurable(newer)||item.score===newer.score) continue;
      result.changes.push({url:next.url,id:item.id,title:newer.title,before:item.score,after:newer.score,outcome:newer.score===1?'RESOLVED':item.score===1?'REGRESSED':'CHANGED'});
    }
  }
  return result;
}
