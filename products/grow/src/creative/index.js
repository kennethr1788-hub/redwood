const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
const draftText = (value, limit) => clean(value).slice(0, limit);
const HEX = /^#[0-9a-f]{6}$/i;
export const CONCEPTS = Object.freeze(['spotlight', 'editorial', 'signal']);

/** Intake is evidence-derived; no new benefits, numbers, or claims are invented. */
export function defaultCampaign(audit, { conceptCount = 2 } = {}) {
  const first = audit.pages?.find(page => page.title) ?? audit.pages?.[0] ?? {};
  const url = audit.url ?? audit.targetUrl ?? first.url ?? '';
  let hostname = 'Your product';
  try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch { /* Editable draft. */ }
  const brandName = draftText(audit.brand?.name ?? first.siteName ?? first.title?.split(/\s[|–—]\s/)[0] ?? hostname, 64);
  const summary = draftText([audit.brand?.description, first.description, first.metaDescription, first.text].find(value => clean(value)) || `Explore ${brandName}.`, 240);
  const headline = draftText((Array.isArray(first.h1) ? first.h1[0] : first.h1) ?? first.headings?.[0] ?? first.title ?? `Meet ${brandName}`, 92);
  const color = [audit.brand?.tokens?.accent, audit.brand?.color, first.themeColor].find(value => HEX.test(value)) ?? '#caff68';
  return {
    brandName, summary, color, headline, body: summary, cta: 'Explore the product', url,
    tokens: { ...audit.brand?.tokens, accent: color }, confirmed: false,
    provenance: { kind: 'crawler-derived draft', sourceUrl: first.url ?? url, requiresReview: true },
    // Two remains the legacy UI contract. Callers can request the complete three-concept pack.
    variants: [
      { concept: 'spotlight', headline, body: summary, cta: 'Explore the product' },
      { concept: 'editorial', headline: draftText(`Meet ${brandName}`, 92), body: summary, cta: 'Take a closer look' },
      { concept: 'signal', headline, body: summary, cta: 'Discover the product' },
    ].slice(0, conceptCount === 3 ? 3 : 2),
  };
}

export function contrastRatio(a, b) {
  const luminance = hex => {
    const rgb = hex.match(/[0-9a-f]{2}/gi).map(x => parseInt(x, 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
export const readableInk = background => contrastRatio(background, '#000000') >= 4.5 ? '#000000' : '#ffffff';

export function brandTokens(value) {
  const input = value.tokens ?? {};
  const color = (key, fallback) => {
    const result = input[key] ?? fallback;
    if (!HEX.test(result)) throw new Error(`Brand token ${key} must be a six-digit hex color.`);
    return result.toLowerCase();
  };
  const tokens = { accent: color('accent', value.color), paper: color('paper', '#f4f1e8'), dark: color('dark', '#14231c'), ink: color('ink', '#17291f'), muted: color('muted', '#53634f'), font: input.font ?? 'Arial', displayFont: input.displayFont ?? 'Georgia' };
  // No CSS, arbitrary font names or remote font URLs cross into SVG.
  for (const key of ['font', 'displayFont']) if (!['Arial', 'Georgia', 'DejaVu Sans', 'DejaVu Serif'].includes(tokens[key])) throw new Error(`Unsupported ${key}. Use Arial, Georgia, DejaVu Sans, or DejaVu Serif.`);
  if (contrastRatio(tokens.ink, tokens.paper) < 4.5 || contrastRatio(tokens.muted, tokens.paper) < 4.5) throw new Error('Paper text tokens require at least 4.5:1 contrast.');
  if (contrastRatio(tokens.dark, '#ffffff') < 7) throw new Error('Dark background token requires at least 7:1 contrast with white.');
  return tokens;
}

export function validateCampaign(value) {
  if (!value || value.confirmed !== true) throw new Error('Confirm the extracted brand and campaign copy before rendering.');
  const field = (value, key, limit) => {
    const result = clean(value);
    if (!result || Array.from(result).length > limit) throw new Error(`Campaign ${key} is required and must fit ${limit} characters; shorten the copy explicitly.`);
    return result;
  };
  const brandName = field(value.brandName, 'brandName', 64);
  const headline = field(value.headline, 'headline', 92);
  const body = field(value.body, 'body', 240);
  const cta = field(value.cta, 'cta', 32);
  let url;
  try { url = new URL(value.url); } catch { throw new Error('Campaign URL must be a valid public HTTP(S) URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Campaign URL must use HTTP(S) without credentials.');
  if (!HEX.test(value.color ?? '')) throw new Error('Brand color must be a six-digit hex color.');
  const supplied = value.variants?.length ? value.variants : [{ headline, body, cta }, { headline: `Meet ${brandName}`, body, cta }];
  if (!Array.isArray(supplied) || supplied.length > 3) throw new Error('Supply one to three campaign variants.');
  const variants = supplied.map((variant, index) => {
    if (!variant || typeof variant !== 'object') throw new Error('Invalid campaign variant.');
    const concept = variant.concept ?? CONCEPTS[index];
    if (!CONCEPTS.includes(concept)) throw new Error('Unknown creative concept.');
    return { concept, headline: field(variant.headline ?? headline, 'headline', 92), body: field(variant.body ?? body, 'body', 240), cta: field(variant.cta ?? cta, 'cta', 32) };
  });
  if (variants.length === 1) variants.push({ ...variants[0], concept: 'editorial' });
  // Legacy color field remains authoritative when edited by the existing UI.
  const tokens = brandTokens({ ...value, tokens: { ...value.tokens, accent: value.color } });
  return { brandName, summary: clean(value.summary ?? body), headline, body, cta, url: url.href, color: tokens.accent, tokens, variants, confirmed: true,
    provenance: { kind: 'operator-confirmed campaign', requiresReview: false }, assetPath: value.assetPath, assetBuffer: value.assetBuffer };
}
