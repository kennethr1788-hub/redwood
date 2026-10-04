import { mkdir, realpath, rename, rm, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { validateCampaign } from '../creative/index.js';
import { MAX_BYTES, hash, json, within, safePath, durableWrite, readContained, syncDirectory, verifyExport } from '../export/index.js';
import {preflightBinding} from '../preflight/index.js';
import { planFiles } from '../planner/index.js';
import { queueRoot, saveRecord, serialized } from './queue.js';
export { readDeliveryQueue, DELIVERY_STATUS } from './queue.js';
export { verifyExport, extractBundle, verifyBundle } from '../export/index.js';

const csvCell = value => {
  let text = String(value ?? '');
  // Protect spreadsheet imports, including whitespace-prefixed formulas.
  if (/^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};
const csv = (items, columns) => [columns, ...items.map(item => columns.map(key => Array.isArray(item[key]) ? item[key].join(';') : item[key]))].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
const caption = item => `${item.headline}\n\n${item.body}\n\n${item.cta}: ${item.url}\n`;
const time = value => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Calendar time must be a valid date with an explicit timezone.');
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day || Number(value.slice(11, 13)) > 23) throw new Error('Calendar time contains an invalid date.');
  return new Date(value).toISOString();
};

async function syncTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await syncTree(join(directory, entry.name));
  }
  await syncDirectory(directory);
}

/** Local export only: no external accounts, credentials, network, or publisher. */
export async function exportCampaign(input, projectDir) {
  const projectRoot = await realpath(projectDir);
  return serialized(projectRoot, () => build(input, projectRoot));
}

