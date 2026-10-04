import test from 'node:test';
import assert from 'node:assert/strict';
import {mapStudioState, mapGrowState} from '../owner-adapters.mjs';
import {deriveResume, serializeResume, renderResumeMarkdown, parseResume} from '../index.mjs';
import {supportDoctor} from '../../connectors/support-doctor.mjs';
const h = 'a'.repeat(64), other = 'b'.repeat(64), at = '2026-10-03T20:00:00.000Z';
const artifact = {path: 'exports/landscape.mp4', expectedSha256: h, observedSha256: h, presence: 'PRESENT', validation: 'PASSED'};
const view = {studio: {id: 'fixture-studio', name: 'Studio fixture', revision: 4, asset: {path: 'source/input.mp4'}}, exports: [{name: 'landscape.mp4', sha256: h}], inspection: {stale: false, status: 'PASSED'}, editing: {reviews: []}};
const options = {identity: h, receipt: {revision: 4, binding: {identity: h}, renderedAt: at, files: [{name: 'landscape.mp4', sha256: h}]}, artifacts: [artifact], openedAt: at};
const project = {id: 'grow-fixture', name: 'Grow fixture', updatedAt: at, growthPlan: {}, exports: [{id: 'export-1', stale: false}]};
const output = {id: 'export-1', kind: 'EXPORT', binding: {sourceIdentity: h, revision: 'revision-' + Date.parse(at), dependencies: []}, bindingMode: 'PROJECT', receiptPath: 'exports/receipt.json', artifacts: [{...artifact,path:'exports/package.md'}], status: 'EXPORTED'};
test('Studio current owner snapshot maps read-only; an inspected frame never upgrades a render to INSPECTED', () => {
 const before = JSON.stringify({view, options}); const record = deriveResume(mapStudioState(view, options));
 assert.equal(record.completionState, 'RENDERED'); assert.equal(record.nextRecommendedAction.kind, 'INSPECT_OUTPUT');
 assert.equal(JSON.stringify({view, options}), before); assert.deepEqual(parseResume(serializeResume(record)), record);
});
for (const [name, change, expected] of [
 ['changed timeline', {identity: other}, 'STALE'],
 ['missing output', {artifacts: [{...artifact, presence: 'MISSING', observedSha256: null}]}, 'OUTPUT_STALE_OR_MISSING'],
 ['tampered output', {artifacts: [{...artifact, observedSha256: other}]}, 'OUTPUT_STALE_OR_MISSING'],
 ['unknown identity', {identity: null}, 'UNKNOWN'],
 ['no artifact observations', {artifacts: []}, 'UNKNOWN'],
 ['recovery required', {recovery: 'RECONCILE_REQUIRED'}, 'RECONCILE_REQUIRED'],
]) test('Studio: ' + name, () => assert.equal(deriveResume(mapStudioState(view, {...options, ...change})).completionState, expected));
test('Studio owner stale flag overrides supplied current observations', () => assert.equal(deriveResume(mapStudioState({...view, exports: [{stale: true}]}, options)).completionState, 'STALE'));
test('Studio requires observations for all receipt files, not a caller-selected subset', () => {
 const partial = {...options, receipt: {...options.receipt, files: [...options.receipt.files, {name: 'portrait.mp4', sha256: h}]}};
 const record = deriveResume(mapStudioState(view, partial)); assert.equal(record.completionState, 'UNKNOWN'); assert.equal(record.receipts[0].artifacts.length, 2);
});
test('Studio expected hashes come from the receipt, not caller-supplied expected values', () => {
 const altered = {...options, artifacts: [{...artifact, expectedSha256: other, observedSha256: other}]};
 assert.equal(deriveResume(mapStudioState(view, altered)).completionState, 'OUTPUT_STALE_OR_MISSING');
});
test('Grow maps current export as EXPORTED, preserves state and never infers publication', () => {
 const before = JSON.stringify(project); const record = deriveResume(mapGrowState(project, {sourceIdentity: h, outputs: [output], openedAt: at}));
 assert.equal(record.completionState, 'EXPORTED'); assert.match(record.nextRecommendedAction.summary, /does not establish publication/); assert.equal(JSON.stringify(project), before);
});
test('Grow owner stale flag, unknown output and missing bytes cannot become current exports', () => {
 assert.equal(deriveResume(mapGrowState({...project,exports:[{id:'export-1',stale:true}]}, {sourceIdentity:h,outputs:[output],openedAt:at})).completionState,'STALE');
 assert.equal(deriveResume(mapGrowState({...project,exports:[]}, {sourceIdentity:h,outputs:[output],openedAt:at})).completionState,'UNKNOWN');
 assert.equal(deriveResume(mapGrowState(project, {sourceIdentity:h,outputs:[{...output,artifacts:[{...artifact,presence:'MISSING',observedSha256:null}]}],openedAt:at})).completionState,'OUTPUT_STALE_OR_MISSING');
 const unknown = deriveResume(mapGrowState(project, {openedAt:at})); assert.equal(unknown.completionState,'DRAFT'); assert.equal(unknown.unresolvedItems[0].id,'exports-unverified');
});
test('Grow dependency-scoped change affects dependent output and readback', () => {
 const dependent = {...output,bindingMode:'DEPENDENCIES',binding:{sourceIdentity:h,revision:null,dependencies:[{id:'assets',revision:'r1'}]}};
 const r = deriveResume(mapGrowState(project,{sourceIdentity:h,outputs:[dependent],dependencies:[{id:'assets',revision:'r2'}],openedAt:at}));
 assert.equal(r.completionState,'STALE'); assert.equal(r.receipts[0].scope,'DEPENDENCIES'); assert.match(renderResumeMarkdown(r), /STALE/);
});
test('doctor is generic, zero-observation UNKNOWN, media qualified offline only and no auth or completion authority', () => {
 const r = supportDoctor(at); assert.equal(r.baseline, 'UNAFFECTED_BY_CONNECTORS'); assert.equal(r.productCompletion, 'NOT_ASSESSED'); assert.equal(r.mediaIntegration,'OFFLINE_QUALIFIED');
 assert.equal(r.providerRuntimeQualification, 'NOT_RUN');
 assert.equal(r.rows.length,6); for(const row of r.rows){assert.equal(row.status,'UNKNOWN');assert.equal(row.authenticated,null);assert.equal(row.actionAuthorization,'NOT_GRANTED');}
});
