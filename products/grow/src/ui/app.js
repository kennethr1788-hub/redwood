import {learningView,bindLearning} from './learning.js';
import {researchView,bindResearch,topicView,bindTopics} from './research.js';
import {inputsView,selectionView,bindInputs} from './inputs.js';
import {growthPlanView,bindGrowthPlan} from './planner.js';
const $ = selector => document.querySelector(selector);
let project = null, tab = 'overview', busy = false;

const STEPS = [
  ['overview', '01', 'Overview', 'Your workspace'],
  ['audit', '02', 'Evidence', 'Audit evidence'],
  ['source', '03', 'Source proposal', 'Build handoff'],
  ['content', '04', 'Content', 'Article and FAQ'],
  ['planner', '05', 'Growth plan', 'Budget and evidence'],
  ['campaign', '06', 'Campaign', 'Creative studio'],
  ['delivery', '07', 'Export queue', 'Export'],
  ['inputs','+', 'Owned inputs','Facts and portable pack'],
  ['research','+', 'Query evidence','Offline import and research'],
  ['learning','+', 'Learning','Historical plan vs actual'],
];

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const fileUrl = rel => `/api/projects/${project.id}/files/${rel.split('/').map(encodeURIComponent).join('/')}`;
const link = (url, label) => /^https?:\/\//.test(url || '') ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(label || url)} ↗</a>` : esc(label || url);
const host = url => { try { return new URL(url).hostname; } catch { return ''; } };

const CONCEPT_TITLES = { spotlight: 'Spotlight', editorial: 'Editorial', signal: 'Signal' };
function conceptTitle(value) {
  if (!value) return '';
  const key = String(value).toLowerCase();
  return CONCEPT_TITLES[key] || String(value);
}

