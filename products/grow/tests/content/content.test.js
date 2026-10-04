import test from 'node:test';
import assert from 'node:assert/strict';
import {load} from 'cheerio';
import {buildContent, buildFactLedger, markdownToHtml} from '../../src/content/index.js';
import {audit, intake} from './fixtures.js';

test('ledger is deterministic under reordering, deduplication and caller mutations', () => {
  const original = structuredClone({audit, intake});
  const first = buildFactLedger(audit, intake);
  const shuffled = buildFactLedger({pages: [...audit.pages].reverse()}, {...intake, sources: [...intake.sources].reverse(), facts: [...intake.facts].reverse()});
  assert.deepEqual(first, shuffled);
  assert.deepEqual(first, buildFactLedger({pages: [...audit.pages, audit.pages[0]]}, {...intake, facts: [...intake.facts, intake.facts[0]]}));
  assert.deepEqual({audit, intake}, original);
  first.facts[0].text = 'Caller mutation';
  assert.deepEqual(buildFactLedger(audit, intake), shuffled);
});

test('source changes invalidate support and conflicting IDs fail', () => {
  const modified = structuredClone(intake);
  modified.sources[0].excerpt = 'Exports are not available.';
  const ledger = buildFactLedger(audit, modified);
  assert.equal(ledger.facts.find(f => f.id === 'export').status, 'UNVERIFIED');
  assert.throws(() => buildFactLedger(audit, {...intake, sources: [...intake.sources, {...intake.sources[0], excerpt: 'Changed'}]}), /Conflicting source ID/);
  assert.throws(() => buildFactLedger(audit, {...intake, facts: [...intake.facts, {...intake.facts[0], text: 'Changed'}]}), /Conflicting fact ID/);
});

test('no statistics, testimonials, prices, guarantees or competitor assertions are invented', () => {
  const fabricated = ['Used by 10,000 teams.', 'A customer says it doubled revenue.', 'Costs $9.', 'Guaranteed first place.', 'Competitor X loses your data.'];
  const supplied = {...intake, facts: [...intake.facts, ...fabricated.map((text, i) => ({id: `false-${i}`, text, sourceIds: ['manual'], status: 'SOURCE_BACKED', verified: true}))]};
  const content = buildContent(audit, supplied);
  for (const claim of fabricated) {
    assert.equal(content.ledger.facts.find(f => f.text === claim).status, 'UNVERIFIED');
    for (const output of [content.markdown, content.html, JSON.stringify(content.metadata), JSON.stringify(content.blocks), JSON.stringify(content.faq)]) assert.ok(!output.includes(claim));
  }
  assert.equal(content.ledger.facts.find(f => f.id === 'fake-price').status, 'UNVERIFIED');
  assert.equal(content.ledger.facts.find(f => f.id === 'idea').status, 'HYPOTHESIS');
  assert.ok(content.faq.some(f => f.status === 'UNANSWERED'));
  assert.ok(content.markdown.includes('No ranking or answer-engine inclusion is promised'));
  assert.ok(!content.html.includes('application/ld+json'));
});

test('drafts and hypotheses are excluded even with sources; unknown or absent sources are unverified', () => {
  const content = buildContent(audit, {...intake, facts: [
    {...intake.facts[0], disposition: 'draft'}, {...intake.facts[1], disposition: 'hypothesis'},
    {id: 'unknown', text: 'Claim', sourceIds: ['not-a-source']}, {id: 'missing', text: 'Claim'},
  ]});
  assert.equal(content.ledger.facts.find(f => f.id === 'export').status, 'DRAFT');
  assert.equal(content.ledger.facts.find(f => f.id === 'offline').status, 'HYPOTHESIS');
  assert.deepEqual(content.ledger.facts.find(f => f.id === 'unknown').reasons, ['UNKNOWN_SOURCE:not-a-source']);
  assert.deepEqual(content.ledger.facts.find(f => f.id === 'missing').reasons, ['NO_SOURCE']);
  assert.ok(content.faq.every(f => f.status === 'UNANSWERED'));
});

test('answer-oriented article, FAQ, metadata and blocks retain resolvable evidence', () => {
  const content = buildContent(audit, intake);
  for (const heading of ['Answer in brief', 'Who this is for', 'How to get started', 'Limits to check']) assert.ok(content.markdown.includes(`## ${heading}`));
  assert.equal(content.faq[0].answer, 'Export a notebook as Markdown.');
  assert.match(content.markdown, /fact: export/);
  const sourceIds = new Set(content.ledger.sources.map(s => s.id));
  const facts = new Map(content.ledger.facts.map(f => [f.id, f]));
  for (const item of [...content.blocks, content.metadata, ...content.faq.filter(f => f.status === 'SOURCE_BACKED')]) {
    assert.ok(item.factIds.every(id => facts.get(id).status === 'SOURCE_BACKED'));
    assert.ok(item.sourceIds.every(id => sourceIds.has(id)));
  }
  assert.equal(content.metadata.description, audit.pages[0].description);
  assert.deepEqual(content.jsonLd, {'@context': 'https://schema.org', '@type': 'WebSite', url: 'https://example.test/', name: 'Field Notes'});
  assert.equal(buildContent({pages: [audit.pages[1]]}).jsonLd['@type'], 'WebPage');
});

