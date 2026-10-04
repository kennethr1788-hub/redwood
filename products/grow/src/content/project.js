import {mkdir, open, readFile, lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {buildContent} from './index.js';
import {digest} from './ledger.js';
import {validateMarkdown} from './markdown.js';

const json = value => JSON.stringify(value, null, 2) + '\n';
const INPUTS = ['audit.json', 'intake.json'];
const OUTPUTS = ['article.md', 'article.html', 'faq.json', 'metadata.json', 'blocks.json', 'suggestions.json', 'ledger.json', 'schema.json', 'EDITING.md'];
const FILES = [...INPUTS, ...OUTPUTS];
const LIMIT = 2_000_000;

export async function readOrdinaryFile(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > LIMIT) throw new Error('Content input must be an ordinary file under 2 MB.');
    // A bounded read also handles a file growing after stat.
    const buffer = Buffer.alloc(LIMIT + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const {bytesRead} = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > LIMIT) throw new Error('Content input exceeds 2 MB.');
    return buffer.subarray(0, offset).toString('utf8');
  } finally { await handle.close(); }
}

/** New directory only. Never replace an editor's article during generation.
 * The final manifest marks a complete bundle; a partial init cannot be reopened.
 */
export async function createContentProject(directory, audit, intake = {}) {
  const content = buildContent(audit, intake);
  const files = {
    'audit.json': json(audit), 'intake.json': json(intake),
    'article.md': content.markdown, 'article.html': content.html,
    'faq.json': json(content.faq), 'metadata.json': json(content.metadata),
    'blocks.json': json(content.blocks), 'suggestions.json': json(content.suggestions),
    'ledger.json': json(content.ledger), 'schema.json': json(content.jsonLd),
    'EDITING.md': await readFile(new URL('./EDITING.md', import.meta.url), 'utf8'),
  };
  if (Object.values(files).some(value => Buffer.byteLength(value) > LIMIT)) throw new Error('Content project file exceeds 2 MB.');
  const manifest = {
    schemaVersion: 1, status: 'DRAFT_REQUIRES_REVIEW',
    files: Object.fromEntries(FILES.map(name => [name, digest(files[name])])),
    policy: 'Checksums detect edits relative to this writable local baseline, not human approval. Nothing is automatically published or certified.',
  };
  await mkdir(directory); // EEXIST is intentional, including for symlinks.
  async function writeNew(name, value) {
    const handle = await open(path.join(directory, name), 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync(); }
    finally { await handle.close(); }
  }
  for (const name of FILES) await writeNew(name, files[name]);
  await writeNew('content.project.json', json(manifest));
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
  return {directory: path.resolve(directory), status: manifest.status, files: [...FILES, 'content.project.json']};
}

/** Reads current editor bytes without rewriting them. Recompute provenance from
 * source inputs instead of trusting editable ledger status fields or hashes.
 */
export async function openContentProject(directory) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Choose an ordinary content project directory.');
  const manifest = JSON.parse(await readOrdinaryFile(path.join(directory, 'content.project.json')));
  if (manifest?.schemaVersion !== 1 || !manifest.files || FILES.some(name => !/^[a-f0-9]{64}$/.test(manifest.files[name]))) throw new Error('Invalid content project manifest.');
  const files = {};
  for (const name of FILES) files[name] = await readOrdinaryFile(path.join(directory, name));
  for (const name of FILES.filter(name => name.endsWith('.json'))) {
    try { JSON.parse(files[name]); } catch { throw new Error(`Invalid JSON in ${name}; edit preserved.`); }
  }
  validateMarkdown(files['article.md']);
  const current = buildContent(JSON.parse(files['audit.json']), JSON.parse(files['intake.json']));
  const changedFiles = FILES.filter(name => digest(files[name]) !== manifest.files[name]);
  const inputsChanged = INPUTS.some(name => changedFiles.includes(name));
  const ledgerMatches = json(current.ledger) === files['ledger.json'];
  const report = {
    status: 'DRAFT_REQUIRES_REVIEW', changedFiles, inputsChanged, ledgerMatches,
    unsupportedFacts: current.ledger.facts.filter(fact => fact.status !== 'SOURCE_BACKED'),
    artifacts: Object.fromEntries(OUTPUTS.filter(name => name !== 'EDITING.md').map(name => [name,
      inputsChanged ? 'STALE_INPUTS_REVIEW_REQUIRED' : changedFiles.includes(name) ? 'EDITED_UNVERIFIED' : 'GENERATED_DRAFT_REQUIRES_REVIEW'])),
    warnings: [
      'Exact source matches are provenance, not independent fact verification or publishing approval.',
      'Arbitrary edits are not semantically fact-checked. Citation IDs alone do not validate rewritten claims.',
      'Markdown and HTML are independent editable copies; changes are never silently synchronized.',
      ...(!ledgerMatches ? ['Saved ledger differs from recomputed source provenance. Use the recomputed ledger; reconcile manually.'] : []),
    ],
  };
  return {files, ledger: current.ledger, report};
}
