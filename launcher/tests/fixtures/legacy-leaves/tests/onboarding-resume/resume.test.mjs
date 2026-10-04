import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { deriveResume, deriveBuildResume, deriveStudioResume, deriveGrowResume, ResumeRecord, NormalizedProjectState,
  RecentProjectPointer, inspectResume, serializeResume, parseResume, renderResumeMarkdown, parseResumeMarkdown,
  resumeFiles, createAgentTaskResumeInput, resolveRecentProjectPointer } from '../../integrations/resume/index.mjs';
import { createOnboarding, serializeOnboarding, OnboardingInput, STARTING_POINTS, CONNECTION_STATES } from '../../integrations/onboarding/index.mjs';
import { buildFixture, studioFixture, growFixture, onboardingFixture, AT, HASH2 } from './fixtures.mjs';

test('Build current pass binds one run, source, revision and named user flow', () => {
  const input = buildFixture(), before = structuredClone(input);
  const r = deriveBuildResume(input);
  assert.equal(r.completionState, 'CURRENT_PASS');
  assert.equal(r.receipts[0].freshness, 'CURRENT');
  assert.equal(r.lastVerifiedAt, AT);
  assert.equal(r.lastSuccessfulAction.id, 'verify-1');
  assert.equal(r.nextRecommendedAction.kind, 'CONTINUE');
  assert.deepEqual(input, before);
});

test('Build source or revision changed makes prior verification stale and next action verify', () => {
  for (const field of ['sourceIdentity', 'currentRevision']) {
    const s = buildFixture(); s[field] = field === 'sourceIdentity' ? HASH2 : '13';
    const r = deriveResume(s);
    assert.equal(r.completionState, 'STALE');
    assert.equal(r.nextRecommendedAction.kind, 'VERIFY');
    assert.equal(r.lastVerifiedAt, AT); // historical receipt time, not a fresh claim
    assert.equal(r.receipts[0].freshness, 'STALE');
  }
});

test('Build unresolved failure persists and does not borrow an old pass', () => {
  const s = buildFixture();
  s.verification.status = 'FAILED'; s.verification.requiredChecks[0].status = 'FAILED';
  s.lastSuccessfulAction = { id: 'old-pass', summary: 'Previous checks passed.', at: '2026-10-02T20:00:00.000Z', receiptPath: '.launchforge/runs/old.json' };
  s.unresolvedItems = [{ id: 'bug-1', summary: 'Save fails after reopening.', path: 'src/app.mjs' }];
  const r = deriveResume(s);
  assert.equal(r.completionState, 'CURRENT_FAIL');
  assert.equal(r.nextRecommendedAction.kind, 'REPAIR_AND_VERIFY');
  assert.equal(r.lastFailedAction.id, 'verify-1');
  assert.equal(r.lastSuccessfulAction.id, 'old-pass');
  assert.equal(r.unresolvedItems[0].id, 'bug-1');
  assert.deepEqual(parseResume(serializeResume(r)).unresolvedItems, r.unresolvedItems);
});

test('Build no run, missing flow, interrupted, mixed and incomplete runs never become product completion', () => {
  const cases = [
    [s => { s.verification = null; }, 'NOT_RUN'],
    [s => { s.verification.criticalFlow = null; }, 'CURRENT_CHECKS_PASS_NO_FLOW'],
    [s => { s.verification.status = 'RUNNING'; }, 'INCOMPLETE'],
    [s => { s.verification.finishedAt = null; }, 'INCOMPLETE'],
    [s => { s.verification.requiredChecks = []; }, 'INCOMPLETE'],
    [s => { s.verification.requiredChecks[1].runId = 'old-run'; }, 'INCOMPLETE'],
    [s => { s.verification.criticalFlow.runId = 'old-run'; }, 'INCOMPLETE'],
    [s => { s.verification.requiredChecks[1].status = 'NOT_RUN_IN_THIS_RUN'; }, 'INCOMPLETE'],
    [s => { s.verification.requiredChecks[1].status = 'UNKNOWN'; }, 'UNKNOWN'],
    [s => { s.verification.requiredChecks[1].status = 'FAILED'; }, 'CURRENT_FAIL'],
    [s => { s.verification.status = 'CHANGED_DURING_RUN'; }, 'STALE'],
    [s => { s.verificationRequired = true; }, 'STALE'],
    [s => { s.sourceIdentity = null; }, 'UNKNOWN'],
    [s => { s.currentRevision = null; }, 'UNKNOWN'],
    [s => { s.recovery = 'RECONCILE_REQUIRED'; }, 'RECONCILE_REQUIRED'],
  ];
  for (const [change, expected] of cases) {
    const s = buildFixture(); change(s);
    assert.equal(deriveResume(s).completionState, expected, change.toString());
  }
});

