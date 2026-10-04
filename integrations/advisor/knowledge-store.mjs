import { constants, openSync, closeSync, fstatSync, readSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KNOWLEDGE_DOCUMENTS } from '../../docs/advisor/knowledge.mjs';
import { requireValue } from '../agents/contract.mjs';
import { LIMITS, safeText } from './contracts.mjs';

const root = new URL('../../docs/advisor/', import.meta.url);
const allowed = new Set(KNOWLEDGE_DOCUMENTS.map(d => d.path));

// Fixed source-owned paths only. No recursive walk, configurable root, user path,
// network or source/project ingestion. Bounds apply before allocating/reading.
export function readKnowledgeDocument(relative) {
  requireValue(allowed.has(relative), 'DOCUMENT_NOT_INDEXED');
  const parts = relative.split('/');
  requireValue(parts.every(p => /^[a-zA-Z0-9_.-]+$/.test(p) && p !== '.' && p !== '..'), 'DOCUMENT_PATH');
  let directory = root;
  for (const part of ['', ...parts.slice(0, -1)]) {
    if (part) directory = new URL(part + '/', directory);
    const stat = lstatSync(directory);
    requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'DOCUMENT_DIRECTORY');
  }
  const fd = openSync(fileURLToPath(new URL(relative, root)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    requireValue(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= LIMITS.documentBytes, 'DOCUMENT_SIZE_OR_TYPE');
    const buffer = Buffer.alloc(LIMITS.documentBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    requireValue(length === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs, 'DOCUMENT_CHANGED');
    const body = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    safeText(body, LIMITS.sectionChars); return body;
  } finally { closeSync(fd); }
}
