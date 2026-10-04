import {validateRangeSet, retainedDurationMs, sourceToOutputMs, outputToSourceMs, mapSourceIntervalToOutput, removeSourceInterval, restoreSourceInterval} from './ranges.js';
export {retainedDurationMs, sourceToOutputMs, outputToSourceMs, mapSourceIntervalToOutput};

// The v1 adapter supplies one retained range. All clock arithmetic stays in ranges.js.
export function timelineRanges(timeline, sourceDurationMs = timeline.rangeSet?.sourceDurationMs ?? timeline.trim.endMs) {
  return validateRangeSet(timeline.rangeSet ?? {schemaVersion:1,sourceDurationMs,ranges:[{id:'original',...timeline.trim}]});
}
export function outputCaptions(timeline) {
  const ranges=timelineRanges(timeline,Math.max(timeline.trim.endMs,...timeline.captions.map(c=>c.endMs)));
  return timeline.captions.flatMap(c=>mapSourceIntervalToOutput(ranges,c.startMs,c.endMs).map(f=>({startMs:f.outputStartMs,endMs:f.outputEndMs,text:c.text})));
}
export function outputEvents(timeline, events) {
  const ranges=timelineRanges(timeline);
  return events.filter(e=>e.timeMs<=ranges.sourceDurationMs).flatMap(e=>{
    const outputMs=sourceToOutputMs(ranges,e.timeMs);
    if(outputMs===null)return [];
    const span=mapSourceIntervalToOutput(ranges,e.timeMs,Math.min(ranges.sourceDurationMs,e.timeMs+450))[0];
    return [{...e,sourceTimeMs:e.timeMs,timeMs:outputMs,endMs:span.outputEndMs}];
  });
}
export function withRanges(timeline, rangeSet) {
  rangeSet=validateRangeSet(rangeSet);
  if(retainedDurationMs(rangeSet)<500)throw Error('Retain at least 0.5 seconds.');
  const old=timelineRanges(timeline,rangeSet.sourceDurationMs);
  const anchor=timeline.coverTimeMs==null?null:outputToSourceMs(old,timeline.coverTimeMs);
  return {...timeline,schemaVersion:2,rangeSet,trim:{startMs:rangeSet.ranges[0].startMs,endMs:rangeSet.ranges.at(-1).endMs},coverTimeMs:anchor===null?null:sourceToOutputMs(rangeSet,anchor)};
}
export function editInterval(timeline, action, startMs, endMs) {
  if(!['remove','restore'].includes(action))throw Error('Choose remove or restore.');
  return withRanges(timeline,(action==='remove'?removeSourceInterval:restoreSourceInterval)(timelineRanges(timeline),startMs,endMs));
}
// Compatibility for existing trim controls and v1 clients: preserve interior cuts.
export function reconcileTrim(value, previous, sourceDurationMs) {
  if(!value.rangeSet)return value;
  const trim=value.trim,old=previous.trim;
  if(trim.startMs===old.startMs&&trim.endMs===old.endMs)return value;
  if(!Number.isInteger(trim.startMs)||!Number.isInteger(trim.endMs)||trim.startMs<0||trim.endMs>sourceDurationMs||trim.endMs-trim.startMs<500)throw Error('Invalid trim.');
  if(JSON.stringify(value.rangeSet)!==JSON.stringify(previous.rangeSet))return value;
  let set=timelineRanges(value,sourceDurationMs);
  if(trim.startMs<old.startMs)set=restoreSourceInterval(set,trim.startMs,old.startMs);
  if(trim.endMs>old.endMs)set=restoreSourceInterval(set,old.endMs,trim.endMs);
  if(trim.startMs>0)set=removeSourceInterval(set,0,trim.startMs);
  if(trim.endMs<sourceDurationMs)set=removeSourceInterval(set,trim.endMs,sourceDurationMs);
  return withRanges({...value,trim:old},set);
}