test('unresolved owner items prevent a current pass from implying completion', () => {
  const s = buildFixture(); s.unresolvedItems = [{ id: 'open', summary: 'Missing real user outcome assertion.' }];
  const r = deriveResume(s);
  assert.equal(r.receipts[0].freshness, 'CURRENT');
  assert.equal(r.completionState, 'NEEDS_ATTENTION');
  assert.equal(r.nextRecommendedAction.kind, 'INSPECT_PROJECT');
});

test('Studio timeline edit and source change stale the render', () => {
  assert.equal(deriveStudioResume(studioFixture()).completionState, 'INSPECTED');
  for (const field of ['sourceIdentity', 'currentRevision']) {
    const s = studioFixture(); s[field] = field === 'sourceIdentity' ? HASH2 : '13';
    const r = deriveResume(s);
    assert.equal(r.completionState, 'STALE');
    assert.equal(r.nextRecommendedAction.kind, 'INSPECT_AND_RERENDER');
  }
});

test('Studio same revision cannot make missing/tampered/unprobed output fresh', () => {
  const cases = [
    [a => { a.presence = 'MISSING'; a.observedSha256 = null; }, 'OUTPUT_STALE_OR_MISSING'],
    [a => { a.observedSha256 = HASH2; }, 'OUTPUT_STALE_OR_MISSING'],
    [a => { a.validation = 'FAILED'; }, 'OUTPUT_STALE_OR_MISSING'],
    [a => { a.presence = 'UNKNOWN'; }, 'UNKNOWN'],
    [a => { a.expectedSha256 = null; }, 'UNKNOWN'],
    [a => { a.observedSha256 = null; }, 'UNKNOWN'],
    [a => { a.validation = 'UNKNOWN'; }, 'UNKNOWN'],
  ];
  for (const [change, expected] of cases) {
    const s = studioFixture(); change(s.render.artifacts[0]);
    const r = deriveResume(s);
    assert.equal(r.completionState, expected);
    assert.equal(r.nextRecommendedAction.kind, 'INSPECT_AND_RERENDER');
  }
  const empty = studioFixture(); empty.render.artifacts = [];
  assert.equal(deriveResume(empty).completionState, 'UNKNOWN');
});

test('Studio rendered is not inspected and interrupted recovery remains reconcile', () => {
  const s = studioFixture(); s.render.review = 'NOT_REVIEWED';
  assert.equal(deriveResume(s).completionState, 'RENDERED');
  assert.equal(deriveResume(s).nextRecommendedAction.kind, 'INSPECT_OUTPUT');
  s.render.status = 'RECOVERY_REQUIRED';
  assert.equal(deriveResume(s).completionState, 'RECONCILE_REQUIRED');
  assert.match(deriveResume(s).nextRecommendedAction.summary, /preserve previous complete exports/);
  s.render.status = 'FAILED';
  assert.equal(deriveResume(s).lastFailedAction.id, 'render-1');
  s.render.status = 'UNKNOWN';
  assert.equal(deriveResume(s).completionState, 'UNKNOWN');
  assert.equal(deriveResume(s).receipts[0].freshness, 'UNKNOWN');
});

