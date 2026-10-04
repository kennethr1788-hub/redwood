// Synthetic fixture only; it neither executes argv nor loads a provider/client.
process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));
