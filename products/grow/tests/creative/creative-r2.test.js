import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { defaultCampaign, validateCampaign, contrastRatio, readableInk } from '../../src/creative/index.js';
import { renderCampaign, normalizedAsset, SOCIAL_SIZES } from '../../src/render/index.js';
import { composeCampaign, fitText } from '../../src/render/layout.js';
import { verifyLayout } from '../../src/render/verify.js';
import { exportCampaign } from '../../src/delivery/index.js';
const sample = JSON.parse(await readFile(new URL('../../src/creative/launchforge.campaign.json', import.meta.url)));
const assetPath = fileURLToPath(new URL('../../src/creative/assets/grow-product.png', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('brand intake uses evidence, three opt-in concepts, and compatible legacy two', () => {
  const audit = { url: 'https://example.org', brand: { name: 'Proof', tokens: { accent: '#123456' } }, pages: [{ h1: ['An observed headline'], description: 'An observed description.' }] };
  const draft = defaultCampaign(audit, { conceptCount: 3 });
  assert.equal(draft.color, '#123456');
  assert.equal(defaultCampaign(audit).variants.length, 2);
  assert.deepEqual(draft.variants.map(v => v.concept), ['spotlight', 'editorial', 'signal']);
  assert.ok(draft.variants.every(v => v.body === 'An observed description.'));
  assert.throws(() => validateCampaign(draft), /Confirm/);
  assert.equal(validateCampaign({ ...draft, confirmed: true, color: '#ffffff' }).tokens.accent, '#ffffff');
});

test('bad tokens/copy/URLs fail instead of injecting or silently truncating', () => {
  for (const tokens of [{ font: 'Arial;url(https://bad)' }, { paper: 'url(https://bad)' }, { muted: '#f4f1e8' }]) assert.throws(() => validateCampaign({ ...sample, tokens: { ...sample.tokens, ...tokens } }));
  assert.throws(() => validateCampaign({ ...sample, headline: 'a'.repeat(93) }), /shorten/);
  assert.throws(() => validateCampaign({ ...sample, variants: Array(4).fill(sample.variants[0]) }), /three/);
  assert.throws(() => validateCampaign({ ...sample, url: 'https://user:password@example.com' }), /credentials/);
  assert.throws(() => composeCampaign(validateCampaign(sample), 0, SOCIAL_SIZES[0], 'https://bad/image.svg'), /normalized/);
  assert.throws(() => fitText('Wide copy', 10, 10, 40, 30), /nothing was clipped/);
});

test('CTA ink maintains AA contrast across all grayscale brand colors', () => {
  for (let c = 0; c <= 255; c++) {
    const hex = '#' + c.toString(16).padStart(2, '0').repeat(3);
    assert.ok(contrastRatio(hex, readableInk(hex)) >= 4.5);
  }
});

test('nine layouts retain exact copy, fit actual font ink and preserve screenshot geometry', async () => {
  const campaign = validateCampaign(sample), asset = await normalizedAsset({ assetPath });
  assert.equal(asset.source.sha256, sha(await readFile(assetPath)));
  assert.equal(asset.normalized.width / asset.normalized.height, asset.source.width / asset.source.height);
  for (const [index, variant] of campaign.variants.entries()) for (const size of SOCIAL_SIZES) {
    const layout = composeCampaign(campaign, index, size, asset.dataUrl);
    assert.equal((await verifyLayout(layout)).status, 'PASS');
    for (const field of ['headline', 'body', 'cta']) assert.equal(layout.blocks.find(b => b.id === field).lines.join(' '), variant[field]);
    assert.ok(layout.svg.includes('preserveAspectRatio="xMidYMid meet"'));
    assert.ok(!layout.svg.includes('<clipPath'));
    assert.equal(sha(Buffer.from(layout.svg.match(/href="data:image\/png;base64,([^\"]+)"/)[1], 'base64')), asset.normalized.sha256);
    if (size.name === 'story') { assert.ok(layout.safeArea.y >= 150); assert.ok(layout.safeArea.y + layout.safeArea.height <= 1680); }
  }
});

test('independent raster measurement catches overflow; unbroken words stay bounded', async () => {
  const layout = composeCampaign(validateCampaign(sample), 0, SOCIAL_SIZES[0]);
  layout.blocks.find(b => b.id === 'headline').width = 4;
  await assert.rejects(verifyLayout(layout), /typography overflows/);
  const long = 'W'.repeat(90), fitted = fitText(long, 910, 304, 88, 42);
  assert.equal(fitted.lines.join(''), long);
  assert.ok(fitted.lines.every(line => line.length > 0));
});

test('active, remote and oversized images are rejected without fetching', async () => {
  await assert.rejects(normalizedAsset({ assetPath: 'https://example.com/image.png' }), /local/);
  await assert.rejects(normalizedAsset({ assetBuffer: Buffer.from('<svg><image href="file:///etc/passwd"/></svg>') }), /PNG/);
  await assert.rejects(normalizedAsset({ assetBuffer: Buffer.alloc(15 * 1024 * 1024 + 1) }), /15 MB/);
});

test('render, decode, export and identical-input rerender preserve the complete pack', { timeout: 120_000 }, async () => {
  const parent = fileURLToPath(new URL('.work/', import.meta.url));
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, 'acceptance-'));
  try {
    const input = { ...sample, assetPath };
    const first = await renderCampaign(input, join(dir, 'first'));
    const second = await renderCampaign(input, join(dir, 'second'));
    assert.equal(first.files.filter(f => f.type === 'image').length, 9);
    assert.equal(first.files.find(f => f.type === 'video').duration, 8);
    const quality = JSON.parse(await readFile(join(dir, 'first', 'quality.json')));
    assert.equal(quality.video.streams[0].nb_read_frames, '240');
    assert.equal(quality.checks.length, 9);
    for (const file of first.files) {
      assert.equal(file.sha256, second.files.find(f => f.name === file.name).sha256, `determinism: ${file.name}`);
      if (file.type === 'image') { const meta = await sharp(file.path).metadata(); assert.equal(meta.width, file.width); assert.equal(meta.height, file.height); }
    }
    const exported = await exportCampaign({ campaign: input, render: first }, dir);
    assert.equal(exported.items.length, 4);
    assert.deepEqual(exported.items.slice(0, 3).map(v => v.assets.length), [3, 3, 3]);
    assert.equal(exported.publishedAt, null);
    const manifest = JSON.parse(await readFile(join(dir, 'first', 'campaign.json')));
    assert.equal(manifest.asset.source.sha256, sha(await readFile(assetPath)));
    assert.equal(manifest.assetPath, 'product.png');
    assert.ok(!JSON.stringify(manifest).includes(assetPath));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