test('Grow material evidence changes invalidate dependent recommendation/export only', () => {
  const s = growFixture();
  assert.equal(deriveGrowResume(s).completionState, 'EXPORTED');
  s.dependencies = s.dependencies.map(d => d.id === 'evidence' ? { ...d, revision: 'raw-2' } : d);
  s.currentRevision = '13';
  const r = deriveResume(s);
  assert.equal(r.completionState, 'STALE');
  assert.deepEqual(r.receipts.map(x => x.freshness), ['STALE', 'STALE', 'CURRENT']);
  assert.equal(r.nextRecommendedAction.kind, 'REVIEW_DEPENDENT_OUTPUTS');
  assert.ok(r.receipts[0].reasons.includes('DEPENDENCY_CHANGED'));
  assert.ok(!serializeResume(r).includes('PUBLISHED'));
});

test('Grow missing/unknown dependencies never compare as known; project scope binds revision', () => {
  for (const change of [s => { s.dependencies[0].revision = null; }, s => { s.outputs[0].binding.dependencies = []; }, s => { s.dependencies = []; }]) {
    const s = growFixture(); change(s);
    assert.equal(deriveResume(s).receipts[0].freshness, 'UNKNOWN');
  }
  const s = growFixture(); s.outputs[0].bindingMode = 'PROJECT'; s.currentRevision = '13';
  assert.equal(deriveResume(s).receipts[0].freshness, 'STALE');
});

test('Grow tampered exports fail output freshness; unknown, draft and failed states stay distinct', () => {
  const s = growFixture(); s.outputs[1].artifacts[0].observedSha256 = HASH2;
  assert.equal(deriveResume(s).completionState, 'OUTPUT_STALE_OR_MISSING');
  for (const status of ['UNKNOWN', 'DRAFT', 'FAILED', 'RUNNING']) {
    const fixture = growFixture(); fixture.outputs[0].status = status;
    assert.equal(deriveResume(fixture).completionState, status === 'RUNNING' ? 'INCOMPLETE' : status);
  }
});

test('unknown submit/cancel/processing retains identity and never recommends duplicate submit', () => {
  for (const make of [buildFixture, studioFixture, growFixture]) for (const status of ['UNKNOWN_RECONCILE', 'CANCEL_REQUESTED', 'SUBMITTED', 'PROCESSING']) {
    const s = make();
    s.externalRequests = [{ requestId: 'request-7', providerJobId: 'job-5', connectorId: 'optional-video', receiptPath: 'requests/request-7.json', status }];
    const r = deriveResume(s);
    assert.equal(r.nextRecommendedAction.kind, 'RECONCILE');
    assert.equal(r.nextRecommendedAction.requestId, 'request-7');
    assert.equal(r.externalRequests[0].providerJobId, 'job-5');
    assert.match(r.nextRecommendedAction.summary, /do not submit a duplicate/);
    assert.ok(['RECONCILE_REQUIRED', 'INCOMPLETE'].includes(r.completionState));
  }
  const s = buildFixture(); s.verification = null;
  s.externalRequests = [{ requestId: 'request-7', providerJobId: null, connectorId: 'optional-video', receiptPath: 'requests/request-7.json', status: 'SUCCEEDED' }];
  assert.equal(deriveResume(s).completionState, 'NOT_RUN');
});

test('cached resume is rechecked against all current facts, not just revision or stored green', () => {
  for (const make of [buildFixture, studioFixture, growFixture]) {
    const s = make(), cached = deriveResume(s);
    assert.equal(inspectResume(cached, s).status, 'CURRENT');
    s.unresolvedItems.push({ id: 'fresh', summary: 'Newly observed issue.' });
    assert.equal(inspectResume(cached, s).status, 'STALE');
    const forged = { ...cached, currentStage: 'FORGED_PASS' };
    assert.equal(inspectResume(forged, make()).status, 'STALE');
    assert.throws(() => createAgentTaskResumeInput(cached, s), /Regenerate/);
  }
  const s = studioFixture(), r = deriveResume(s);
  s.render.artifacts[0].presence = 'MISSING';
  assert.equal(inspectResume(r, s).record.completionState, 'OUTPUT_STALE_OR_MISSING');
});

