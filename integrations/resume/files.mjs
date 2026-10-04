import {constants} from 'node:fs';
import {lstat, open, realpath, rename, unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {relativePath} from './validation.mjs';

// Bounded owner-controlled I/O; no crawling and no provider or HOME discovery.
export async function containedFile(root, relative, missing = false) {
  relativePath(relative);
  if (!path.isAbsolute(root) || await realpath(root) !== root) throw Error('Use a canonical project root.');
  let current = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await lstat(current); }
    catch (error) { if (missing && i === parts.length - 1 && error.code === 'ENOENT') return current; throw error; }
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw Error('Expected ordinary contained files.');
  }
  return current;
}

export async function readBounded(root, relative, max = 262144) {
  const filename = await containedFile(root, relative);
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) throw Error('File exceeds the bounded regular-file contract.');
    const bytes = Buffer.alloc(max + 1);
    let length = 0;
    while (length <= max) { const result = await file.read(bytes, length, max + 1 - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
    if (length > max) throw Error('File exceeds byte limit.');
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

export async function writeDerived(root, relative, content) {
  if (Buffer.byteLength(content) > 262144) throw Error('Derived output exceeds byte limit.');
  const target = await containedFile(root, relative, true);
  const temp = target + '.' + randomUUID() + '.tmp';
  const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(content); await file.sync(); }
  finally { await file.close(); }
  try {
    await containedFile(root, relative, true);
    await rename(temp, target);
    const directory = await open(path.dirname(target), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}
