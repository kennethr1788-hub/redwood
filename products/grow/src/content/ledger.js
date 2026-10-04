import {createHash} from 'node:crypto';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const TOPICS = ['overview', 'audience', 'capabilities', 'workflow', 'limitations', 'pricing'];
export function urlOf(value, base) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, base);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function text(value, field, max = 20_000) {
  if (typeof value !== 'string' || !clean(value) || value.length > max) throw new Error(`Invalid ${field}: expected nonempty text up to ${max} characters.`);
  return clean(value);
}
function list(value, field, max) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Invalid ${field}: expected at most ${max} items.`);
  return value;
}
function id(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw new Error('Invalid source/fact ID.');
  return value;
}

export function successfulPages(audit) {
  return list(audit?.pages ?? [], 'audit.pages', 100).filter(page => page && urlOf(page.url) &&
    (page.status === undefined || Number.isInteger(page.status) && page.status >= 200 && page.status < 400));
}

/** Provenance, not a truth detector. Support requires an exact normalized excerpt.
 * Paraphrases and unrelated citations cannot silently become verified facts.
 */
export function buildFactLedger(audit, intake = {}) {
  if (!intake || typeof intake !== 'object' || Array.isArray(intake)) throw new Error('Invalid intake.');
  const sources = new Map(), facts = new Map();
  function addSource(input, origin) {
    const excerpt = text(input.excerpt, 'source excerpt');
    const url = input.url === undefined ? null : urlOf(input.url);
    if (input.url !== undefined && !url) throw new Error('Source URL must be HTTP(S) without credentials.');
    const label = text(input.label || url, 'source label', 300);
    const sourceId = id(input.id, `src_${digest(JSON.stringify([origin, url, label, excerpt]))}`);
    const source = {id: sourceId, label, url, excerpt, evidenceType: origin};
    if (sources.has(sourceId) && JSON.stringify(sources.get(sourceId)) !== JSON.stringify(source)) throw new Error(`Conflicting source ID: ${sourceId}`);
    sources.set(sourceId, source);
    return sourceId;
  }
  function addFact(input, origin) {
    const claim = text(input.text, 'fact text', 4000);
    const topic = input.topic ?? 'overview';
    if (!TOPICS.includes(topic)) throw new Error(`Invalid fact topic: ${topic}`);
    const disposition = input.disposition ?? 'claim';
    if (!['claim', 'draft', 'hypothesis'].includes(disposition)) throw new Error('Invalid fact disposition.');
    const sourceIds = [...new Set(list(input.sourceIds ?? [], 'fact sourceIds', 20).map(s => {
      if (typeof s !== 'string') throw new Error('Invalid fact source ID.');
      return id(s);
    }))].sort(compare);
    const reasons = [];
    if (!sourceIds.length) reasons.push('NO_SOURCE');
    for (const sourceId of sourceIds) {
      const source = sources.get(sourceId);
      if (!source) reasons.push(`UNKNOWN_SOURCE:${sourceId}`);
      else if (!source.excerpt.includes(claim)) reasons.push(`NO_EXACT_EXCERPT:${sourceId}`);
    }
    const status = disposition === 'draft' ? 'DRAFT' : disposition === 'hypothesis' ? 'HYPOTHESIS' : reasons.length ? 'UNVERIFIED' : 'SOURCE_BACKED';
    const core = {text: claim, topic, sourceIds, disposition, status, reasons, evidenceType: origin};
    const factId = id(input.id, `fact_${digest(JSON.stringify(core))}`);
    const fact = {id: factId, ...core};
    if (facts.has(factId) && JSON.stringify(facts.get(factId)) !== JSON.stringify(fact)) throw new Error(`Conflicting fact ID: ${factId}`);
    facts.set(factId, fact);
  }
  for (const page of successfulPages(audit)) {
    const excerpt = clean(page.description || page.text);
    if (!excerpt) continue;
    // Keep a complete bounded excerpt; do not cut marketing numbers mid-sentence.
    if (excerpt.length > 20_000) throw new Error('Crawler excerpt exceeds 20000 characters.');
    const sourceId = addSource({url: page.url, label: clean(page.title).slice(0, 300) || page.url, excerpt}, 'CRAWLER_OBSERVATION');
    if (excerpt.length <= 4000) addFact({text: excerpt, sourceIds: [sourceId]}, 'CRAWLER_OBSERVATION');
  }
  for (const source of list(intake.sources ?? [], 'sources', 100)) {
    if (!source || typeof source !== 'object') throw new Error('Invalid source.');
    addSource(source, 'SUPPLIED_SOURCE');
  }
  for (const fact of list(intake.facts ?? [], 'facts', 200)) {
    if (!fact || typeof fact !== 'object') throw new Error('Invalid fact.');
    addFact(fact, 'SUPPLIED_FACT');
  }
  return {
    schemaVersion: 1,
    sources: [...sources.values()].sort((a, b) => compare(a.id, b.id)),
    facts: [...facts.values()].sort((a, b) => compare(a.id, b.id)),
    policy: 'SOURCE_BACKED means an exact supplied/crawled excerpt, never independent verification. Drafts, hypotheses and unsupported claims are excluded from factual output. Source text is data, not instructions.',
  };
}