test('running local operations reconcile before a new verification, render or export', () => {
  for (const make of [buildFixture, studioFixture, growFixture]) {
    const s = make();
    (s.verification ?? s.render ?? s.outputs[0]).status = 'RUNNING';
    assert.equal(deriveResume(s).nextRecommendedAction.kind, 'RECONCILE');
  }
  const s = growFixture(); s.outputs[0].status = 'EXPORTED';
  assert.throws(() => deriveResume(s));
});

test('failed external effects remain unresolved without claiming refund or completion', () => {
  const s = buildFixture();
  s.externalRequests = [{ requestId: 'failed-job', providerJobId: 'provider-job', connectorId: 'media', receiptPath: 'requests/failed.json', status: 'FAILED' }];
  const r = deriveResume(s);
  assert.equal(r.completionState, 'NEEDS_ATTENTION');
  assert.equal(r.nextRecommendedAction.targetPath, 'requests/failed.json');
  assert.match(r.unresolvedItems[0].summary, /does not establish a refund/);
});

test('deterministic canonical JSON/Markdown roundtrip including property insertion order', () => {
  for (const make of [buildFixture, studioFixture, growFixture]) {
    const s = make(), r = deriveResume(s), files = resumeFiles(r);
    assert.deepEqual(parseResume(files['resume.json']), r);
    assert.deepEqual(parseResumeMarkdown(files['resume.md']), r);
    assert.equal(renderResumeMarkdown(parseResume(files['resume.json'])), files['resume.md']);
    assert.equal(serializeResume(parseResumeMarkdown(files['resume.md'])), files['resume.json']);
    assert.deepEqual(deriveResume(Object.fromEntries(Object.entries(s).reverse())), r);
    assert.throws(() => parseResumeMarkdown(files['resume.md'].replace('Project:', 'Forged:')));
  }
});