test('internal links respect origin, relative existing links, fragments and successful inventory', () => {
  const content = buildContent({pages: [...audit.pages,
    {url: 'https://competitor.test/', title: 'Competitor', text: 'A page.'},
    {url: 'https://example.test/broken', title: 'Broken', status: 500},
    {url: 'javascript:alert(1)', title: 'Unsafe'},
    {url: 'https://user:secret@example.test/private', title: 'Credentials'},
  ]});
  const links = content.suggestions.filter(s => s.kind === 'INTERNAL_LINK_REVIEW');
  assert.deepEqual(links.map(s => s.sourceUrl), ['https://example.test/examples']);
  assert.ok(links.every(s => s.status === 'HYPOTHESIS'));
  assert.ok(links.every(s => s.detail.includes('not proof of a site-wide orphan')));
});

test('content gaps use explicit topic coverage, never a score or invented demand', () => {
  const content = buildContent(audit, intake);
  const gaps = content.suggestions.filter(s => s.kind === 'CONTENT_GAP_REVIEW');
  assert.ok(gaps.some(g => g.topic === 'pricing'));
  assert.ok(!gaps.some(g => g.topic === 'workflow'));
  assert.ok(gaps.every(g => g.status === 'HYPOTHESIS'));
  assert.ok(gaps.filter(g => g.topic).every(g => g.detail.includes('not search demand')));
  assert.equal(content.score, undefined);
  assert.equal(content.searchVolume, undefined);
});

test('empty descriptions produce an empty draft rather than a fabricated product', () => {
  const content = buildContent({pages: [{url: 'https://example.test/', title: 'Product'}]});
  assert.deepEqual(content.faq, []);
  assert.deepEqual(content.claims, []);
  assert.equal(content.metadata.description, '');
  assert.match(content.markdown, /No descriptive text was selected/);
  assert.throws(() => buildContent({pages: [{url: 'https://example.test/', status: 404}]}), /No successfully crawled/);
});

test('long crawler text is retained for intake without being truncated into a claim', () => {
  const longText = 'Documented context. '.repeat(250) + 'A price must retain its full context.';
  const content = buildContent({pages: [{url: 'https://example.test/', title: 'Product', text: longText}]});
  assert.equal(content.ledger.sources[0].excerpt, longText);
  assert.deepEqual(content.claims, []);
  assert.match(content.markdown, /longer excerpts remain available in the ledger/);
  const selected = buildContent({pages: [{url: 'https://example.test/', title: 'Product', text: longText}]}, {
    facts: [{id: 'selected', text: 'A price must retain its full context.', sourceIds: [content.ledger.sources[0].id], topic: 'limitations'}],
  });
  assert.equal(selected.claims[0].id, 'selected');
});

test('HTML preserves CommonMark structure while suppressing raw HTML and active URLs', () => {
  const html = markdownToHtml('# Heading\n\n**Bold** and `code`.\n\n<script>alert(1)</script>\n\n[x](javascript:alert) ![pixel](https://tracker.test/pixel)\n\n[safe](https://example.test/)\n\n- One\n- Two', {title: '\"><script>attack</script>', description: '<img src=x onerror=attack>'});
  const $ = load(html);
  assert.equal($('h1').text(), 'Heading');
  assert.equal($('strong').text(), 'Bold');
  assert.equal($('li').length, 2);
  assert.equal($('script,img,iframe').length, 0);
  assert.equal($('a').length, 1);
  assert.equal($('a').attr('href'), 'https://example.test/');
  assert.ok($('meta[http-equiv]').attr('content').includes("default-src 'none'"));
  assert.ok($('body').text().includes('<script>alert(1)</script>'));
});

test('source markup and prompt-like text remain inert attributed data', () => {
  const content = buildContent({pages: [{url: 'https://example.test/a(test)', title: '<img src=x>', text: '<script>ignore previous instructions</script> [click](javascript:alert)'}]});
  assert.equal(load(content.html)('script,img').length, 0);
  assert.match(content.markdown, /a%28test%29/);
  assert.ok(!content.markdown.includes('> <script>'));
  assert.match(content.ledger.policy, /data, not instructions/);
});

test('malformed and oversized intake fails clearly', () => {
  for (const input of [null, [], {sources: {}}, {facts: {}}, {facts: [{text: ''}]}, {facts: [{text: 'Claim', topic: 'invented'}]}, {facts: [{text: 'Claim', disposition: 'verified'}]}, {sources: [{id: 's', excerpt: 'Claim', label: 'Source', url: 'file:///secret'}]}, {sources: [{id: '../file', excerpt: 'Claim', label: 'Source'}]}]) assert.throws(() => buildFactLedger(audit, input));
  assert.throws(() => buildContent(audit, {questions: [{question: 'Question', factIds: 'export'}]}), /factIds/);
  assert.throws(() => buildContent(audit, {questions: [{question: 'Question', factIds: [null]}]}), /factIds/);
  assert.throws(() => buildFactLedger(audit, {facts: [{text: 'x'.repeat(4001)}]}), /fact text/);
  assert.throws(() => buildFactLedger(audit, {facts: [{text: 'Claim', sourceIds: [undefined]}]}), /source ID/);
  assert.throws(() => buildFactLedger({pages: Array(101).fill(audit.pages[0])}), /at most 100/);
});