async function api(url, data) {
  const response = await fetch(url, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body;
}

function notice(message, error = false) {
  const node = $('#notice');
  node.textContent = message;
  node.className = message ? `notice ${error ? 'error' : ''}` : '';
}

async function act(action, input = {}, message = 'Working…') {
  if (busy) return;
  busy = true;
  notice(message);
  document.body.classList.add('busy');
  try {
    project = await api(`/api/projects/${project.id}/${action}`, input);
    render();
    await projects();
    notice(action === 'audit' && project.audit.status !== 'COMPLETE' ? `Audit ${project.audit.status}. Inspect coverage and collection details in Evidence.` : 'Saved to your workspace.');
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy = false;
    document.body.classList.remove('busy');
  }
}

async function projects() {
  const list = await api('/api/projects');
  $('#projects').innerHTML = list.map(item => `<button class="project-link ${project?.id === item.id ? 'selected' : ''}" data-project="${item.id}" type="button"><span class="project-icon">${esc(item.name.slice(0, 1).toUpperCase())}</span><span>${esc(item.name)}<small>${esc(host(item.url))}</small></span></button>`).join('') || '<p class="muted">Your projects will appear here.</p>';
  document.querySelectorAll('[data-project]').forEach(button => { button.onclick = () => open(button.dataset.project); });
}

async function open(id) {
  if (busy) return;
  try {
    project = await api(`/api/projects/${id}`);
    notice('');
    localStorage.setItem('grow-project', id);
    tab = 'overview';
    render();
    await projects();
  } catch (error) {
    notice(error.message, true);
  }
}

function badge(text, kind = '') {
  return `<span class="badge ${kind}">${esc(text)}</span>`;
}

function statusKind(value) {
  const status = String(value || '').toUpperCase();
  if (['COMPLETE', 'EXPORTED', 'APPLIED_RECHECKED', 'RENDERED', 'COMPARED', 'RESOLVED'].includes(status)) return 'good';
  if (['PARTIAL', 'NEW', 'DRAFT_REQUIRES_REVIEW'].includes(status)) return 'partial';
  if (status === 'FAILED') return 'failed';
  return '';
}

function stepState(id) {
  if (!project) return '';
  if (id === 'overview') return 'In workspace';
  if (id === 'audit') return project.audit?.status || 'Not run';
  if (id === 'source') return project.patchHandoff?.status || (project.patch ? 'Source proposal ready' : null) || (project.sourceDir ? 'Checkout selected' : 'No source checkout');
  if (id === 'content') return project.content ? 'Draft ready' : (project.audit ? 'No draft' : 'Audit or owned inputs');
  if (id === 'planner') return project.growthPlan ? 'Saved locally' : 'Plan first';
  if (id === 'campaign' && project.campaign?.stale) return 'STALE · reseed';
  if (id === 'campaign') return project.render ? 'Rendered' : (project.campaign?.confirmed ? 'Brief saved' : 'Review');
  if (id === 'delivery') {
    if (!project.exports?.length) return 'Empty';
    return project.exports.some(item => item.publishedAt) ? 'Publication recorded' : 'Not published';
  }
  return '';
}

function pathNav() {
  return `<nav class="path" aria-label="Workspace sections">${STEPS.map(([id, num, name, sub]) => `<button type="button" data-tab="${id}" title="${esc(sub)}${stepState(id) ? ` · ${esc(stepState(id))}` : ''}" class="step ${tab === id ? 'is-current' : ''}" ${tab === id ? 'aria-current="step"' : ''}><span class="step-num" aria-hidden="true">${num}</span><span class="step-name">${name}</span><span class="step-sub" aria-hidden="true">${sub}</span><span class="step-state" aria-hidden="true">${esc(stepState(id))}</span></button>`).join('')}</nav>`;
}

function render() {
  const focusedSection = document.activeElement?.dataset.tab;
  if (!project) {
    $('#breadcrumb').textContent = 'Your next launch starts here';
    $('#view').innerHTML = `<section class="welcome"><div class="welcome-copy"><div class="eyebrow">Plan, prepare, review, export</div><h1>Start with your product.<br><i>Leave with the work that grows it.</i></h1><p>Start with a growth plan or owned inputs, or audit a site you trust. Grow prepares source proposals for a reviewed Build handoff, content, campaign assets and local exports. Build implements source changes; return to Grow to recheck. Export is not publication.</p><button class="primary" id="welcome-create" type="button">Start a growth workspace <span aria-hidden="true">↗</span></button><ol class="welcome-flow"><li><span>01</span><b>Your workspace</b><small>Plan first or bring owned inputs</small></li><li><span>02</span><b>Audit evidence</b><small>Optional · a site you own or trust</small></li><li><span>03</span><b>Source proposal</b><small>Review handoff → Build → recheck</small></li><li><span>04</span><b>Content</b><small>Article and FAQ</small></li><li><span>05</span><b>Growth plan</b><small>Budget and evidence</small></li><li><span>06</span><b>Campaign</b><small>Concepts, stills, motion</small></li><li><span>07</span><b>Export queue</b><small>Exported, not published</small></li></ol></div><div class="collage" aria-hidden="true"><article class="slip"><span>Evidence</span><strong>What the page actually says.</strong><em>Lab notes, not a rank.</em></article><article class="slip slip-forge"><span>Source proposal</span><strong>A diff you can review.</strong><em>Reviewed handoff. Build implements. Grow rechecks.</em></article><article class="slip"><span>Campaign</span><strong>Stills and a motion cut.</strong><em>Only the directions on the brief.</em></article><article class="slip slip-quiet"><span>Export</span><strong>A local bundle.</strong><em>Not published.</em></article></div></section>`;
    $('#welcome-create').onclick = () => $('#project-dialog').showModal();
    return;
  }
  $('#breadcrumb').textContent = `Workspace / ${project.name}`;
  const views = { learning:()=>learningView(project), research:()=>researchView(project,fileUrl)+topicView(project), inputs:()=>inputsView(project,fileUrl), planner:()=>growthPlanView(project,fileUrl), overview, audit, content, campaign, delivery, source };
  $('#view').innerHTML = `<section class="project-heading"><div><div class="eyebrow">Plan, prepare, review, export</div><h1>${esc(project.name)}</h1><p>${project.url ? link(project.url) : 'Plan first · no site audit requested'}</p></div><button class="secondary" id="run-audit" type="button">${project.audit ? '↻ Re-run audit' : '↗ Audit this site'}</button></section>${pathNav()}<section class="panel">${views[tab]()}</section>`;
  document.querySelectorAll('[data-tab]').forEach(button => { button.onclick = () => { tab = button.dataset.tab; render(); }; });
  $('#run-audit').onclick = runAudit;
  $('#run-audit').disabled = !project.url;
  bind();
  const currentStep = $('.step.is-current');
  if (focusedSection) currentStep.focus({ preventScroll: true });
  const path = $('.path');
  if (path.scrollWidth > path.clientWidth) {
    path.scrollLeft += currentStep.getBoundingClientRect().left - path.getBoundingClientRect().left - (path.clientWidth - currentStep.offsetWidth) / 2;
  }
}

function runAudit() {
  const approved = project.auditOptions?.trustedSite || confirm('Run browser scripts from this site? Continue only if you own or trust it. Hostile-site isolation is not qualified.');
  if (approved) act('audit', { trustedSite: true }, 'Running a fresh bounded Unlighthouse audit. Usually 1–3 minutes…');
}

function intakeFacts() {
  const options = project.auditOptions || {};
  return `<dl class="intake-facts"><div><dt>Product URL · optional</dt><dd>${project.url ? link(project.url) : 'Not supplied · planning is available'}</dd></div><div><dt>Browser audit</dt><dd>${options.trustedSite ? 'Consent recorded for this project' : 'Optional · consent required when requested'}</dd></div><div><dt>Source checkout</dt><dd>${project.sourceDir ? esc(project.sourceDir) : 'Not selected · optional for source proposals'}</dd></div><div><dt>Rendered DOM</dt><dd>${options.renderDom ? `Requested${options.readinessSelector ? ` · ${esc(options.readinessSelector)}` : ''}` : project.audit ? 'Not requested · raw HTML only' : 'Not requested'}</dd></div></dl>`;
}

function overview() {
  const auditRun = project.audit;
  return `<div class="section-title"><div><div class="eyebrow">Your growth workspace</div><h2>Choose the work you need.</h2></div>${badge(auditRun?.status || 'READY TO START', statusKind(auditRun?.status))}</div>${intakeFacts()}<div class="moves"><button type="button" data-go="audit"><span>02 / Audit evidence</span><h3>${auditRun ? esc(auditRun.status) : 'Not run'}</h3><p>${auditRun ? `${auditRun.pages.length} pages inspected · ${auditRun.findings.length} findings` : project.url ? 'Optionally run a bounded audit of the product URL.' : 'Optional · add a product URL to audit a site.'}</p></button><button type="button" data-go="source"><span>03 / Source proposal</span><h3>${project.sourceDir ? 'Source checkout selected' : 'Source is optional'}</h3><p>${project.patchHandoff ? esc(project.patchHandoff.status) : 'Grow prepares. Build implements.'}</p></button><button type="button" data-go="content"><span>04 / Content</span><h3>${project.content ? 'Article and FAQ' : 'Waiting'}</h3><p>Editable article, source-linked FAQ, and content notes.</p></button><button type="button" data-go="campaign"><span>06 / Campaign</span><h3>${(project.campaign?.variants || []).length || 'No'} direction${(project.campaign?.variants || []).length === 1 ? '' : 's'}</h3><p>${project.render ? 'Rendered stills and motion are in Campaign.' : 'Confirm the brief, then render what it contains.'}</p></button><button type="button" data-go="delivery"><span>07 / Export queue</span><h3>${project.exports?.length ? 'EXPORTED' : 'Not exported'}</h3><p>${project.exports?.some(item => item.publishedAt) ? 'A publication is recorded.' : 'Not published. This workspace only exports local bundles.'}</p></button></div><div class="honesty"><b>Readiness is not ranking.</b><p>This workspace reports crawler evidence and suggestions. It does not measure whole-market visibility or guarantee inclusion in any answer engine.</p></div><div class="evidence-types"><span class="observed">● Crawler evidence ${auditRun?.pages?.length ? 'available' : 'not collected'}</span><span>○ Consumer answers not supplied</span><span>○ API / synthetic samples not supplied</span><span>○ Search Console / referrals not supplied</span></div>`;
}

function prioritizedFindings(findings) {
  const rank = { warning: 0, info: 1 };
  return [...(findings || [])].sort((a, b) => (rank[a.severity] ?? 2) - (rank[b.severity] ?? 2));
}

function audit() {
  const auditRun = project.audit;
  if (!auditRun) return empty('Start with what’s actually there.', 'Run the site audit to collect HTML evidence, robots and sitemap checks.');
  const engine = auditRun.engine === 'UNLIGHTHOUSE_CLI_BUNDLED_LIGHTHOUSE' ? 'Unlighthouse + bundled Lighthouse' : (auditRun.engine || 'Legacy HTML evidence');
  return `<div class="section-title"><div><div class="eyebrow">Audit evidence</div><h2>What was collected, and what was not.</h2></div>${badge(auditRun.status, statusKind(auditRun.status))}</div><p class="lede-note">${esc(auditRun.createdAt)} · ${esc(engine)} · Up to 3 routes · ${project.auditOptions?.renderDom ? 'Rendered DOM requested' : 'Raw HTML extraction'}</p><p class="status-readout"><b>${esc(auditRun.status)}</b> ${auditRun.status === 'COMPLETE' ? 'means this bounded run produced its expected evidence, not that the site is finished or ranked.' : auditRun.status === 'PARTIAL' ? 'means coverage or collection stopped short. Read the missing routes and errors before treating a finding as site-wide.' : auditRun.status === 'FAILED' ? 'means this run did not produce usable audit evidence. It does not prove a fix or a failure of the product.' : 'is the status recorded for this run.'}</p>${auditRun.errors?.length ? `<div class="error-box"><b>Collection issues</b><pre>${esc(JSON.stringify(auditRun.errors, null, 2))}</pre></div>` : ''}<h3 class="block-label">Prioritized findings</h3><div class="findings">${prioritizedFindings(auditRun.findings).map((finding, index) => `<article class="finding"><div>${badge(finding.severity, finding.severity === 'warning' ? 'partial' : '')} <b>${esc(finding.rule)}</b> <span class="finding-index" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span></div><h3>${esc(finding.message)}</h3><p>${esc(finding.recommendation)}</p><p class="finding-url">${link(finding.url)}</p><details><summary>Inspect evidence</summary><pre>${esc(typeof finding.evidence === 'string' ? finding.evidence : JSON.stringify(finding.evidence, null, 2))}</pre></details></article>`).join('') || '<p>No findings returned. Check collection status before drawing conclusions.</p>'}</div><h3 class="block-label">Page inventory</h3><div class="inventory">${auditRun.pages.map(page => `<div><b>${esc(page.title || 'Untitled page')}</b>${link(page.url)}<span class="page-pills">${badge(String(page.status))} ${page.evidenceMode ? badge(page.evidenceMode) : ''}</span></div>`).join('')}</div><details class="fold"><summary>Robots, sitemap and crawl limits</summary><pre>${esc(JSON.stringify({ resources: auditRun.resources, limits: auditRun.limits }, null, 2))}</pre></details>${labEvidence(auditRun)}`;
}

function metaText(meta, key) {
  if (!meta || !(key in meta)) return 'Not captured';
  const value = meta[key];
  if (Array.isArray(value)) return value.length ? value.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join(' · ') : 'Absent';
  if (value === null || value === undefined || value === '') return 'Absent';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function rawRendered(page) {
  const rows = ['title', 'description'];
  if (page.rawMetadata?.canonical !== undefined || page.renderedMetadata?.canonical !== undefined) rows.push('canonical');
  return `<article class="page-evidence"><header><h3>${esc(page.title || page.url)}</h3><p>${link(page.url)} ${badge(page.evidenceMode || 'RAW_HTML')}</p></header><table><thead><tr><th>Field</th><th>Raw HTML</th><th>Rendered DOM</th></tr></thead><tbody>${rows.map(key => `<tr><th>${esc(key)}</th><td>${esc(metaText(page.rawMetadata, key))}</td><td>${page.renderedMetadata ? esc(metaText(page.renderedMetadata, key)) : 'Not captured'}</td></tr>`).join('')}</tbody></table><p class="hash-row"><span>Raw ${esc(page.rawSha256 || 'not hashed')}</span><span>Rendered ${esc(page.renderedSha256 || 'not captured')}</span></p><details><summary>Full raw and rendered record</summary><pre>${esc(JSON.stringify({ url: page.url, rawSha256: page.rawSha256, renderedSha256: page.renderedSha256, xRobotsTag: page.xRobotsTag, raw: page.rawMetadata, rendered: page.renderedMetadata }, null, 2))}</pre></details></article>`;
}

function labEvidence(auditRun) {
  const lab = auditRun.lab;
  if (!lab) return '<p class="muted">This saved run predates the selected lab runner. Re-run the audit for native Lighthouse evidence.</p>';
  const comparison = auditRun.recheck;
  return `<section class="lab-evidence"><div class="section-title"><div><div class="eyebrow">Native Lighthouse</div><h2>Lighthouse lab evidence</h2></div>${badge(lab.status, statusKind(lab.status))}</div><p class="lede-note">One desktop sample per observed route. Scores are lab observations, not field data, ranking, or answer-engine inclusion. A route cap and collection issues limit coverage.</p>${auditRun.claimBoundary ? `<p class="honesty">${esc(auditRun.claimBoundary)}</p>` : ''}<details class="fold"><summary>Run provenance and coverage</summary><pre>${esc(JSON.stringify({ runId: auditRun.runId, sourceRevision: auditRun.sourceRevision, expectedRoutes: lab.expectedRoutes, observedRoutes: lab.observedRoutes, limits: auditRun.limits, warnings: lab.runWarnings }, null, 2))}</pre></details>${(lab.reports || []).map(report => `<article class="finding native-report"><h3>${link(report.url)}</h3><p class="muted">Lighthouse ${esc(report.version)} · ${esc(report.fetchTime)} · ${esc(report.sha256)}</p>${report.runtimeError ? `<div class="error-box">${esc(JSON.stringify(report.runtimeError))}</div>` : ''}<dl class="score-ledger">${(report.categories || []).map(category => `<div><dt>${esc(category.title || category.id)}</dt><dd>${typeof category.score === 'number' ? Math.round(category.score * 100) : 'Not scored'}</dd></div>`).join('')}</dl>${report.relativeArtifact ? `<a class="download" href="${fileUrl(report.relativeArtifact)}" download>Download native report JSON ↓</a>` : ''}<details><summary>Prioritized native findings</summary>${prioritizedObservations(report.observations).map(item => `<div class="observation"><h4>${esc(item.title)}</h4><p>${esc(item.id)} · ${item.score === null || item.score === undefined ? 'Not scored' : esc(item.score)} · ${esc(item.scoreDisplayMode)}</p><p>${esc(item.description)}</p>${item.details ? `<pre>${esc(JSON.stringify(item.details, null, 2))}</pre>` : ''}</div>`).join('') || '<p>No non-passing observations in this report.</p>'}</details></article>`).join('')}<h3 class="block-label">Raw and rendered page evidence</h3><div class="page-evidence-list">${auditRun.pages.map(rawRendered).join('')}</div>${comparison ? `<div class="honesty recheck"><h3>Before / after recheck</h3>${badge(comparison.status, statusKind(comparison.status))}<p>${esc(comparison.limitation)}</p>${comparison.changes?.length ? comparison.changes.map(change => `<p class="change-row"><b>${esc(change.id)}: ${esc(change.before)} → ${esc(change.after)} · ${esc(change.outcome)}</b><br>${link(change.url)}</p>`).join('') : '<p>No comparable numeric finding changes observed. This does not mean every finding is fixed.</p>'}<details><summary>Comparison provenance</summary><pre>${esc(JSON.stringify(comparison, null, 2))}</pre></details></div>` : ''}<details class="fold"><summary>Retained run files</summary>${(auditRun.artifacts || []).map(file => `<p><a href="${fileUrl(file.relativePath)}" download>${esc(file.name)} ↓</a></p>`).join('') || '<p>No extra run files were retained.</p>'}</details></section>`;
}

function prioritizedObservations(observations) {
  return [...(observations || [])].filter(item => item.score !== 1).sort((a, b) => {
    const left = typeof a.score === 'number' ? a.score : 2;
    const right = typeof b.score === 'number' ? b.score : 2;
    return left - right;
  });
}

function content() {
  if (!project.content) return empty('A useful story begins with evidence.', 'Audit a site first to prepare a source-backed editable draft.');
  const draft = project.content;
  return `<div class="section-title"><div><div class="eyebrow">Article and FAQ</div><h2>A starting point, with sources.</h2></div>${badge(draft.status || 'DRAFT · REVIEW REQUIRED', statusKind(draft.status) || 'partial')}</div><div class="editor-grid"><form id="article-form"><label class="sr-only" for="article">Article Markdown</label><textarea id="article" name="markdown" class="article-editor">${esc(project.article)}</textarea><div class="button-row"><button class="primary" type="submit">Save article</button><a class="secondary" href="${fileUrl('content/article.md')}" download>Download Markdown ↗</a></div></form><div class="editor-side"><h3>FAQ from the source</h3>${(draft.faq || []).map(item => `<article class="qa"><h4>${esc(item.question)}</h4><p>${esc(item.answer)}</p>${link(item.sourceUrl, 'Source')}</article>`).join('') || '<p>No FAQ entries were drafted.</p>'}<h3>Content opportunities</h3>${(draft.suggestions || []).map(item => `<article><h4>${esc(item.title)}</h4><p>${esc(item.detail)}</p>${link(item.sourceUrl, 'Evidence')}</article>`).join('')}</div></div><details class="fold"><summary>Use your existing coding tool</summary><p>Open this local folder in your official tool. Draft Markdown there, then paste it into this editor and save. Provider login and billing stay with your tool.</p><pre>${esc(project.workspacePath)}</pre><a href="${fileUrl('README.md')}" download>Download project guide</a></details><details class="fold"><summary>Structured-data recommendation · verify before applying</summary><p>${esc(draft.schemaNote || '')}</p><pre>${esc(JSON.stringify(draft.jsonLd, null, 2))}</pre></details>`;
}

function directionName(index, files) {
  const fromFile = files.find(file => file.concept)?.concept;
  const variant = project.campaign?.variants?.[Number(index) - 1];
  const raw = fromFile || variant?.concept;
  if (raw) return conceptTitle(raw);
  if (index === 'other') return 'Other stills';
  return `Direction ${index}`;
}

function assetGroups(files) {
  const images = files.filter(file => file.type === 'image');
  const videos = files.filter(file => file.type === 'video');
  const sources = files.filter(file => file.type !== 'image' && file.type !== 'video');
  const groups = new Map();
  for (const file of images) {
    const match = /^campaign-(\d+)-/i.exec(file.name || '');
    const key = file.variant || (match ? Number(match[1]) : 'other');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(file);
  }
  return { images, videos, sources, groups: [...groups.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true })) };
}

