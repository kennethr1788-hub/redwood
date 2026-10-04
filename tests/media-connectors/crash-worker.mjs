import { RequestJournal } from '../../integrations/media/journal.mjs';
const [root, id] = process.argv.slice(2);
const journal = new RequestJournal({ root });
try { journal.arm(id); process.stdout.write('ARMED'); }
catch { process.stdout.write('REFUSED'); }
// Deliberately exit without close/checkpoint to test SQLite's WAL durability.
process.exit(0);