test('plain data containing Markdown/HTML cannot escape into active Markdown', () => {
  const s = buildFixture(); s.projectName = '``` <img src=x> ![click](https://example.test)';
  const md = renderResumeMarkdown(deriveResume(s));
  assert.ok(!md.includes('<img'));
  assert.ok(!md.split('## Canonical portable record')[0].includes('![click]'));
  assert.equal((md.match(/```/g) ?? []).length, 2);
  assert.equal(parseResumeMarkdown(md).projectName, s.projectName);
});

test('fresh provider-neutral AgentTask input identifies next action without chat history', () => {
  const s = buildFixture(); s.sourceIdentity = HASH2; s.unresolvedItems = [{ id: 'save-bug', summary: 'Save requires recheck.', path: 'tests/save.spec.mjs' }];
  const resume = deriveResume(s), input = createAgentTaskResumeInput(resume, s);
  for (const adapter of ['codex', 'claude', 'cursor', 'gemini', 'manual']) {
    const task = { taskId: 'resume-task', adapter, product: s.product, inputs: [input] };
    assert.equal(task.inputs[0].path, '.launchforge/resume.json');
    const extracted = parseResumeMarkdown(task.inputs[0].summary);
    assert.equal(extracted.projectId, s.projectId);
    assert.equal(extracted.currentStage, s.currentStage);
    assert.equal(extracted.sourceIdentity, HASH2);
    assert.equal(extracted.unresolvedItems[0].id, 'save-bug');
    assert.ok(extracted.relevantPaths.includes('tests/save.spec.mjs'));
    assert.equal(extracted.nextRecommendedAction.kind, 'VERIFY');
    assert.ok(extracted.instructionPaths.includes('AGENTS.md'));
  }
});

test('strict malformed, oversize, unknown-field and unsafe-path boundaries', () => {
  assert.throws(() => deriveResume('{broken'));
  assert.throws(() => parseResume(' '.repeat(65_537)));
  assert.throws(() => parseResumeMarkdown('x'.repeat(262_145)));
  for (const unsafe of ['../escape', 'x/../../escape', '/absolute', 'x\\..\\escape', 'C:/drive', 'a//b', 'a/./b', '%2e%2e/escape', 'a\u0000b', 'CON/file', 'a/.. ']) {
    const s = buildFixture(); s.relevantPaths = [unsafe];
    assert.throws(() => deriveResume(s), undefined, unsafe);
  }
  for (const mutate of [s => { s.extra = true; }, s => { s.projectName = 'x'.repeat(101); }, s => { s.unresolvedItems = Array(17).fill({ id: 'x', summary: 'x' }); }, s => { s.currentRevision = 'UNKNOWN'; }, s => { s.lastOpenedAt = '2026-02-30T20:00:00.000Z'; }]) {
    const s = buildFixture(); mutate(s); assert.throws(() => deriveResume(s));
  }
  const cycle = buildFixture(); cycle.self = cycle; assert.throws(() => deriveResume(cycle));
  const getter = buildFixture(); Object.defineProperty(getter, 'projectName', { enumerable: true, get() { throw new Error('getter ran'); } });
  assert.throws(() => deriveResume(getter), /Unsafe JSON property/);
  const exotic = buildFixture(); Object.setPrototypeOf(exotic.relevantPaths, { toJSON() { throw new Error('toJSON ran'); } });
  assert.throws(() => deriveResume(exotic), /Expected plain JSON object/);
  const deep = buildFixture(); deep.extra = Array.from({length: 20}).reduce(value => ({ nested: value }), {});
  assert.throws(() => deriveResume(deep), /structural limit/);
  const wide = buildFixture(); wide.extra = Array(257).fill(null);
  assert.throws(() => deriveResume(wide), /Too many entries/);
  assert.throws(() => ResumeRecord.parse('{"__proto__":{}}'));
  assert.throws(() => deriveStudioResume(buildFixture()));
});

test('secret/token/reasoning/authority fields and obvious credential values are rejected', () => {
  for (const field of ['apiKey', 'oauthToken', 'cookies', 'hiddenReasoning', 'publishAuthorization', 'spendAuthority', 'executableTrust', 'commands']) {
    const s = buildFixture(); s[field] = 'canary'; assert.throws(() => deriveResume(s));
    const r = deriveResume(buildFixture()); r[field] = 'canary'; assert.throws(() => serializeResume(r));
    const setup = onboardingFixture(); setup[field] = 'canary'; assert.throws(() => createOnboarding(setup));
  }
  for (const value of ['api_key=synthetic-canary', 'Bearer synthetic-canary', 'cookie: synthetic-canary', 'oauth_token=synthetic-canary', 'sk-syntheticcanarynotreal', 'https://user:synthetic@example.test', '-----BEGIN PRIVATE KEY-----']) {
    const s = buildFixture(); s.projectName = value; assert.throws(() => deriveResume(s));
  }
  const input = buildFixture(); input.verification.binding.token = 'synthetic'; assert.throws(() => deriveResume(input));
});

test('all starting points work with zero optional connectors and manual agent', () => {
  for (const startingPoint of STARTING_POINTS) {
    const input = onboardingFixture(startingPoint), setup = createOnboarding(input);
    assert.equal(setup.readiness.state, 'READY');
    assert.deepEqual(setup.connectors, []);
    assert.equal(setup.product, ['IDEA', 'REPO'].includes(startingPoint) ? 'build' : startingPoint === 'APP_OR_RECORDING' ? 'studio' : 'grow');
    assert.deepEqual(OnboardingInput.parse(serializeOnboarding(input)), input);
  }
});

test('doctor does not upgrade detected/authenticated to verified; optional failure is optional', () => {
  for (const status of CONNECTION_STATES) {
    const s = onboardingFixture(); s.selectedAgentAdapterId = 'codex';
    s.doctor.checks.push({ id: 'codex', scope: 'AGENT', status, summary: 'Probe fact only.' });
    assert.equal(createOnboarding(s).readiness.state === 'READY', status === 'VERIFIED');
  }
  const s = onboardingFixture(); s.connectors = ['media'];
  s.doctor.checks.push({ id: 'media', scope: 'OPTIONAL_CONNECTOR', status: 'ERROR', summary: 'Not available.' });
  assert.equal(createOnboarding(s).readiness.state, 'READY');
  assert.equal(createOnboarding(s).readiness.optionalWarnings.length, 1);
  s.doctor.checks = []; assert.equal(createOnboarding(s).readiness.state, 'UNKNOWN');
});

test('recent project pointer remains inside configured root, including symlink targets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lf-resume-pointer-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'lf-resume-outside-'));
  try {
    await mkdir(path.join(root, 'local project', '.launchforge'), { recursive: true });
    await writeFile(path.join(root, 'local project', '.launchforge', 'resume.json'), '{}');
    const p = { schemaVersion: 1, id: 'p1', name: 'Local project', product: 'build', localPath: 'local project', lastOpenedAt: AT, resumePath: '.launchforge/resume.json' };
    assert.equal((await resolveRecentProjectPointer(p, root)).projectPath, path.join(await realpath(root), 'local project'));
    for (const patch of [{ localPath: '../outside' }, { localPath: outside }, { resumePath: '../outside.json' }, { credentials: 'canary' }]) assert.throws(() => RecentProjectPointer.parse({ ...p, ...patch }));
    await symlink(outside, path.join(root, 'escape'));
    await assert.rejects(resolveRecentProjectPointer({ ...p, localPath: 'escape' }, root));
    await symlink(outside, path.join(root, 'local project', 'link'));
    await assert.rejects(resolveRecentProjectPointer({ ...p, resumePath: 'link/resume.json' }, root));
    await symlink(path.join(root, 'local project', '.launchforge', 'resume.json'), path.join(root, 'local project', 'alias.json'));
    await assert.rejects(resolveRecentProjectPointer({ ...p, resumePath: 'alias.json' }, root));
    await assert.rejects(resolveRecentProjectPointer({ ...p, localPath: 'missing' }, root));
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('fresh process reopens JSON/Markdown and derives from current file facts, without product services', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lf-resume-restart-'));
  const moduleURL = new URL('../../integrations/resume/index.mjs', import.meta.url).href;
  try {
    for (const make of [buildFixture, studioFixture, growFixture]) {
      const state = make(), record = deriveResume(state), files = resumeFiles(record);
      for (const [name, content] of Object.entries(files)) await writeFile(path.join(root, name), content);
      await writeFile(path.join(root, 'normalized.json'), JSON.stringify(state));
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import {readFileSync} from 'node:fs';
        import {parseResume,parseResumeMarkdown,inspectResume} from ${JSON.stringify(moduleURL)};
        const json=parseResume(readFileSync('resume.json','utf8'));
        const md=parseResumeMarkdown(readFileSync('resume.md','utf8'));
        const check=inspectResume(json,JSON.parse(readFileSync('normalized.json','utf8')));
        if (JSON.stringify(json)!==JSON.stringify(md)||check.status!=='CURRENT') process.exit(2);
        process.stdout.write(check.record.nextRecommendedAction.kind);
      `], { cwd: root, encoding: 'utf8', timeout: 10_000 });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout, record.nextRecommendedAction.kind);
    }
    // Real file bytes change with no revision edit. The owner observes hashes on
    // every reopen, then the pure leaf consumes only those normalized facts.
    const bytes = Buffer.from('synthetic-output');
    await writeFile(path.join(root, 'output.bin'), bytes);
    const state = studioFixture(); const a = state.render.artifacts[0];
    a.expectedSha256 = a.observedSha256 = createHash('sha256').update(bytes).digest('hex');
    const cached = deriveResume(state);
    await writeFile(path.join(root, 'output.bin'), 'tampered-output');
    a.observedSha256 = createHash('sha256').update(await readFile(path.join(root, 'output.bin'))).digest('hex');
    assert.equal(inspectResume(cached, state).record.completionState, 'OUTPUT_STALE_OR_MISSING');
  } finally { await rm(root, { recursive: true, force: true }); }
});
