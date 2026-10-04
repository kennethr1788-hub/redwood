import { mkdir, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { durableWrite, json, readBounded, within, verifyExport, syncDirectory } from '../export/index.js';

export const DELIVERY_STATUS = Object.freeze({ DRAFT: 'DRAFT', READY: 'READY', EXPORTED: 'EXPORTED', PUBLISHED: 'PUBLISHED', FAILED: 'FAILED' });
const idPattern = /^export-[a-f0-9-]{36}$/;
// Bounded stripes avoid one permanent lock per project. Records, not the snapshot,
// are authoritative across processes; each export writes its own UUID record.
const lanes = Array.from({ length: 16 }, () => Promise.resolve());
export async function serialized(root, run) {
  const index = [...root].reduce((sum, c) => (sum + c.charCodeAt(0)) % lanes.length, 0);
  const result = lanes[index].then(run);
  lanes[index] = result.catch(() => {});
  return result;
}
export async function queueRoot(projectDir) {
  const project = await realpath(projectDir);
  const root = join(project, 'exports');
  await mkdir(root, { recursive: true });
  within(project, await realpath(root));
  const records = join(root, 'queue');
  await mkdir(records, { recursive: true });
  within(root, await realpath(records));
  await syncDirectory(root);
  await syncDirectory(project);
  return root;
}
function validateRecord(item) {
  if (!item || !idPattern.test(item.id) || !['DRAFT', 'READY', 'EXPORTED', 'FAILED'].includes(item.status) || item.publishedAt !== null) throw new Error('Invalid export queue record (no publisher is connected)');
  if (item.path && item.path !== `exports/${item.id}`) throw new Error('Invalid export queue path');
  if (item.manifest && item.manifest !== `exports/${item.id}/manifest.json`) throw new Error('Invalid queue manifest path');
  return item;
}
export async function readDeliveryQueue(projectDir, { verify = false } = {}) {
  const root = await queueRoot(projectDir);
  const entries = new Map();
  try {
    const old = JSON.parse(await readBounded(join(root, 'queue.json')));
    if (![1, 2].includes(old.version) || !Array.isArray(old.items)) throw new Error('Invalid export queue');
    // Only v1 needs migration. v2 is a convenience snapshot of queue/*.json.
    if (old.version === 1) for (const item of old.items) entries.set(validateRecord(item).id, item);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const name of await readdir(join(root, 'queue'))) {
    if (!name.endsWith('.json')) continue;
    const item = validateRecord(JSON.parse(await readBounded(join(root, 'queue', name), 1024 * 1024)));
    if (name !== `${item.id}.json`) throw new Error('Queue record identity mismatch');
    entries.set(item.id, item);
  }
  const items = [...entries.values()].sort((a, b) => (a.createdAt || a.exportedAt || '').localeCompare(b.createdAt || b.exportedAt || '') || a.id.localeCompare(b.id));
  if (verify) for (const item of items) {
    if (item.status !== 'EXPORTED') continue;
    try {
      if (!item.integritySha256) throw new Error('Legacy export has no full-file integrity inventory');
      const checked = await verifyExport(join(root, item.id), item.integritySha256);
      if (checked.id !== item.id || checked.bundleSha256 !== item.bundleSha256) throw new Error('Downloadable bundle changed');
      item.integrity = 'VALID';
    } catch (error) { item.status = 'FAILED'; item.integrity = 'FAILED'; item.error = error.message; }
  }
  return { version: 2, mode: 'EXPORT_ONLY', items };
}
export async function saveRecord(projectDir, item) {
  validateRecord(item);
  const root = await queueRoot(projectDir);
  // Migrate the legacy entries before replacing its index.
  const prior = await readDeliveryQueue(projectDir);
  for (const old of prior.items.filter(old => old.legacy !== false)) {
    await durableWrite(join(root, 'queue', `${old.id}.json`), json({ ...old, legacy: false }));
  }
  await durableWrite(join(root, 'queue', `${item.id}.json`), json({ ...item, legacy: false }));
  await durableWrite(join(root, 'queue.json'), json(await readDeliveryQueue(projectDir)));
}

// There is deliberately no setStatus / markPublished API. A calendar date is
// planning metadata. PUBLISHED is reserved for a future confirmed connector.

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node src/delivery/queue.js <project-directory>');
    const queue = await readDeliveryQueue(process.argv[2], { verify: true });
    console.log(json(queue));
    if (queue.items.some(item => item.status !== 'EXPORTED')) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
