import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Exact qualified CLI interface. A subprocess failure never selects a fallback. */
export async function runUnlighthouse({ configPath, outputDir, logPath, executablePath, deadlineMs = 180000, killGraceMs = 5000 }) {
  const log = await open(logPath, 'a');
  try {
    await new Promise((resolve, reject) => {
      const executable = fileURLToPath(new URL('../../node_modules/.bin/unlighthouse-ci', import.meta.url));
      const child = spawn(executable, ['--config-file', configPath, '--output-path', outputDir, '--no-cache', '--reporter', 'jsonExpanded'], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: { ...process.env, GROW_CHROME_PATH: executablePath }, stdio: ['ignore', log.fd, log.fd], detached: true,
      });
      let timedOut = false;
      const killGroup = signal => { if (!child.pid) return; try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') reject(error); } };
      const timer = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); }, deadlineMs);
      const hardTimer = setTimeout(() => killGroup('SIGKILL'), deadlineMs + killGraceMs);
      child.once('error', error => { clearTimeout(timer); clearTimeout(hardTimer); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (!timedOut) clearTimeout(hardTimer);
        if (code === 0 && !timedOut) resolve();
        else reject(new Error(`Unlighthouse failed: code=${code} signal=${signal} timedOut=${timedOut}; log=${logPath}`));
      });
    });
  } finally { await log.close(); }
}
