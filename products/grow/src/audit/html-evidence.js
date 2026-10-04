import {createHash} from 'node:crypto';
import {load} from 'cheerio';

export const digest = value => createHash('sha256').update(value).digest('hex');
const clean = (value = '') => value.replace(/\s+/g, ' ').trim();
export function httpUrl(value, base) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}
export const findingId = (rule, url, locator = '') => `finding-${digest(JSON.stringify([rule, url, locator])).slice(0, 24)}`;

/** HTML is data only. Preserve duplicate tags and every JSON-LD block, including invalid JSON. */
export function inspectHtml(body, url, status = 200, context = {}) {
  const $ = load(body);
  const values = (selector, attr) => $(selector).map((_, node) => attr ? ($(node).attr(attr) ?? '') : $(node).text()).get();
  const metadata = {
    titles: values('title'), descriptions: values('meta[name="description" i]', 'content'),
    canonicals: values('link[rel~="canonical" i]', 'href'),
    og: $('meta[property^="og:" i]').map((_, node) => ({property: $(node).attr('property'), content: $(node).attr('content') ?? ''})).get(),
    robots: $('meta[name="robots" i], meta[name="googlebot" i]').map((_, node) => ({name: $(node).attr('name'), content: $(node).attr('content') ?? ''})).get(),
  };
  const jsonLdBlocks = $('script[type="application/ld+json" i]').map((index, node) => {
    const raw = $(node).text();
    try { return {index, raw, parsed: JSON.parse(raw), parseError: null}; }
    catch (error) { return {index, raw, parsed: null, parseError: error.message}; }
  }).get();
  const allLinks = [...new Set(values('a[href]', 'href').map(value => httpUrl(value, url)).filter(Boolean))];
  const og = key => clean(metadata.og.find(tag => tag.property.toLowerCase() === `og:${key}`)?.content);
  const evidenceHash = context.bodySha256 || digest(body);
  const observedAt = context.observedAt || new Date().toISOString();
  const evidenceId = `html-${digest(JSON.stringify([context.runId || null, url, observedAt, evidenceHash]))}`;
  const page = {
    url, requestedUrl: context.requestedUrl || url, status, observedAt, evidenceId, evidenceHash,
    evidenceKind: context.evidenceKind || 'RAW_HTML', headerEvidenceHash: digest(JSON.stringify({xRobotsTag: context.xRobotsTag || null})),
    title: clean(metadata.titles[0]), description: clean(metadata.descriptions[0]), canonical: metadata.canonicals[0] || '',
    metadata, jsonLdBlocks, jsonLd: jsonLdBlocks.filter(block => block.parseError === null).map(block => block.parsed),
    schemaErrors: jsonLdBlocks.filter(block => block.parseError !== null).map(block => `Invalid JSON in application/ld+json script ${block.index}: ${block.parseError}`),
    og: {title: og('title'), description: og('description'), image: og('image') ? httpUrl(og('image'), url) || og('image') : ''},
    siteName: og('site_name'),
    themeColor: /^#[0-9a-f]{6}$/i.test($('meta[name="theme-color" i]').attr('content') || '') ? $('meta[name="theme-color" i]').attr('content').toLowerCase() : null,
    h1: values('h1').map(clean), lang: $('html').attr('lang') || '', mainCount: $('main').length,
    headings: $('h1,h2,h3,h4,h5,h6').map((_, node) => ({level: Number(node.tagName.slice(1)), text: clean($(node).text())})).get(),
    links: allLinks.slice(0, 100), linksTruncated: allLinks.length > 100,
    robotsMeta: metadata.robots.map(tag => tag.content).join(', '), xRobotsTag: context.xRobotsTag || null,
    favicon: httpUrl($('link[rel~="icon"]').attr('href') || '/favicon.ico', url),
  };
  $('script, style, noscript, nav, footer').remove();
  page.text = clean($('body').text()).slice(0, 16_000);
  return page;
}

