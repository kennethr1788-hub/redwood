import {lstat, readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {importUnlighthouseRun} from './lighthouse-report.js';

/** Read only native files from an explicitly selected qualified CLI output directory. */
export async function importUnlighthouseDirectory(directory, options) {
  const root = path.resolve(directory);
  const read = async file => {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10_000_000) throw new Error('Expected an ordinary report file under 10 MB.');
    return readFile(file);
  };
  const reports = []; let entriesSeen = 0; let totalBytes = 0;
  async function walk(dir, depth = 0) {
    if (depth > 12) throw new Error('Report directory exceeds the depth limit.');
    for (const entry of await readdir(dir, {withFileTypes: true})) {
      if (++entriesSeen > 500) throw new Error('Report directory exceeds the entry limit.');
      if (entry.isSymbolicLink()) throw new Error('Symlinked report entries are unsupported.');
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file, depth + 1);
      else if (entry.name === 'lighthouse.json') {
        const report = await read(file); totalBytes += report.length;
        if (reports.length >= 100 || totalBytes > 40_000_000) throw new Error('Native reports exceed the import limit.');
        reports.push({path: path.relative(root, file), report});
      }
    }
  }
  const reportDir = path.join(root, 'reports');
  try {
    const stat = await lstat(reportDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Expected an ordinary reports directory.');
    await walk(reportDir);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return importUnlighthouseRun({...options, ciReport: await read(path.join(root, 'ci-result.json')), reports});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [directory, manifest] = process.argv.slice(2);
    if (!directory || !manifest) throw new Error('Usage: node src/audit/import-unlighthouse.js RUN_DIRECTORY COVERAGE_MANIFEST.json');
    const stat = await lstat(manifest);
    if (!stat.isFile() || stat.size > 100_000) throw new Error('Coverage manifest must be a JSON file under 100 KB.');
    const options = JSON.parse(await readFile(manifest, 'utf8'));
    const result = await importUnlighthouseDirectory(directory, options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === 'FAILED') process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