function campaign() {
  const brief = project.campaign;
  if (!brief) return empty('Make something worth sharing.', 'Use reviewed Owned inputs, save a Growth plan, or audit your product to seed creative.');
  if(brief.stale)return `<div class="honesty"><h2>Creative is stale.</h2><p>Inputs changed. Previous renders and exports remain historical. Seed from the current inputs, review and render again.</p><button type="button" class="primary" data-go="${brief.inputRevision?'inputs':'planner'}">Open current inputs ↗</button></div>`;
  const directions = brief.variants || [];
  const rendered = project.render ? assetGroups(project.render.files || []) : null;
  const summary = rendered
    ? `${rendered.groups.length} rendered direction${rendered.groups.length === 1 ? '' : 's'} · ${rendered.images.length} static image${rendered.images.length === 1 ? '' : 's'} · ${motionPhrase(rendered.videos[0])}`
    : `${directions.length} copy direction${directions.length === 1 ? '' : 's'} on this brief`;
  const names = directions.map((variant, index) => variant.concept ? conceptTitle(variant.concept) : `Direction ${index + 1}`);
  return `<div class="section-title"><div><div class="eyebrow">Campaign</div><h2>One product. The directions on this brief.</h2></div>${badge(brief.confirmed ? 'BRAND CONFIRMED' : 'REVIEW BRAND', brief.confirmed ? 'good' : 'partial')}</div><div class="studio-grid"><form id="campaign-form" class="brand-form"><label>Brand name<input name="brandName" value="${esc(brief.brandName)}" maxlength="100"></label><label>Product summary<textarea aria-label="Product summary" name="summary" maxlength="500">${esc(brief.summary)}</textarea></label><label>Headline<input name="headline" value="${esc(brief.headline)}" maxlength="100" ${(brief.planRevision||brief.inputRevision)?'readonly':''}></label><label>Body copy<textarea aria-label="Body copy" name="body" maxlength="500" ${(brief.planRevision||brief.inputRevision)?'readonly':''}>${esc(brief.body)}</textarea></label><div class="fields"><label>Call to action<input name="cta" value="${esc(brief.cta)}" maxlength="50" ${(brief.planRevision||brief.inputRevision)?'readonly':''}></label><label>Brand color<input name="color" type="color" value="${esc(brief.color)}"></label></div><label>Destination URL<input name="url" type="url" value="${esc(brief.url)}" ${(brief.planRevision||brief.inputRevision)?'readonly':''} required></label>${(brief.planRevision||brief.inputRevision)?'<p class="muted">Edit the destination in its Growth Plan or Owned inputs, then save and reseed to keep tracking aligned.</p>':''}${(brief.planRevision||brief.inputRevision)?`<details class="fold"><summary>Three message angles · edit headline, body and CTA</summary>${directions.map((v,i)=>`<fieldset><legend>${esc(conceptTitle(v.concept))}</legend><label>Angle ${i+1} headline<input name="angle-headline-${i}" value="${esc(v.headline)}" maxlength="92" required></label><label>Angle ${i+1} body<textarea name="angle-body-${i}" maxlength="240" required>${esc(v.body)}</textarea></label><label>Angle ${i+1} CTA<input name="angle-cta-${i}" value="${esc(v.cta)}" maxlength="32" required></label></fieldset>`).join('')}</details>`:''}<label>Local brand image <small>Optional · PNG, JPEG, WebP · 10 MB max</small><input name="assetPath" placeholder="${brief.inputRevision?'Edit assets in Owned inputs':'/absolute/path/to/owned-image.png'}" ${brief.inputRevision?'disabled':''}></label><label class="check"><input name="confirmed" type="checkbox" ${brief.confirmed ? 'checked' : ''}> I reviewed these product claims and have rights to the selected assets.</label><button class="secondary" type="submit">Save reviewed creative brief</button></form><div class="creative-output"><div class="creative-toolbar"><div><b>Campaign collection</b><small>${esc(summary)}</small><small>${names.length ? esc(names.join(' · ')) : 'No directions yet'}</small></div><button class="primary" id="render" type="button" ${!brief.confirmed ? 'disabled' : ''}>Render assets ↗</button></div>${directions.length ? `<ol class="direction-list">${directions.map((variant, index) => `<li><span>${esc(names[index])}</span><strong>${esc(variant.headline || '')}</strong><em>${esc(variant.cta || '')}</em></li>`).join('')}</ol>` : ''}${rendered ? conceptBoard(rendered) : `<div class="render-empty"><span>↗</span><h3>Your next campaign lives here.</h3><p>Confirm the brand and copy, then render the directions on this brief. A third concept appears only when the brief or the render contains it.</p></div>`}</div></div>${selectionView(project)}`;
}

