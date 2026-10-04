import {recommendSchema} from './schema.ts';
import {buildFactLedger, clean, compare, successfulPages, text, TOPICS, urlOf} from './ledger.js';
import {md, mdUrl, markdownToHtml, validateMarkdown} from './markdown.js';

export {buildFactLedger} from './ledger.js';
export {markdownToHtml, validateMarkdown} from './markdown.js';

const questionsFor = name => ({
  overview: `What does the source say about ${name}?`,
  audience: `Who is ${name} for?`,
  capabilities: `What can you do with ${name}?`,
  workflow: `How do you use ${name}?`,
  limitations: `What limitations should you know about ${name}?`,
  pricing: `What pricing does the supplied source document?`,
});
const sectionNames = {overview: 'Answer in brief', audience: 'Who this is for', capabilities: 'What you can do', workflow: 'How to get started', limitations: 'Limits to check', pricing: 'Documented pricing'};

/** Build a deterministic editorial brief and extractive article. No model calls,
 * inferred demand, ranking scores or independent verification are implied.
 */
export function buildContent(audit, intake = {}) {
  const pages = successfulPages(audit);
  const primary = pages[0];
  if (!primary) throw new Error('No successfully crawled page is available for a source-backed draft.');
  const url = urlOf(primary.url), origin = new URL(url).origin;
  const heading = Array.isArray(primary.h1) ? primary.h1[0] : primary.h1;
  const name = clean(heading || primary.title).slice(0, 160) || new URL(url).hostname;
  const ledger = buildFactLedger(audit, intake);
  const sourceMap = new Map(ledger.sources.map(source => [source.id, source]));
  const eligible = ledger.facts.filter(fact => fact.status === 'SOURCE_BACKED');
  // Keep the entry-page answer first while making secondary-page ordering stable.
  const facts = [...eligible].sort((a, b) => {
    const primaryRank = fact => fact.sourceIds.some(id => sourceMap.get(id).url === url) ? 0 : 1;
    return primaryRank(a) - primaryRank(b) || compare(a.id, b.id);
  });
  const factMap = new Map(ledger.facts.map(fact => [fact.id, fact]));
  const citations = fact => fact.sourceIds.map(id => {
    const source = sourceMap.get(id);
    return source.url ? `[Source](${mdUrl(source.url)}) (source: ${md(id)})` : `Source: ${md(source.label)} (source: ${md(id)})`;
  }).join(' · ');
  const citationText = fact => `[fact: ${md(fact.id)}] ${citations(fact)}`;
  const defaults = questionsFor(name);
  const requested = intake.questions ?? [];
  if (!Array.isArray(requested) || requested.length > 50) throw new Error('Questions must contain at most 50 entries.');
  const faq = requested.length ? requested.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Invalid question.');
    const question = text(item.question, 'question', 300);
    if (!Array.isArray(item.factIds) || item.factIds.length > 20 || item.factIds.some(id => typeof id !== 'string')) throw new Error('Question factIds must be an array of at most 20 IDs.');
    const factIds = [...new Set(item.factIds)].sort(compare);
    const answerFacts = factIds.map(id => factMap.get(id));
    const supported = answerFacts.length && answerFacts.every(fact => fact?.status === 'SOURCE_BACKED');
    return {
      question, answer: supported ? answerFacts.map(fact => fact.text).join(' ') : 'Not established by the supplied facts. Add a source before answering.',
      factIds, sourceIds: supported ? [...new Set(answerFacts.flatMap(fact => fact.sourceIds))].sort(compare) : [],
      sourceUrl: supported ? sourceMap.get(answerFacts[0].sourceIds[0]).url : null,
      status: supported ? 'SOURCE_BACKED' : 'UNANSWERED',
      relevance: 'EDITOR_REVIEW_REQUIRED',
    };
  }) : facts.map((fact, i) => ({
    question: fact.topic === 'overview' && i > 0 ? `What does ${sourceMap.get(fact.sourceIds[0]).label} document?` : defaults[fact.topic],
    answer: fact.text, factIds: [fact.id], sourceIds: fact.sourceIds,
    sourceUrl: sourceMap.get(fact.sourceIds[0]).url, status: 'SOURCE_BACKED', relevance: 'EDITOR_REVIEW_REQUIRED',
  }));
  const questions = [...faq].sort((a, b) => compare(a.question, b.question));
  const suggestions = [];
  for (const topic of TOPICS) {
    if (!facts.some(fact => fact.topic === topic)) suggestions.push({
      title: defaults[topic], detail: `No source-backed ${topic} fact is classified in this intake. Add a relevant source or leave this question unanswered; this is a coverage hypothesis, not search demand or proof that the site lacks this content.`,
      sourceUrl: url, kind: 'CONTENT_GAP_REVIEW', topic, status: 'HYPOTHESIS',
    });
  }
  for (const item of questions.filter(item => item.status === 'UNANSWERED')) suggestions.push({
    title: item.question, detail: 'The selected fact IDs are missing, unsupported, draft or hypothetical. Supply evidence; do not fill the answer from general model knowledge.',
    sourceUrl: url, kind: 'CONTENT_GAP_REVIEW', status: 'HYPOTHESIS',
  });
  const existingLinks = new Set((Array.isArray(primary.links) ? primary.links : []).map(link => urlOf(typeof link === 'string' ? link : link?.url || link?.href, url)).filter(Boolean).map(link => link.split('#')[0]));
  const inventory = [...new Map(pages.map(page => [urlOf(page.url).split('#')[0], page])).entries()].sort(([a], [b]) => compare(a, b));
  for (const [target, page] of inventory) {
    if (target !== url.split('#')[0] && new URL(target).origin === origin && !existingLinks.has(target)) suggestions.push({
      title: `Consider linking to ${clean(page.title).slice(0, 100) || new URL(target).pathname}`,
      detail: 'This same-origin inventoried page was absent from the sampled entry-page links. Review relevance and choose a contextual placement; this is not proof of a site-wide orphan page.',
      sourceUrl: target, fromUrl: url, anchor: clean(page.title).slice(0, 100) || new URL(target).pathname,
      kind: 'INTERNAL_LINK_REVIEW', status: 'HYPOTHESIS',
    });
  }
  for (const page of pages) if (!clean(page.description)) suggestions.push({
    title: 'Draft a page-specific description', detail: 'No meta description was supplied for this sampled page. Summarize only documented content.',
    sourceUrl: urlOf(page.url), kind: 'METADATA_GAP', status: 'HYPOTHESIS',
  });
  const descriptionFact = facts.find(fact => fact.sourceIds.some(id => sourceMap.get(id).url === url)) || facts[0];
  const title = `${name}: a source-backed overview`;
  const metadata = {
    title, titleAlternatives: [name, `${name}: questions and answers`],
    description: descriptionFact?.text || '',
    factIds: descriptionFact ? [descriptionFact.id] : [],
    sourceIds: descriptionFact?.sourceIds || [],
    titleSourceUrl: url, status: 'DRAFT_REQUIRES_REVIEW',
    note: 'Titles reuse the observed page heading/title. Description is an exact excerpt. Edit for length and relevance; edits require claim review. No ranking or display length is guaranteed.',
  };
  const blocks = TOPICS.flatMap(topic => facts.filter(fact => fact.topic === topic).map(fact => ({
    type: 'answer', heading: sectionNames[topic], text: fact.text, topic,
    factIds: [fact.id], sourceIds: fact.sourceIds, status: 'SOURCE_BACKED',
  }))).concat(questions.filter(item => item.status === 'SOURCE_BACKED').map(item => ({
    type: 'faq', question: item.question, text: item.answer,
    factIds: item.factIds, sourceIds: item.sourceIds, status: item.status,
  })));
  const sections = TOPICS.flatMap(topic => {
    const grouped = facts.filter(fact => fact.topic === topic);
    return grouped.length ? [`## ${sectionNames[topic]}\n\n${grouped.map(fact => `> ${md(fact.text)}\n\n${citationText(fact)}`).join('\n\n')}`] : [];
  }).join('\n\n');
  const markdown = `# ${md(title)}\n\n_Draft for editorial review. Excerpts are source observations, not independently verified product claims._\n\n${sections || 'No descriptive text was selected for factual output. Add atomic source facts before drafting product claims; longer excerpts remain available in the ledger.'}\n\n## Questions and direct answers\n\n${faq.map(item => `### ${md(item.question)}\n\n${md(item.answer)}\n\n${item.status === 'SOURCE_BACKED' ? item.factIds.map(id => citationText(factMap.get(id))).join('\n\n') : '_UNANSWERED — evidence required._'}`).join('\n\n')}\n\n## Where to learn more\n\n${suggestions.filter(item => item.kind === 'INTERNAL_LINK_REVIEW').map(item => `- [${md(item.anchor)}](${mdUrl(item.sourceUrl)}) — editorial link suggestion; review relevance.`).join('\n') || 'No additional unlinked same-origin pages were found in the supplied inventory.'}\n\n## Before publishing\n\nConfirm source currency, factual accuracy, question relevance and rights to quoted text. Replace excerpts with reviewed prose and retain fact IDs. No ranking or answer-engine inclusion is promised.\n`;
  validateMarkdown(markdown);
  const jsonLd = recommendSchema(url, name);
  return {
    title, markdown, html: markdownToHtml(markdown, metadata), faq, suggestions, metadata, blocks, ledger, jsonLd,
    claims: facts.map(fact => ({...fact, sourceUrl: sourceMap.get(fact.sourceIds[0]).url})),
    status: 'DRAFT_REQUIRES_REVIEW', evidenceType: 'CRAWLER_OBSERVATION',
    schemaNote: `Proposed ${jsonLd['@type']} markup describes the observed URL only. FAQ blocks are editorial data, not automatic FAQPage markup or rich-result eligibility.`,
    limitations: ['Exact excerpts establish provenance, not truth, currency, rights or question relevance. Human review remains required.', 'Unsupported facts remain in the ledger and are excluded from article answers, metadata and structured blocks.', 'No search volume, competitor analysis, content score, answer-engine observations or performance lift was measured.'],
  };
}
