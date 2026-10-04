import { mkdir, open, rename, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';

export const MAX_BYTES = 64 * 1024 * 1024;
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = value => JSON.stringify(value, null, 2) + '\n';
export function safePath(path) {
  if (typeof path !== 'string' || path.length > 200 || !/^[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) throw new Error('Unsafe bundle path');
  return path;
}
export function within(root, path) {
  const rel = relative(root, path);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('Export asset must stay inside the project.');
}
export async function syncDirectory(dir) {
  const handle = await open(dir, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function durableWrite(file, bytes) {
  await mkdir(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.write-${randomUUID()}`);
  try {
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temp, file);
    await syncDirectory(dirname(file));
  }
  finally { await rm(temp, { force: true }); }
}
export async function readBounded(file, max = MAX_BYTES * 2) {
  // Refuse symlinks and special files at open time, including FIFO blocking.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) throw new Error('Expected a bounded regular file');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('File changed while reading');
      offset += bytesRead;
    }
    if ((await handle.stat()).size !== info.size) throw new Error('File changed while reading');
    return bytes;
  } finally { await handle.close(); }
}
export async function readContained(root, path) {
  safePath(path);
  const file = join(root, path);
  within(root, await realpath(file));
  return readBounded(file, MAX_BYTES);
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 512) throw new Error('Invalid integrity inventory');
  const seen = new Set();
  let total = 0;
  for (const entry of entries) {
    safePath(entry?.path);
    const key = entry.path.toLowerCase();
    if (seen.has(key) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Invalid or duplicate integrity entry');
    seen.add(key); total += entry.bytes;
    if (total > MAX_BYTES) throw new Error('Bundle exceeds 64 MB limit');
  }
}

/** Hashes detect corruption, not publisher identity or a maliciously replaced hash inventory. */
export function verifyBundle(bundle) {
  if (bundle?.version !== 1 || bundle.format !== 'launchforge-grow-bundle' || !Array.isArray(bundle.files)) throw new Error('Unsupported bundle');
  validateEntries(bundle.files);
  const files = new Map();
  for (const file of bundle.files) {
    if (file.encoding !== 'base64' || typeof file.data !== 'string' || file.data.length > MAX_BYTES * 1.4) throw new Error('Invalid bundle encoding');
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.toString('base64') !== file.data || bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error(`Bundle integrity failed: ${file.path}`);
    files.set(file.path, bytes);
  }
  verifyInventory(files);
  return files;
}

function verifyInventory(files) {
  const inventory = JSON.parse(files.get('integrity.json')?.toString() || 'null');
  if (inventory?.version !== 1 || inventory.algorithm !== 'SHA-256') throw new Error('Missing integrity inventory');
  validateEntries(inventory.files);
  if (inventory.files.length !== files.size - 1 || inventory.files.some(f => f.path === 'integrity.json')) throw new Error('Incomplete integrity inventory');
  for (const entry of inventory.files) {
    const bytes = files.get(entry.path);
    if (!bytes || bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error(`Integrity failed: ${entry.path}`);
  }
  const manifest = JSON.parse(files.get('manifest.json')?.toString() || 'null');
  if (manifest?.version !== 2 || manifest.status !== 'EXPORTED' || manifest.publishedAt !== null) throw new Error('Invalid export manifest status');
  validateEntries(manifest.files);
  if (manifest.files.length !== files.size - 2 || manifest.files.some(f => ['manifest.json', 'integrity.json'].includes(f.path))) throw new Error('Incomplete export manifest');
  for (const entry of manifest.files) {
    const bytes = files.get(entry.path);
    if (!bytes || bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw new Error(`Manifest integrity failed: ${entry.path}`);
  }
  return manifest;
}

export async function verifyExport(directory, expectedIntegrityHash) {
  const root = await realpath(directory);
  const files = new Map();
  let total = 0;
  const walk = async (dir, prefix = '') => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = safePath(`${prefix}${entry.name}`);
      if (entry.isSymbolicLink()) throw new Error('Symlinks are not export files');
      if (entry.isDirectory()) await walk(join(dir, entry.name), `${path}/`);
      else {
        if (files.size >= 513) throw new Error('Too many export files');
        within(root, await realpath(join(root, path)));
        const bytes = await readBounded(join(root, path), path === 'bundle.json' ? MAX_BYTES * 2 : MAX_BYTES);
        total += bytes.length;
        if (total > MAX_BYTES * 3) throw new Error('Export exceeds size limit');
        files.set(path, bytes);
      }
    }
  };
  await walk(root);
  const archive = files.get('bundle.json');
  files.delete('bundle.json');
  if (expectedIntegrityHash && hash(files.get('integrity.json') || '') !== expectedIntegrityHash) throw new Error('Integrity inventory changed');
  const manifest = verifyInventory(files);
  if (!archive) throw new Error('Missing downloadable bundle');
  const archived = verifyBundle(JSON.parse(archive));
  if (archived.size !== files.size || [...files].some(([path, bytes]) => !bytes.equals(archived.get(path) || Buffer.alloc(0)))) throw new Error('Bundle does not match exported files');
  return { valid: true, id: manifest.id, files: files.size, integritySha256: hash(files.get('integrity.json')), bundleSha256: hash(archive) };
}

/** Extract only into a NEW directory; validate all bytes before creating any output. */
export async function extractBundle(bundleFile, destination) {
  const archive = await readBounded(bundleFile);
  const files = verifyBundle(JSON.parse(archive));
  const target = resolve(destination);
  await mkdir(target); // EEXIST is deliberate: never overwrite a user's directory.
  try {
    for (const [path, bytes] of files) await durableWrite(join(target, path), bytes);
    await durableWrite(join(target, 'bundle.json'), archive);
    return await verifyExport(target);
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [action, input, output] = process.argv.slice(2);
    if (action === 'verify' && input && !output) console.log(json(await verifyExport(input)));
    else if (action === 'extract' && input && output) console.log(json(await extractBundle(input, output)));
    else throw new Error('Usage: node src/export/index.js verify <export-folder> | extract <bundle.json> <new-folder>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