function motionPhrase(file) {
  if (!file) return 'no motion file';
  const bits = ['motion file'];
  if (typeof file.duration === 'number') bits[0] = `${file.duration}s motion`;
  if (file.width && file.height) bits.push(`${file.width}×${file.height}`);
  if (file.audio === false) bits.push('silent');
  return bits.join(' · ');
}

function conceptBoard(rendered) {
  const poster = project.render.files.find(file => file.name === 'campaign-1-story.png') || rendered.images.find(file => /-story\.png$/i.test(file.name || ''));
  const board = rendered.groups.map(([index, files]) => `<section class="concept-card"><h3>${esc(directionName(index, files))}</h3><p>${files.map(file => esc(file.name)).join(' · ')}</p></section>`).join('');
  const figures = rendered.images.map(file => `<figure><img src="${fileUrl(file.relativePath)}" alt="${esc(file.name)}"><figcaption>${esc(file.name)} <a href="${fileUrl(file.relativePath)}" download>↓</a></figcaption></figure>`).join('');
  const video = rendered.videos.map(file => `<figure class="motion-figure"><video controls preload="metadata" ${poster?.relativePath ? `poster="${fileUrl(poster.relativePath)}"` : ''} src="${fileUrl(file.relativePath)}"></video><figcaption>${esc(file.name)} · ${esc(motionPhrase(file))} <a href="${fileUrl(file.relativePath)}" download>↓</a></figcaption></figure>`).join('');
  const sources = rendered.sources.length ? `<div class="source-files"><h3>Editable sources</h3>${rendered.sources.map(file => `<a class="download" href="${fileUrl(file.relativePath)}" download>${esc(file.name)} ↓</a>`).join('')}</div>` : '';
  return `<div class="concept-board">${board}</div><div class="asset-grid">${figures}${video}</div>${sources}`;
}

