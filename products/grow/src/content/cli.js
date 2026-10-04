import {fileURLToPath} from 'node:url';
import {createContentProject, openContentProject, readOrdinaryFile} from './project.js';

const usage = `Grow content: existing official coding tool first; no model backend.
  node src/content/cli.js init --audit AUDIT.json [--intake INTAKE.json] --out NEW_DIRECTORY
  node src/content/cli.js review --project DIRECTORY
init accepts a crawl record or a saved Grow project with an audit field.
review reopens editor bytes, recomputes the ledger, and prints review requirements.
No command publishes content or marks it fact-verified.`;

export async function run(args) {
  if (!args.length || args[0] === '--help') return {help: usage};
  const [command, ...rest] = args;
  const allowed = command === 'init' ? ['--audit', '--intake', '--out'] : command === 'review' ? ['--project'] : [];
  if (!allowed.length || rest.length % 2) throw new Error(usage);
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!allowed.includes(rest[i]) || options[rest[i]] || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(usage);
    options[rest[i]] = rest[i + 1];
  }
  if (command === 'review') {
    if (!options['--project']) throw new Error(usage);
    return (await openContentProject(options['--project'])).report;
  }
  if (!options['--audit'] || !options['--out']) throw new Error(usage);
  const input = JSON.parse(await readOrdinaryFile(options['--audit']));
  const intake = options['--intake'] ? JSON.parse(await readOrdinaryFile(options['--intake'])) : {};
  return createContentProject(options['--out'], input?.audit ?? input, intake);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
