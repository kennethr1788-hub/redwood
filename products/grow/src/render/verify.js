import sharp from 'sharp';
import { escape } from './layout.js';
import { contrastRatio } from '../creative/index.js';

/** Measure actual font raster ink, independently of the conservative wrapping heuristic. */
export async function verifyLayout(layout) {
  const measurements = [];
  for (const block of layout.blocks) {
    for (const line of block.lines) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="300"><text x="40" y="180" font-family="${block.font}" font-size="${block.size}" font-weight="${block.weight}" fill="#ffffff">${escape(line)}</text></svg>`;
      const { info } = await sharp(Buffer.from(svg)).trim({ threshold: 0 }).png().toBuffer({ resolveWithObject: true });
      if (info.width > block.width || info.height > block.size * block.lineHeight) throw new Error(`Actual typography overflows ${block.id}: ${line}`);
      measurements.push({ id: block.id, line, inkWidth: info.width, inkHeight: info.height, availableWidth: block.width, size: block.size });
    }
  }
  const contrast = Object.fromEntries(Object.entries(layout.contrast).map(([key, colors]) => [key, contrastRatio(colors.foreground, colors.background)]));
  for (const [key, ratio] of Object.entries(contrast)) if (ratio < 4.5) throw new Error(`${key} contrast is below 4.5:1.`);
  // Vertical text/art slots are non-overlapping by construction; verify independently.
  const headline = layout.blocks.find(b => b.id === 'headline'), body = layout.blocks.find(b => b.id === 'body');
  const cta = layout.blocks.find(b => b.id === 'cta');
  if (headline.y + headline.height > body.y) throw new Error('Headline/body overlap.');
  if (layout.concept === 'editorial') {
    if (layout.art.y + layout.art.height + 18 > headline.y || body.y + body.height > cta.y - 17) throw new Error('Editorial regions overlap.');
  } else if (body.y + body.height > layout.art.y || layout.art.y + layout.art.height + 18 > cta.y - 17) throw new Error('Creative regions overlap.');
  return { status: 'PASS', safeArea: layout.safeArea, imageBox: layout.imageBox, crop: layout.crop, contrast, measurements };
}