function delivery() {
  const queue = project.exports || [];
  return `<div class="section-title"><div><div class="eyebrow">Export queue</div><h2>Export the work. Keep publication separate.</h2></div>${badge('EXPORT FIRST')}</div><div class="export-intro"><p>Package the reviewed copy, article, and rendered assets with a planning time. The bundle is EXPORTED. A calendar time does not publish it.</p><form id="export-form"><label>Calendar time <small>Your browser’s local timezone</small><input type="datetime-local" name="scheduledAt" required value="${new Date(Date.now() - new Date().getTimezoneOffset() * 60000 + 86400000).toISOString().slice(0, 16)}"></label><button class="primary" type="submit" ${!project.render || project.render.stale || (project.campaign?.inputRevision&&(!project.preflight?.localExportReady||project.preflight.stale)) ? 'disabled' : ''}>Build export bundle ↗</button></form></div><div class="queue">${queue.map(item => `<article><div class="export-truth">${badge(item.status, statusKind(item.status))} ${badge(item.publishedAt ? 'PUBLISHED' : 'NOT PUBLISHED', item.publishedAt ? 'good' : 'hold')}</div>${item.stale?badge('STALE · HISTORICAL EXPORT','partial'):''}<h3>Campaign export</h3><p><time>${esc(item.scheduledAt || '')}</time></p><p class="mono">${esc(item.directory || item.outputDir || item.path || '')}</p><p>${item.publishedAt ? `Publication recorded at ${esc(item.publishedAt)}.` : 'Status is EXPORTED. Not published or scheduled on a social network.'}</p><ul class="file-ledger" aria-label="Export files">${(item.files || []).map(file => file.relativePath ? `<li><a href="${fileUrl(file.relativePath)}" download><span>${esc(file.name)}</span><span aria-hidden="true">↓</span></a></li>` : '').join('')}</ul></article>`).join('') || '<div class="empty"><h3>No exports yet.</h3><p>Render the campaign to unlock the export bundle.</p></div>'}</div>`;
}

