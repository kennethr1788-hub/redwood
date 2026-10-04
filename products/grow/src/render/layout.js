import { readableInk } from '../creative/index.js';
export const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
export const SOCIAL_SIZES = Object.freeze([
  { name: 'square', width: 1080, height: 1080 },
  { name: 'portrait', width: 1080, height: 1350 },
  { name: 'story', width: 1080, height: 1920 },
]);
const weight = c => /[MW@%]/.test(c) ? 1.05 : /[A-Z]/.test(c) ? .8 : /[il.,!:' ]/.test(c) ? .34 : /[a-z0-9]/.test(c) ? .63 : 1.15;
const estimate = text => Array.from(text).reduce((sum, c) => sum + weight(c), 0);

/** Whole copy is retained. Fit down to a readable floor or fail, never ellipsize. */
export function fitText(text, width, height, maxSize, minSize, lineHeight = 1.18) {
  for (let size = maxSize; size >= minSize; size -= 2) {
    const lines = [];
    const words = text.split(/\s+/).flatMap(word => {
      if (estimate(word) * size <= width) return [word];
      const parts = [''];
      for (const { segment } of new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(word)) {
        if (estimate(parts.at(-1) + segment) * size > width) parts.push('');
        parts[parts.length - 1] += segment;
      }
      return parts;
    });
    for (const word of words) {
      const previous = lines.at(-1);
      if (previous && estimate(`${previous} ${word}`) * size <= width) lines[lines.length - 1] += ` ${word}`;
      else lines.push(word);
    }
    if (lines.length && lines.length * size * lineHeight <= height) return { lines, size, lineHeight, height: lines.length * size * lineHeight };
  }
  throw new Error('Copy does not fit the readable safe area. Shorten the copy; nothing was clipped.');
}

export function composeCampaign(campaign, variant, { width, height }, assetDataUrl = null, { only = null, endCard = false } = {}) {
  if (!SOCIAL_SIZES.some(s => s.width === width && s.height === height)) throw new Error('Unsupported creative dimensions.');
  if (assetDataUrl && !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(assetDataUrl)) throw new Error('Only normalized embedded PNG assets are accepted.');
  const copy = campaign.variants[variant];
  if (!copy) throw new Error('Unknown campaign variant.');
  const t = campaign.tokens;
  const concept = copy.concept;
  const editorial = concept === 'editorial', signal = concept === 'signal';
  const tall = height === 1920;
  const top = tall ? 168 : 64, bottom = height - (tall ? 264 : 64);
  const background = editorial ? t.paper : signal ? t.accent : t.dark;
  const ink = editorial ? t.ink : readableInk(background);
  const muted = editorial ? t.muted : ink;
  const accentInk = readableInk(t.accent);
  const headlineFont = editorial ? t.displayFont : t.font;
  const elements = [], blocks = [];
  const add = (layer, content) => elements.push({ layer, content });
  const text = (layer, id, content, x, y, w, h, maxSize, minSize, fill, font = t.font, bold = false, align = 'left') => {
    const fitted = fitText(content, w, h, maxSize, minSize, 1.2);
    blocks.push({ id, text: content, x, y, width: w, height: fitted.height, availableHeight: h, font, weight: bold ? 700 : 400, fill, ...fitted });
    add(layer, fitted.lines.map((line, i) => `<text x="${align === 'center' ? x + w / 2 : x}" y="${y + fitted.size + i * fitted.size * 1.2}" text-anchor="${align === 'center' ? 'middle' : 'start'}" font-family="${font}" font-size="${fitted.size}" font-weight="${bold ? 700 : 400}" fill="${fill}">${escape(line)}</text>`).join(''));
    return fitted.height;
  };
  add('background', `<defs><linearGradient id="wash" x1="0" y1="1" x2="1" y2="0"><stop stop-color="${background}"/><stop offset="1" stop-color="${editorial ? t.paper : signal ? t.accent : '#304b35'}"/></linearGradient></defs><rect width="1080" height="${height}" fill="${background}"/><rect width="1080" height="${height}" fill="url(#wash)"/>`);
  if (!editorial && !signal) {
    add('background', `<g fill="none" stroke="${t.accent}" opacity=".12">${[0, 1, 2, 3].map(i => `<path d="M${650 + i * 80} 0 L${180 + i * 80} ${height}"/>`).join('')}</g>`);
  } else if (editorial) {
    add('background', `<path d="M0 ${height * .5} H1080 V${height * .84} H0Z" fill="${t.ink}" opacity=".045"/>`);
  } else {
    add('background', `<path d="M940 0H1080V${height}H940Z" fill="${ink}" opacity=".04"/>`);
  }
  add('brand', `<rect x="72" y="${top}" width="42" height="42" rx="12" fill="${ink}"/><path d="M83 ${top + 29}l20-20m-16 0h16v16" fill="none" stroke="${background}" stroke-width="4"/>`);
  text('brand', 'brand', campaign.brandName, 130, top, 686, 46, 28, 18, ink, t.font, true);
  text('brand', 'folio', `0${variant + 1} / ${String(campaign.variants.length).padStart(2, '0')}`, 874, top + 5, 134, 34, 22, 18, ink);
  add('brand', `<path d="M72 ${top + 66}H1008" stroke="${ink}" opacity=".25"/>`);
  const kicker = editorial ? 'THE PRODUCT, IN FOCUS' : signal ? 'MAKE YOUR NEXT MOVE' : 'FROM PRODUCT TO POSSIBILITY';
  text('copy', 'kicker', kicker, 72, top + 91, 936, 34, 20, 18, muted);
  const ctaY = bottom - 116;
  const headlineH = height === 1080 ? 178 : height === 1350 ? 228 : endCard ? 420 : 304;
  // Editorial leads with the product, followed by a centered serif statement.
  const editorialArtH = height === 1080 ? 330 : height === 1350 ? 438 : 650;
  const headlineY = editorial ? top + 140 + editorialArtH + 30 : top + 140;
  const headH = text('copy', 'headline', copy.headline, 72, headlineY, editorial ? 936 : signal && !endCard ? 750 : 910, headlineH, endCard ? 112 : editorial ? (height === 1080 ? 64 : 82) : 88, 42, ink, headlineFont, !editorial, editorial ? 'center' : 'left');
  if (signal && !endCard) add('copy', `<path d="M856 ${headlineY + 111}l128-128m-108 0h108v108" transform="translate(0 30)" fill="none" stroke="${ink}" stroke-width="12"/>`);
  const bodyY = headlineY + headH + 18;
  const bodyH = text('copy', 'body', copy.body, editorial ? 144 : 72, bodyY, editorial ? 792 : 900, height === 1080 ? 108 : 140, 28, 24, muted, t.font, false, editorial ? 'center' : 'left');
  const artY = editorial ? top + 140 : bodyY + bodyH + (tall ? 54 : 26);
  const artBottom = editorial ? artY + editorialArtH : ctaY - 38;
  const artH = artBottom - artY;
  if (artH < 190 || (editorial && bodyY + bodyH > ctaY - 24)) throw new Error('Copy leaves too little room for product imagery. Shorten the headline or body.');
  const artX = editorial ? 108 : 72, artW = editorial ? 864 : 936;
  // The mat can be cropped decoratively; the screenshot itself always uses contain.
  add('product', `<rect x="${artX + 16}" y="${artY + 18}" width="${artW}" height="${artH}" rx="18" fill="${ink}" opacity=".12"/><rect x="${artX}" y="${artY}" width="${artW}" height="${artH}" rx="18" fill="${editorial ? '#ffffff' : '#0c1711'}" stroke="${ink}" stroke-opacity=".2"/><g fill="${editorial ? t.muted : '#d2ddce'}" opacity=".65"><circle cx="${artX + 22}" cy="${artY + 18}" r="4"/><circle cx="${artX + 37}" cy="${artY + 18}" r="4"/><circle cx="${artX + 52}" cy="${artY + 18}" r="4"/></g>`);
  const imageBox = { x: artX + 12, y: artY + 34, width: artW - 24, height: artH - 46 };
  if (assetDataUrl) add('product', `<image x="${imageBox.x}" y="${imageBox.y}" width="${imageBox.width}" height="${imageBox.height}" preserveAspectRatio="xMidYMid meet" href="${assetDataUrl}"/>`);
  else {
    add('product', `<path d="M${artX + artW / 2 - 48} ${artY + artH / 2 + 48}l96-96m-80 0h80v80" stroke="${t.accent}" stroke-width="12" fill="none"/>`);
    text('product', 'asset-placeholder', 'PRODUCT IMAGE NOT SUPPLIED', artX + 30, artBottom - 50, artW - 60, 30, 18, 16, '#ffffff', t.font, false, 'center');
  }
  const ctaFill = editorial || !signal ? t.accent : t.dark;
  const ctaInk = editorial || !signal ? accentInk : readableInk(t.dark);
  const ctaFit = fitText(copy.cta, 726, 56, 30, 24);
  const ctaW = Math.max(330, Math.min(860, Math.ceil(estimate(copy.cta) * ctaFit.size + 116)));
  const ctaX = editorial ? (1080 - ctaW) / 2 : 72;
  add('cta', `<rect x="${ctaX}" y="${ctaY}" width="${ctaW}" height="78" rx="${editorial ? 39 : 12}" fill="${ctaFill}"/>`);
  text('cta', 'cta', copy.cta, ctaX + 28, ctaY + 17, ctaW - 100, 48, ctaFit.size, 24, ctaInk, t.font, true);
  add('cta', `<path d="M${ctaX + ctaW - 52} ${ctaY + 48}l20-20m-18 0h18v18" fill="none" stroke="${ctaInk}" stroke-width="3"/>`);
  const host = new URL(campaign.url).hostname.replace(/^www\./, '');
  text('cta', 'destination', host, 72, bottom - 20, 936, 28, 20, 18, ink, t.font, false, editorial ? 'center' : 'left');
  const safeArea = { x: 64, y: tall ? 152 : 48, width: 952, height: bottom + 20 - (tall ? 152 : 48) };
  for (const b of blocks) if (b.x < safeArea.x || b.x + b.width > safeArea.x + safeArea.width || b.y < safeArea.y || b.y + b.height > safeArea.y + safeArea.height) throw new Error(`Text outside safe area: ${b.id}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1080 ${height}" role="img"><title>${escape(campaign.brandName)} — ${escape(copy.headline)}</title>${elements.filter(e => !only || only.includes(e.layer)).map(e => `<g data-layer="${e.layer}">${e.content}</g>`).join('')}</svg>`;
  return { svg, concept, blocks, safeArea, imageBox, crop: 'contain / full source / no crop', art: { x: artX, y: artY, width: artW, height: artH }, contrast: { body: { foreground: muted, background }, cta: { foreground: ctaInk, background: ctaFill } } };
}

export function campaignSvg(campaign, variant, size, assetDataUrl = null) {
  return composeCampaign(campaign, variant, size, assetDataUrl).svg;
}
