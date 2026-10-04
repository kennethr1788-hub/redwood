import { KNOWLEDGE_VERSION, KNOWLEDGE_DOCUMENTS, SUPPORT_INTENTS, LEGACY_TOPIC_ALIASES } from '../../docs/advisor/knowledge.mjs';
import { freeze, requireValue, shape, identifier, relativePath, oneOf } from '../agents/contract.mjs';
import { LIMITS, safeText, data } from './contracts.mjs';
import { readKnowledgeDocument } from './knowledge-store.mjs';
import { DISPLAY_NAMES, applyHelpDisplayNames } from '../../launcher/src/display-names.js';

// Index only at startup: bodies are loaded after classification, never all at once.
const documents = data(KNOWLEDGE_DOCUMENTS);
const intents = data(SUPPORT_INTENTS);
requireValue(documents.length === 18, 'CORPUS_COUNT');
requireValue(intents.length >= 30 && intents.length <= 50, 'INTENT_COUNT');
for (const d of documents) {
  shape(d, ['id', 'title', 'path', 'sourcePaths']); identifier(d.id); safeText(d.title, 100);
  relativePath(d.path); requireValue(d.path.endsWith('.md'), 'MARKDOWN_REQUIRED');
  requireValue(Array.isArray(d.sourcePaths) && d.sourcePaths.length > 0 && d.sourcePaths.length <= 12, 'SOURCES_LIMIT');
  d.sourcePaths.forEach(p => relativePath(p));
}
requireValue(new Set(documents.map(d => d.id)).size === documents.length && new Set(documents.map(d => d.path)).size === documents.length, 'CORPUS_IDS');
export const TOPIC_IDS = freeze(documents.map(d => d.id));
for (const i of intents) {
  shape(i, ['id', 'keywords', 'documents', 'products', 'contract']); identifier(i.id);
  requireValue(Array.isArray(i.keywords) && i.keywords.length > 0 && i.keywords.length <= 16, 'KEYWORDS_LIMIT');
  i.keywords.forEach(k => safeText(k, 50));
  requireValue(Array.isArray(i.documents) && i.documents.length > 0 && i.documents.length <= LIMITS.retrievedSections && new Set(i.documents).size === i.documents.length, 'DOCUMENT_LIMIT');
  i.documents.forEach(id => oneOf(id, TOPIC_IDS));
  requireValue(Array.isArray(i.products) && i.products.length <= 1, 'PRODUCT_LIMIT');
  i.products.forEach(id => oneOf(id, ['build', 'studio', 'grow']));
  oneOf(i.contract, [null, 'BUILD_VERIFICATION_FAILED', 'STUDIO_STALE_RENDER', 'HIGGSFIELD_SETUP']);
}
requireValue(new Set(intents.map(i => i.id)).size === intents.length, 'INTENT_IDS');
freeze(documents); freeze(intents);
export { KNOWLEDGE_VERSION };

export function normalizeTopics(value) {
  requireValue(Array.isArray(value) && value.length <= 3 && new Set(value).size === value.length, 'TOPIC_LIMIT');
  const ids = value.map(id => Object.hasOwn(LEGACY_TOPIC_ALIASES, id) ? LEGACY_TOPIC_ALIASES[id] : id);
  ids.forEach(id => oneOf(id, TOPIC_IDS));
  return [...new Set(ids)];
}

export function classifySupportIntent(question, context = {}) {
  safeText(question, LIMITS.questionChars);
  const c = data(context);
  if (c.supportIntent !== undefined) {
    const exact = intents.find(i => i.id === c.supportIntent);
    requireValue(exact, 'UNKNOWN_SUPPORT_INTENT'); return exact;
  }
  if (c.intent === 'PREPARE_CODING_PROMPT') return intents.find(i => i.id === 'prompt.prepare');
  const words = new Set(question.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  // Display aliases select the existing owner; never rewrite question or state data.
  // Legacy owner words (including Studio) remain valid keywords.
  for (const product of ['build', 'studio', 'grow']) {
    const labelWords = DISPLAY_NAMES[product].toLowerCase().match(/[a-z0-9]+/g) ?? [];
    if (labelWords.length && labelWords.every(word => words.has(word))) words.add(product);
  }
  // An explicit provider reference wins; all connection intents share one bounded card.
  const provider = ['higgsfield', 'elevenlabs', 'codex', 'claude'].find(p => words.has(p));
  if (provider) return intents.find(i => i.id === `connection.${provider}`);
  const explicitProduct = ['build', 'studio', 'grow'].find(p => words.has(p));
  const activeProduct = explicitProduct ?? c.state?.product ?? c.liveContext?.page ?? null;
  const ranked = intents.map((intent, index) => {
    const score = intent.keywords.reduce((best, phrase) => {
      const parts = phrase.split(/[^a-z0-9]+/);
      return parts.every(w => words.has(w)) ? Math.max(best, parts.length * 10) : best;
    }, 0);
    // Generic next-action wording must not displace a concrete product problem.
    return { intent, index, score: (intent.id === 'expert.decision' && score ? 1 : score) + (score && intent.products.includes(activeProduct) ? 2 : 0) };
  }).filter(({ intent, score }) => score > 0 && (!intent.products.length || !activeProduct || intent.products.includes(activeProduct)))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked[0]?.intent ?? intents.find(i => i.id === 'onboarding.start');
}

export function retrieveHelp(question, previousTopics = [], context = {}) {
  const intent = classifySupportIntent(question, context);
  const prior = normalizeTopics(data({ previousTopics }).previousTopics);
  // Only generic follow-ups may reuse discussion topics, never a different product.
  const followup = intent.id === 'onboarding.start' && !context.supportIntent && !context.state?.product && !context.liveContext?.page &&
    /^(?:what next|more|tell me more)[?.! ]*$/i.test(question.trim());
  const ids = followup && prior.length ? prior : intent.documents;
  return freeze(ids.map(id => {
    const d = documents.find(d => d.id === id);
    return { ...d, title: safeText(applyHelpDisplayNames(d.title), 100),
      body: safeText(applyHelpDisplayNames(readKnowledgeDocument(d.path)), LIMITS.sectionChars) };
  }));
}