function source() {
  if (!project.sourceDir) return empty('Source is optional. Ownership isn’t.', 'Select a source checkout to prepare an exact proposal for Build or your coding tool. You can start a growth plan or bring owned inputs without source or an audit.');
  const first = project.audit?.pages?.[0];
  if (!first) return empty('Audit first, patch second.', 'Collect evidence before making a source recommendation.');
  return `<div class="section-title"><div><div class="eyebrow">Source · review before handoff</div><h2>A proposal you control.</h2></div>${badge('STATIC HTML ADAPTER')}</div><p class="mono">${esc(project.sourceDir)}/index.html</p><p>Review this proposed change, then implement it through Build or your coding tool. Grow has not changed the source.</p><form id="patch-form" class="patch-form"><label>Title<input name="title" value="${esc(first.title || project.name)}" required></label><label>Meta description<input name="description" value="${esc(first.description || project.campaign?.summary || '')}" required></label><label>Canonical URL<input type="url" name="canonical" value="${esc(project.url)}" required></label><label class="check"><input name="includeJsonLd" type="checkbox"> Include the reviewed structured-data recommendation</label><button class="secondary" type="submit">Create candidate diff</button></form>${project.patch ? `<div class="diff"><h3>Source proposal ready</h3><p>Review the exact change</p><pre>${esc(project.patch.diff)}</pre><button id="prepare-patch-handoff" class="primary" type="button">Prepare reviewed handoff</button><p class="muted">Bound to the selected file’s current hash and base commit. Changed source requires a new proposal and review.</p></div>` : ''}${project.patchHandoff ? `<div class="honesty"><b>${esc(project.patchHandoff.status)}</b><p>${esc(project.patchHandoff.message)}</p>${project.patchHandoff.status === 'HANDOFF_READY' ? `<label>Implementation handoff<textarea readonly rows="16">${esc(project.patchHandoff.prompt)}</textarea></label><a class="download" href="${fileUrl(`patches/${project.patch.id}.json`)}" download>Download exact proposal ↓</a>` : ''}</div>` : ''}${project.patchResult ? `<details><summary>Historical source-application receipt</summary><p>This receipt records an earlier Grow version. Current Grow does not apply source changes.</p><pre>${esc(JSON.stringify(project.patchResult, null, 2))}</pre></details>` : ''}<button id="recheck-site" class="secondary" type="button">Recheck audited site</button>`;
}

