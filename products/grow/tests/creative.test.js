import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { defaultCampaign, validateCampaign } from '../src/creative/index.js';
import { campaignSvg, renderCampaign, SOCIAL_SIZES } from '../src/render/index.js';
import { exportCampaign } from '../src/delivery/index.js';

const exec = promisify(execFile);
const draft = () => defaultCampaign({ url: 'https://example.com/', pages: [{ url: 'https://example.com/', title: 'Fieldwork — Better planning', h1: ['Make room for your best work.'], description: 'A shared space for thoughtful teams to plan projects and keep ideas moving.' }] });

test('brand extraction and confirmation are explicit; text is safely escaped', async () => {
  const campaign = draft();
  assert.equal(campaign.confirmed, false);
  assert.equal(campaign.brandName, 'Fieldwork');
  assert.throws(() => validateCampaign(campaign), /Confirm/);
  campaign.confirmed = true;
  campaign.variants[0].headline = '<script>alert("hello")</script>';
  const svg = campaignSvg(validateCampaign(campaign), 0, SOCIAL_SIZES[0]);
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.ok(!svg.includes('<script>'));
  assert.throws(() => validateCampaign({ ...campaign, color: 'url(http://bad)' }), /color/);
  assert.throws(() => validateCampaign({ ...campaign, url: 'javascript:alert(1)' }), /HTTP/);
});

test('renders six static sizes and animated video; exports immutable EXPORTED planning queue', { timeout: 120_000 }, async () => {
  const work = resolve('.work');
  await mkdir(work, { recursive: true });
  const project = await mkdtemp(join(work, 'creative-test-'));
  try {
    const campaign = { ...draft(), confirmed: true };
    campaign.assetBuffer = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#345678' } }).png().toBuffer();
    const render = await renderCampaign(campaign, join(project, 'campaigns', 'one'));
    assert.equal(render.files.filter(file => file.type === 'image').length, 6);
    assert.equal(render.files.filter(file => file.type === 'video').length, 1);
    for (const file of render.files.filter(file => file.type === 'image')) {
      const metadata = await sharp(file.path).metadata();
      assert.equal(metadata.width, file.width);
      assert.equal(metadata.height, file.height);
    }
    const video = render.files.find(file => file.type === 'video');
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_name', '-of', 'json', video.path]);
    const probe = JSON.parse(stdout);
    assert.equal(probe.streams[0].codec_name, 'h264');
    assert.equal(probe.streams[0].width, 720);
    assert.ok(Number(probe.format.duration) >= 3.9);
    const frame1 = join(project, 'frame-1.png');
    const frame2 = join(project, 'frame-2.png');
    await exec('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', video.path, '-frames:v', '1', '-threads', '2', frame1]);
    await exec('ffmpeg', ['-v', 'error', '-y', '-ss', '2.8', '-i', video.path, '-frames:v', '1', '-threads', '2', frame2]);
    assert.notDeepEqual(await readFile(frame1), await readFile(frame2), 'motion frames must differ');
    const exported = await exportCampaign({ campaign, render, content: '# Editable article', scheduledAt: '2026-10-04T12:00:00Z' }, project);
    assert.equal(exported.status, 'EXPORTED');
    assert.equal(exported.publishedAt, null);
    assert.equal(exported.items.length, 3);
    assert.ok((await readFile(join(exported.directory, 'calendar.csv'), 'utf8')).includes('EXPORTED'));
    assert.equal(await readFile(join(exported.directory, 'article.md'), 'utf8'), '# Editable article');
    const queue = JSON.parse(await readFile(join(project, 'exports', 'queue.json')));
    assert.equal(queue.items[0].status, 'EXPORTED');
    await writeFile(render.files[0].path, 'tampered');
    await assert.rejects(exportCampaign({ campaign, render }, project), /changed/);
  } finally { await rm(project, { recursive: true, force: true }); }
});

test('missing meta description falls back to observed page text for all three concepts',()=>{
 const c=defaultCampaign({url:'https://example.com/',pages:[{title:'Notes',description:'',text:'Capture field observations.',h1:['Notes']} ]},{conceptCount:3});
 assert.equal(c.summary,'Capture field observations.');
 const confirmed=validateCampaign({...c,confirmed:true});
 assert.equal(confirmed.variants.length,3);
 assert(confirmed.variants.every(v=>v.body==='Capture field observations.'));
});