/** Stable rule identity is separate from immutable evidence-snapshot identity. */
export function findingsForPage(page) {
  const findings = [];
  const add = (rule, severity, message, evidence, recommendation, locator) => findings.push({
    id: findingId(rule, page.url, locator), rule, severity, url: page.url, message, evidence, recommendation,
    state: 'OPEN', evidenceRef: {id: page.evidenceId, hash: locator?.startsWith('header:') ? page.headerEvidenceHash : page.evidenceHash, kind: locator?.startsWith('header:') ? 'HTTP_HEADERS' : page.evidenceKind, url: page.url, requestedUrl: page.requestedUrl, observedAt: page.observedAt, locator},
  });
  const m = page.metadata;
  for (const [key, tags, label, locator] of [
    ['title', m.titles, 'title', 'title'], ['description', m.descriptions, 'meta description', 'meta[name="description"]'],
    ['canonical', m.canonicals, 'canonical URL', 'link[rel~="canonical"]'],
  ]) {
    if (!tags.some(value => value.trim())) add(`${key}-missing`, 'warning', `Missing ${label}.`, JSON.stringify(tags), `Add an accurate, page-specific ${label}.`, locator);
    if (tags.length > 1) add(`${key}-duplicate`, 'warning', `Multiple ${label} tags.`, JSON.stringify(tags), `Keep one unambiguous ${label}.`, locator);
  }
  if (page.title.length > 65) add('title-length', 'info', 'Title may be truncated.', page.title, 'Consider a concise title; display length varies.', 'title');
  if (page.description.length > 170) add('description-length', 'info', 'Description may be truncated.', page.description, 'Keep the description concise and accurate.', 'meta[name="description"]');
  for (const [index, value] of m.canonicals.entries()) {
    if (value && !httpUrl(value.trim())) add('canonical-invalid', 'warning', 'Canonical is not an absolute HTTP(S) URL.', value, 'Use an absolute canonical URL without credentials.', `canonical[${index}]`);
    else if (value && new URL(value).hash) add('canonical-fragment', 'warning', 'Canonical contains a fragment.', value, 'Use a canonical URL without a fragment.', `canonical[${index}]`);
  }
  for (const key of ['title', 'description', 'image', 'url', 'type']) {
    const tags = m.og.filter(tag => tag.property.toLowerCase() === `og:${key}`);
    if (!tags.some(tag => tag.content.trim())) add(`og-${key}-missing`, 'warning', `Missing Open Graph ${key}.`, JSON.stringify(tags), `Add accurate og:${key} metadata.`, `og:${key}`);
    if (tags.length > 1 && key !== 'image') add(`og-${key}-duplicate`, 'warning', `Multiple Open Graph ${key} tags.`, JSON.stringify(tags), `Keep one unambiguous og:${key}.`, `og:${key}`);
    if (['image', 'url'].includes(key)) for (const [index, tag] of tags.entries()) {
      if (tag.content && !httpUrl(tag.content)) add(`og-${key}-invalid`, 'warning', `Open Graph ${key} is not an absolute HTTP(S) URL.`, tag.content, 'Use an absolute public HTTP(S) URL.', `og:${key}[${index}]`);
    }
  }
  if (!page.h1.some(Boolean)) add('h1-missing', 'warning', 'No nonempty primary heading found.', JSON.stringify(page.h1), 'Add a visible heading describing the page.', 'h1');
  if (page.h1.length > 1) add('h1-multiple', 'info', 'Multiple primary headings found.', JSON.stringify(page.h1), 'Review the page outline; multiple H1s are not automatically a ranking failure.', 'h1');
  if (!page.lang.trim()) add('html-lang-missing', 'info', 'Document language is missing.', 'html lang is absent or empty.', 'Declare the actual content language.', 'html[lang]');
  if (page.headings.some((heading, index) => index > 0 && heading.level > page.headings[index - 1].level + 1)) add('heading-level-skip', 'info', 'Heading levels skip a level.', JSON.stringify(page.headings), 'Review the document outline for clear hierarchy.', 'headings');
  const noindex = text => /(?:^|[\s,:])(?:noindex|none)(?=$|[\s,;])/i.test(text);
  for (const [index, tag] of m.robots.entries()) if (noindex(tag.content)) add('noindex', 'warning', 'Page declares noindex.', `${tag.name}: ${tag.content}`, 'Confirm intent before changing indexing directives.', `robots[${index}]`);
  if (page.xRobotsTag && noindex(page.xRobotsTag)) add('x-robots-noindex', 'warning', 'HTTP header declares noindex.', page.xRobotsTag, 'Review the server header; an HTML patch cannot remove it.', 'header:x-robots-tag');
  if (!page.jsonLdBlocks.length) add('schema-missing', 'info', 'No JSON-LD observed.', 'No application/ld+json scripts.', 'Consider page-appropriate structured data using visible facts only.', 'json-ld');
  for (const block of page.jsonLdBlocks) {
    if (block.parseError) add('schema-invalid-json', 'warning', 'JSON-LD syntax is invalid.', block.raw, 'Repair this exact block. Adding another valid block does not repair it.', `json-ld[${block.index}]`);
    else if (block.parsed === null || typeof block.parsed !== 'object') add('schema-invalid-shape', 'warning', 'JSON-LD is a scalar rather than an object or array.', block.raw, 'Review the JSON-LD structure. JSON syntax alone does not validate Schema.org meaning.', `json-ld[${block.index}]`);
  }
  return findings;
}