function empty(title, body) {
  return `<div class="empty"><span aria-hidden="true">↗</span><h2>${title}</h2><p>${body}</p></div>`;
}

function bind() {
  bindLearning(project,act);
  bindResearch(project,act);
  bindTopics(project,act);
  bindInputs(project,act,destination=>{tab=destination;render();});
  bindGrowthPlan(act,async()=>{await act('seed-creative',{},'Seeding your plan into Campaign…');if(project.campaign?.planRevision===project.growthPlan?.revision&&!project.campaign?.stale){tab='campaign';render();}});
  if ($('#recheck-site')) $('#recheck-site').onclick = () => { tab = 'audit'; runAudit(); };
  document.querySelectorAll('[data-go]').forEach(button => { button.onclick = () => { tab = button.dataset.go; render(); }; });
  if ($('#article-form')) $('#article-form').onsubmit = event => { event.preventDefault(); act('article', { markdown: $('#article').value }); };
  if ($('#campaign-form')) $('#campaign-form').onsubmit = event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    data.confirmed = event.target.confirmed.checked;
    if(project.campaign.planRevision||project.campaign.inputRevision)data.variants=project.campaign.variants.map((v,i)=>({...v,headline:data['angle-headline-'+i],body:data['angle-body-'+i],cta:data['angle-cta-'+i]}));
    act('campaign', data);
  };
  if ($('#render')) $('#render').onclick = () => act('render', {}, 'Rendering static formats and a motion campaign locally…');
  if ($('#export-form')) $('#export-form').onsubmit = event => { event.preventDefault(); act('export', { scheduledAt: new Date(event.target.scheduledAt.value).toISOString() }, 'Packaging assets, copy and calendar…'); };
  if ($('#patch-form')) $('#patch-form').onsubmit = event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    data.includeJsonLd = event.target.includeJsonLd.checked;
    act('propose-patch', data);
  };
  if ($('#prepare-patch-handoff')) $('#prepare-patch-handoff').onclick = () => {
    if (confirm('Have you reviewed this exact diff? Prepare an inert handoff for Build or your coding tool. Grow will not change the source.')) act('prepare-patch-handoff', { approvedHash: project.patch.hash }, 'Checking proposal and preparing handoff…');
  };
}