async function build({ campaign: input, render, content, scheduledAt, growthPlan, productPack, selection, preflight, research }, projectRoot) {
  const root = await queueRoot(projectRoot);
  const id = `export-${randomUUID()}`;
  const staging = join(root, `.building-${id}`);
  const exportDir = join(root, id);
  const createdAt = new Date().toISOString();
  const record = { id, status: 'DRAFT', createdAt, updatedAt: createdAt, publishedAt: null, exportedAt: null, scheduledAt: null, history: [{ status: 'DRAFT', at: createdAt }] };
  // Do not start writing assets if the existing queue cannot be read or saved.
  await saveRecord(projectRoot, record);
  let committed = false;
  try {
    if(growthPlan && (input.planRevision!==growthPlan.revision || render?.planRevision!==growthPlan.revision || input.stale || render?.stale))throw new Error('Growth plan changed. Seed and render again.');
    if(selection && (!preflight?.localExportReady || preflight.stale || preflight.blockers?.length || preflight.binding!==preflightBinding({campaign:input,render,productPack,growthPlan,selection})))throw new Error('Selection preflight is stale or not reviewed.');
    if(input.inputRevision&&(!selection||productPack?.review?.revision!==input.inputRevision||render?.inputRevision!==input.inputRevision))throw new Error('Product/Brand review or render is stale.');
    const campaign = validateCampaign(input);
    const planned = time(scheduledAt);
    if (render?.status !== 'RENDERED' || !Array.isArray(render.files) || render.files.length > 64 || !render.files.some(f => f.type === 'video') || !render.files.some(f => f.type === 'image')) throw new Error('Complete static and motion rendering before export.');
    const sourceRoot = await realpath(render.outputDir);
    within(projectRoot, sourceRoot);
    const payload = new Map();
    const assets = [];
    let total = 0;
    const add = (path, data) => {
      safePath(path);
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if ([...payload.keys()].some(key => key.toLowerCase() === path.toLowerCase())) throw new Error(`Duplicate export file: ${path}`);
      total += bytes.length;
      if (total > MAX_BYTES - 1024 * 1024) throw new Error('Bundle exceeds 64 MB limit');
      payload.set(path, bytes);
      return { path, bytes: bytes.length, sha256: hash(bytes) };
    };
    for (const file of render.files) {
      if (!file || typeof file.name !== 'string' || file.name !== basename(file.name)) throw new Error('Invalid rendered asset filename.');
      safePath(file.name);
      const bytes = await readContained(sourceRoot, file.name);
      if (hash(bytes) !== file.sha256 || (file.bytes != null && file.bytes !== bytes.length)) throw new Error(`Rendered asset changed: ${file.name}. Render again before export.`);
      if (!['image', 'video', 'source'].includes(file.type)) throw new Error('Unsupported rendered asset type');
      if (file.type === 'image') {
        const meta = await sharp(bytes, { limitInputPixels: 16_000_000 }).metadata();
        if (meta.format !== 'png' || !file.name.endsWith('.png') || meta.width !== file.width || meta.height !== file.height || (!Number.isInteger(file.variant) || file.variant < 1 || file.variant > campaign.variants.length)) throw new Error(`Invalid rendered image: ${file.name}`);
      }
      if (file.type === 'video' && (!file.name.endsWith('.mp4') || bytes.length < 1000 || bytes.toString('ascii', 4, 8) !== 'ftyp')) throw new Error('Invalid rendered MP4');
      // The renderer campaign source must match the current reviewed copy. Never
      // silently package old artwork under newly edited campaign copy.
      if (file.name === 'campaign.json') {
        const rendered = validateCampaign(JSON.parse(bytes));
        for (const key of ['brandName', 'headline', 'body', 'cta', 'url', 'color', 'variants']) {
          if (JSON.stringify(rendered[key]) !== JSON.stringify(campaign[key])) throw new Error('Campaign changed since rendering. Render again before export.');
        }
      }
      if (file.type === 'source' && !/\.(svg|json|png|txt)$/.test(file.name)) throw new Error('Unsupported editable source');
      if (file.type === 'source' && file.name.endsWith('.png')) {
        const meta = await sharp(bytes, {limitInputPixels: 16_000_000}).metadata();
        if (meta.format !== 'png') throw new Error('Invalid raster source');
      }
      const path = `${file.type === 'source' ? 'sources' : 'assets'}/${file.name}`;
      const descriptor = add(path, bytes); // Copy exactly the bytes that were hashed.
      assets.push({ name: file.name, type: file.type, ...descriptor, ...Object.fromEntries(['width', 'height', 'variant', 'duration', 'fps', 'audio'].filter(k => file[k] != null).map(k => [k, file[k]])) });
    }
    if (!render.files.some(f => f.name === 'campaign.json')) throw new Error('Missing rendered campaign source. Render again before export.');
    for (let variant = 1; variant <= campaign.variants.length; variant++) {
      for (const [width, height] of [[1080, 1080], [1080, 1350], [1080, 1920]]) {
        if (!assets.some(f => f.type === 'image' && f.variant === variant && f.width === width && f.height === height)) throw new Error(`Missing ${width}x${height} media for variant ${variant}. Render again before export.`);
      }
    }
    const now = new Date().toISOString();
    Object.assign(record, { status: 'READY', scheduledAt: planned, updatedAt: now });
    record.history.push({ status: 'READY', at: now });
    await saveRecord(projectRoot, record);
    const items = campaign.variants.map((variant, index) => ({
      id: `${id}-${index + 1}`, status: 'EXPORTED', publishedAt: null, scheduledAt: planned,
      platform: 'manual', variant: index + 1, ...variant, url: selection?.concept===variant.concept?selection.trackedUrl:campaign.url,
      assets: assets.filter(f => f.type === 'image' && f.variant === index + 1).map(f => f.path),
    })).filter(item=>!selection||item.concept===selection.concept);
    if(!selection || items[0]?.variant===1)items.push({ ...items[0], id: `${id}-motion`, variant: 'motion', assets: assets.filter(f => f.type === 'video').map(f => f.path) });
    const posts = [];
    for (const item of items) {
      const presets = item.variant === 'motion' ? [{ platform: 'instagram', placement: 'reel', type: 'video' }] : [
        { platform: 'instagram', placement: 'feed', width: 1080, height: 1350 },
        { platform: 'linkedin', placement: 'feed', width: 1080, height: 1080 },
        { platform: 'instagram', placement: 'story', width: 1080, height: 1920 },
      ];
      for (const preset of presets) {
        if(selection && preset.type!=='video' && !selection.ratios.includes(preset.height===1080?'square':preset.height===1350?'portrait':'story'))continue;
        const asset = assets.find(f => preset.type === 'video' ? f.type === 'video' : f.type === 'image' && f.variant === item.variant && f.width === preset.width && f.height === preset.height);
        const folder = `platforms/${preset.platform}-${preset.placement}/${item.variant === 'motion' ? 'motion' : `variant-0${item.variant}`}`;
        const media = `${folder}/${asset.name}`;
        add(media, payload.get(asset.path));
        add(`${folder}/caption.txt`, caption(item));
        const post = { ...item, id: `${item.id}-${preset.platform}-${preset.placement}`, platform: preset.platform, placement: preset.placement, assets: [media], captionPath: `${folder}/caption.txt`, altText: selection?`${selection.altText}${item.variant==='motion'?' Animated sequence, silent; review accessibility for the destination.':''}`:`${item.headline}. ${item.body}`, note: 'Manual upload. Review crop, accessibility text and current platform requirements. Calendar time does not schedule publication.' };
        add(`${folder}/post.json`, json(post));
        posts.push(post);
      }
    }
    add('calendar.csv', csv(posts, ['id', 'status', 'publishedAt', 'scheduledAt', 'platform', 'placement', 'headline', 'body', 'cta', 'url', 'assets', 'captionPath', 'altText']));
    add('calendar.json', json({ version: 1, timezone: 'UTC', scheduling: 'PLANNING_ONLY', items: posts }));
    add('copy.md', `# ${campaign.brandName}\n\nStatus: EXPORTED — not published.\n\n${items.map(item => `## ${item.variant}\n\n${caption(item)}\nMedia: ${item.assets.join(', ')}`).join('\n\n')}`);
    add('copy.json', json(items));
    // Whitelist portable campaign fields; exclude machine paths and image buffers.
    const portable = Object.fromEntries(['brandName', 'summary', 'headline', 'body', 'cta', 'url', 'color', 'confirmed', 'variants'].filter(k => campaign[k] !== undefined).map(k => [k, campaign[k]]));
    add('campaign-manifest.json', json({ version: 1, exportId: id, status: 'EXPORTED', publishedAt: null, campaign: portable, items, platformBundles: posts }));
    if (content != null) {
      const markdown = typeof content === 'string' ? content : content.markdown ?? content.article?.markdown;
      if (markdown != null) {
        if (typeof markdown !== 'string' || Buffer.byteLength(markdown) > 200_000) throw new Error('Article must be Markdown text smaller than 200 KB.');
        add('article.md', markdown);
      }
      if (typeof content === 'object') add('content.json', json(content));
    }
    if(research)add('research-and-learning.json',json(research));
    if(selection){add('placement-preflight.json',json(preflight));add('creative-selection.json',json(selection));}
    if(productPack&&input.inputRevision)add('product-brand-context.json',json({version:1,revision:productPack.revision,identity:productPack.identity,claims:productPack.claims,cta:productPack.cta,brand:productPack.brand,rightsNotes:productPack.rightsNotes,assets:productPack.assets,review:productPack.review,notice:'User-supplied context; hashes and local review do not independently establish facts or transfer authority. Unsupported claims are not campaign copy.'}));
    if(growthPlan)for(const [name,data] of Object.entries(planFiles(growthPlan)))add(name,data);
    add('README.txt', `GROW CAMPAIGN DELIVERY\n\nEXPORTED means files exist locally. Nothing is PUBLISHED.\n\n1. Open platforms/<platform-placement>/<variant>/ for paired media, caption.txt and post.json.\n2. Use calendar.csv in a spreadsheet or calendar.json in your own tools. Dates are UTC planning data only.\n3. Copy the caption and manually upload the matching media in your own account. Review accessibility text and placement first.\n4. Keep sources/ for editable SVG/campaign sources; assets/ contains all original rendered media.\n\nDownload bundle.json for the complete portable media/copy/calendar package. No account is required.\nFrom products/grow in this repository, extract into a NEW folder:\n  node src/export/index.js extract /path/to/bundle.json /path/to/new-campaign-folder\nVerify a folder:\n  node src/export/index.js verify /path/to/campaign-folder\n\nmanifest.json hashes every payload file. integrity.json also hashes manifest.json; it excludes itself and bundle.json to avoid circular hashes. The persistent queue anchors both the integrity inventory and bundle hashes. Hashes detect corruption, not authenticity.\n\nDraft means export attempt started; Ready means reviewed render inputs passed; Exported means completed local package; Failed means delivery or integrity check failed. Published is reserved for a real connector confirmation; no connector exists here.\n`);
    const describe = ([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) });
    const manifest = { version: 2, inputRevision:input.inputRevision||null,selection:selection||null,preflightStatus:preflight?.status||null, planRevision:growthPlan?.revision||null, id, status: 'EXPORTED', publishedAt: null, exportedAt: now, brandName: campaign.brandName, targetUrl: campaign.url, delivery: 'Manual upload required. A calendar time does not schedule publication.', assets, items, platformBundles: posts, files: [...payload].map(describe) };
    add('manifest.json', json(manifest));
    add('integrity.json', json({ version: 1, algorithm: 'SHA-256', excludes: ['integrity.json', 'bundle.json'], files: [...payload].map(describe) }));
    const bundle = json({ version: 1, format: 'launchforge-grow-bundle', files: [...payload].map(([path, bytes]) => ({ ...describe([path, bytes]), encoding: 'base64', data: bytes.toString('base64') })) });
    await mkdir(staging);
    for (const [path, bytes] of payload) await durableWrite(join(staging, path), bytes);
    await durableWrite(join(staging, 'bundle.json'), bundle);
    const integrity = await verifyExport(staging, hash(payload.get('integrity.json')));
    await syncTree(staging);
    await rename(staging, exportDir);
    committed = true;
    await syncDirectory(root);
    Object.assign(record, { status: 'EXPORTED', exportedAt: now, updatedAt: new Date().toISOString(), path: `exports/${id}`, manifest: `exports/${id}/manifest.json`, integritySha256: integrity.integritySha256, bundleSha256: integrity.bundleSha256 });
    record.history.push({ status: 'EXPORTED', at: record.updatedAt });
    await saveRecord(projectRoot, record);
    // The existing UI presents this list in order: put the complete download and
    // immediately useful documents ahead of the individual source/media files.
    const primary = ['bundle.json', 'README.txt', ...(growthPlan ? Object.keys(planFiles(growthPlan)) : []), 'calendar.csv', 'calendar.json', 'copy.md', 'copy.json', 'campaign-manifest.json', 'manifest.json', 'integrity.json'];
    const files = [...primary, ...[...payload.keys()].filter(path => !primary.includes(path))].map(path => ({ name: path, type: assets.find(a => a.path === path)?.type || 'source', path: join(exportDir, path), relativePath: `exports/${id}/${path}`, sha256: path === 'bundle.json' ? hash(bundle) : hash(payload.get(path)) }));
    return { ...manifest, exportDir, directory: exportDir, files, scheduledAt: planned, path: record.path, manifestPath: join(exportDir, 'manifest.json'), calendarPath: join(exportDir, 'calendar.csv'), bundlePath: join(exportDir, 'bundle.json'), integritySha256: integrity.integritySha256, bundleSha256: integrity.bundleSha256 };
  } catch (error) {
    let cleanupError;
    try { await rm(staging, { recursive: true, force: true }); }
    catch (failure) { cleanupError = failure.message; }
    Object.assign(record, { status: 'FAILED', updatedAt: new Date().toISOString(), error: error.message, completePackageOnDisk: committed, ...(cleanupError ? { cleanupError } : {}) });
    record.history.push({ status: 'FAILED', at: record.updatedAt });
    try { await saveRecord(projectRoot, record); }
    catch (persistenceError) { throw new Error(`Export failed: ${error.message}. Queue persistence failed: ${persistenceError.message}`, { cause: error }); }
    throw Object.assign(error, { deliveryId: id, deliveryStatus: 'FAILED' });
  }
}
