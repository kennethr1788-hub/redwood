import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { BridgeError, freeze, requireValue, validateTask } from './contract.mjs';

// Bounded metadata-only inspection; no directory crawl, content reads, writes or execution.
// A preflight observation is not an OS sandbox or protection against later path swaps.
export function inspectTaskPaths(input) {
  const task = validateTask(input);
  function inspect(absolute, kind, allowMissing) {
    const parts = absolute.split('/').filter(Boolean);
    let current = '/'; let missing = false;
    for (let i = 0; i < parts.length; i++) {
      current = path.posix.join(current, parts[i]);
      if (missing) continue;
      let stat;
      try { stat = lstatSync(current); }
      catch (error) {
        if (error.code === 'ENOENT' && allowMissing) { missing = true; continue; }
        throw new BridgeError('LOCAL_PATH_UNAVAILABLE');
      }
      requireValue(!stat.isSymbolicLink(), 'LOCAL_SYMLINK_REJECTED');
      const expectedDirectory = i < parts.length - 1 || kind === 'directory';
      requireValue(expectedDirectory ? stat.isDirectory() : stat.isFile(), 'LOCAL_FILE_TYPE_REJECTED');
      if (stat.isFile()) requireValue(stat.nlink === 1, 'LOCAL_HARDLINK_REJECTED');
    }
    return missing ? 'MISSING' : 'PRESENT';
  }
  inspect(task.workspace, 'directory', false);
  requireValue(realpathSync(task.workspace) === task.workspace, 'LOCAL_WORKSPACE_ALIAS_REJECTED');
  const observed = [];
  const requests = [
    ...task.inputs.map(i => [i.path, 'file', false]),
    ...task.commands.map(c => [c.cwd, 'directory', false]),
    ...task.evidencePaths.map(p => [p, 'file', true]),
    [task.expectedReceiptPath, 'file', true],
    ['.launchforge/agent-task.json', 'file', true],
    ['.launchforge/agent-task.md', 'file', true],
  ];
  for (const [relative, kind, optional] of requests) {
    observed.push({ path: relative, state: inspect(path.posix.join(task.workspace, relative), kind, optional) });
  }
  return freeze({ workspace: task.workspace, observed, contentHashesVerified: false, executionAuthorized: false });
}