function syncIntakeMode() {
  const form = $('#create-form');
  const auditing = !form.planOnly.checked;
  form.url.required = auditing;
  form.trustedSite.required = auditing;
  if (!auditing) form.trustedSite.checked = false;
  $('#intake-url-label').textContent = auditing ? 'Product URL · required for audit' : 'Product URL · optional';
  document.querySelectorAll('.audit-intake').forEach(group => {
    group.hidden = !auditing;
    group.querySelectorAll('input').forEach(input => { input.disabled = !auditing; });
  });
}
$('#create-form').planOnly.onchange = syncIntakeMode;
$('#new-project').onclick = () => { if (!busy) $('#project-dialog').showModal(); };
$('#close-dialog').onclick = () => $('#project-dialog').close();
$('#create-form').onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  try {
    const input = Object.fromEntries(new FormData(event.target));
    input.planOnly = event.target.planOnly.checked;
    input.trustedSite = !input.planOnly && event.target.trustedSite.checked;
    input.renderDom = !input.planOnly && event.target.renderDom.checked;
    project = await api('/api/projects', input);
    localStorage.setItem('grow-project', project.id);
    $('#project-dialog').close();
    event.target.reset();
    syncIntakeMode();
    tab = input.planOnly?(input.entry==='inputs'?'inputs':'planner'):'overview';
    render();
    await projects();
    if(!input.planOnly)await act('audit', {}, 'Running a bounded Unlighthouse audit. Usually 1–3 minutes; keep this workspace open…');
  } catch (error) {
    notice(error.message, true);
    $('#project-dialog').close();
  }
};

syncIntakeMode();
render();
await projects();
const last = localStorage.getItem('grow-project');
if (last) await open(last);
