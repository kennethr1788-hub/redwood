import sharp from 'sharp';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateCampaign } from '../creative/index.js';
import { SOCIAL_SIZES, composeCampaign } from './layout.js';
import { verifyLayout } from './verify.js';
export { campaignSvg, SOCIAL_SIZES } from './layout.js';
const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';

export async function normalizedAsset(campaign) {
  const input = campaign.assetBuffer ?? campaign.assetPath;
  if (!input) return null;
  if (!Buffer.isBuffer(input) && typeof input !== 'string') throw new Error('Brand asset must be a local file or Buffer.');
  if (typeof input === 'string') {
    if (/^[a-z]+:/i.test(input)) throw new Error('Brand assets must be local files.');
    const info = await stat(input);
    if (!info.isFile() || info.size > 15 * 1024 * 1024) throw new Error('Brand asset must be a regular file under 15 MB.');
  }
  const bytes = Buffer.isBuffer(input) ? input : await readFile(input);
  if (bytes.length > 15 * 1024 * 1024) throw new Error('Brand asset exceeds the 15 MB limit.');
  const isRaster = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) || (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') || (bytes.toString('ascii', 4, 8) === 'ftyp' && ['avif', 'avis'].includes(bytes.toString('ascii', 8, 12)));
  if (!isRaster) throw new Error('Brand asset must be PNG, JPEG, WebP, or AVIF.');
  const metadata = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false }).metadata();
  if (!['jpeg', 'png', 'webp', 'avif', 'heif'].includes(metadata.format) || (metadata.pages ?? 1) > 1) throw new Error('Brand asset must be a single-frame raster.');
  const { data, info } = await sharp(bytes, { limitInputPixels: 40_000_000 }).rotate().resize(1800, 1800, { fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
  return { data, dataUrl: `data:image/png;base64,${data.toString('base64')}`, source: { sha256: hash(bytes), width: metadata.width, height: metadata.height, format: metadata.format }, normalized: { sha256: hash(data), width: info.width, height: info.height, fit: 'inside; no crop; EXIF orientation applied' } };
}

async function motion(campaign, asset, outputDir) {
  const size = SOCIAL_SIZES[2];
  const layers = [ ['base', ['background', 'brand']], ['copy', ['copy']], ['product', ['product']], ['cta', ['cta']] ];
  for (const [name, only] of layers) {
    const { svg } = composeCampaign(campaign, 0, size, asset?.dataUrl, { only });
    await writeFile(join(outputDir, `motion-${name}.svg`), svg);
    await sharp(Buffer.from(svg)).resize(720, 1280).png().toFile(join(outputDir, `motion-${name}.png`));
  }
  // Closing creative is a distinct composition and an uninterrupted 2-second CTA hold.
  const ending = composeCampaign(campaign, campaign.variants.length - 1, size, asset?.dataUrl, { endCard: true });
  const endCardQuality = await verifyLayout(ending);
  await writeFile(join(outputDir, 'motion-end.svg'), ending.svg);
  await sharp(Buffer.from(ending.svg)).resize(720, 1280).png().toFile(join(outputDir, 'motion-end.png'));
  const inputArgs = ['base', 'copy', 'product', 'cta', 'end'].flatMap(name => ['-loop', '1', '-framerate', '30', '-i', join(outputDir, `motion-${name}.png`)]);
  const filters = [
    '[0:v]format=rgba[b]',
    '[1:v]format=rgba,fade=t=in:st=0:d=0.45:alpha=1[c]',
    '[2:v]format=rgba,fade=t=in:st=0.7:d=0.5:alpha=1[p]',
    '[3:v]format=rgba,fade=t=in:st=1.5:d=0.4:alpha=1[a]',
    '[4:v]format=rgba,fade=t=in:st=5.4:d=0.6:alpha=1[e]',
    '[b][c]overlay=0:0:shortest=1[s1]',
    "[s1][p]overlay=x=0:y='48*pow(max(0,1-max(0,t-0.7)/1.3),3)':shortest=1[s2]",
    '[s2][a]overlay=0:0:shortest=1[s3]',
    '[s3]fade=t=out:st=5.1:d=0.3:color=0x14231c[clear]',
    '[clear][e]overlay=0:0:shortest=1,format=yuv420p[out]',
  ].join(';');
  const path = join(outputDir, 'campaign-motion.mp4');
  try {
    await exec(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-filter_complex_threads', '2', ...inputArgs, '-filter_complex', filters, '-map', '[out]', '-t', '8', '-r', '30', '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-map_metadata', '-1', '-movflags', '+faststart', path], { timeout: 90_000, maxBuffer: 1024 * 1024 });
    const { stdout } = await exec(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'format=duration:stream=codec_name,width,height,nb_read_frames,pix_fmt,r_frame_rate', '-of', 'json', path], { timeout: 30_000 });
    const probe = JSON.parse(stdout), video = probe.streams[0];
    if (video.codec_name !== 'h264' || video.width !== 720 || video.height !== 1280 || video.nb_read_frames !== '240' || Number(probe.format.duration) !== 8) throw new Error('Motion metadata/frame count mismatch.');
    await exec(process.env.FFMPEG_PATH || 'ffmpeg', ['-v', 'error', '-xerror', '-i', path, '-f', 'null', '-'], { timeout: 30_000 });
    return { duration: 8, fps: 30, width: 720, height: 1280, audio: false, decodedFrames: 240, probe, endCardQuality, timeline: [ { start: 0, end: .7, action: 'brand and headline reveal' }, { start: .7, end: 2, action: 'product ease-out rise; full screenshot remains intact' }, { start: 1.5, end: 5.4, action: 'CTA and product reading hold' }, { start: 5.4, end: 6, action: 'clear old copy through brand color; reveal closing concept' }, { start: 6, end: 8, action: 'uninterrupted end frame and CTA hold' } ] };
  } catch (error) {
    throw new Error(`Motion render/verification failed; static sources remain available. Qualified FFmpeg/libx264 and ffprobe are required. ${String(error.stderr || error.message).slice(0, 400)}`);
  }
}

/** Local, bounded, serial rendering. No models, network, downloads or shell evaluation. */
export async function renderCampaign(input, outDir) {
  const campaign = validateCampaign(input), outputDir = resolve(outDir);
  await mkdir(outputDir, { recursive: true });
  const files = [], checks = [];
  const register = async (name, type, extra = {}) => {
    const path = join(outputDir, name), bytes = await readFile(path);
    files.push({ name, path, type, bytes: bytes.length, sha256: hash(bytes), ...extra });
  };
  const asset = await normalizedAsset(campaign);
  if (asset) { await writeFile(join(outputDir, 'product.png'), asset.data); await register('product.png', 'source'); }
  // Validate every composition before producing any deliverable raster.
  const layouts = [];
  for (let variant = 0; variant < campaign.variants.length; variant++) for (const size of SOCIAL_SIZES) {
    const layout = composeCampaign(campaign, variant, size, asset?.dataUrl);
    const name = `campaign-${variant + 1}-${size.name}`;
    checks.push({ name, concept: layout.concept, ...await verifyLayout(layout) });
    layouts.push({ variant, size, layout, name });
  }
  for (const { variant, size, layout, name } of layouts) {
    await writeFile(join(outputDir, `${name}.svg`), layout.svg);
    await sharp(Buffer.from(layout.svg)).png().toFile(join(outputDir, `${name}.png`));
    const extra = { width: size.width, height: size.height, variant: variant + 1, concept: layout.concept };
    await register(`${name}.svg`, 'source', extra); await register(`${name}.png`, 'image', extra);
  }
  const motionResult = await motion(campaign, asset, outputDir);
  for (const name of ['base', 'copy', 'product', 'cta', 'end']) for (const ext of ['svg', 'png']) await register(`motion-${name}.${ext}`, 'source');
  await register('campaign-motion.mp4', 'video', { width: 720, height: 1280, duration: 8, fps: 30, audio: false });
  const { assetBuffer, assetPath, ...editable } = campaign;
  await writeFile(join(outputDir, 'campaign.json'), json({ schemaVersion: 2, ...editable, assetPath: asset ? 'product.png' : null, assetEmbeddedInSvg: Boolean(asset), asset: asset ? { source: asset.source, normalized: asset.normalized } : null, motion: motionResult, renderer: { engine: 'Sharp SVG + native FFmpeg', sharp: sharp.versions.sharp, vips: sharp.versions.vips, fonts: [campaign.tokens.font, campaign.tokens.displayFont], determinism: 'Fixed inputs, installed fonts and toolchain; no clocks, random seeds or model calls.' } }));
  await register('campaign.json', 'source');
  await writeFile(join(outputDir, 'quality.json'), json({ status: 'PASS', typography: 'Raster ink measured for every line', checks, video: motionResult.probe }));
  await register('quality.json', 'source');
  await writeFile(join(outputDir, 'CREATIVE-README.txt'), 'Editable sources: campaign.json, campaign-*.svg and motion-*.svg.\nPNG: 1080 square, 1080x1350 portrait, 1080x1920 story.\nMP4: H.264, yuv420p, 720x1280, 30fps, silent, 8 seconds. Final CTA holds from 6 to 8 seconds.\nAll supplied image pixels are preserved through contain framing. No AI-generated product imagery.\nFonts must be installed as named in campaign.json for identical rerenders.\nStory text is inside conservative top/bottom overlay margins; inspect for each destination platform.\nquality.json records measured text fitting, contrast, safe areas and video decode evidence.\n');
  await register('CREATIVE-README.txt', 'source');
  const result = { status: 'RENDERED', outputDir, files, renderer: 'Sharp SVG + native FFmpeg', warnings: ['Review campaign claims and asset rights before publication.', ...(!asset ? ['Product image not supplied; marked placeholder used.'] : []), 'Silent motion. Platform-specific overlay previews still require review.'] };
  await writeFile(join(outputDir, 'render.json'), json({ ...result, outputDir: '.', files: files.map(file => ({ ...file, path: file.name })) }));
  return result;
}
