import path from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { RecentProjectPointer } from './contracts.mjs';
import { fail } from './validation.mjs';

/** Read-only resolver for a private navigation pointer, never product state.
 * Root is trusted configuration; stored paths are relative. Existing components
 * must be ordinary directories/files. No symlink or nonexistent-path guessing.
 * The integrating owner must revalidate immediately before I/O; this is not a
 * concurrent hostile-filesystem sandbox or an open file capability.
 */
export async function resolveRecentProjectPointer(input, allowedRoot) {
  const pointer = RecentProjectPointer.parse(input);
  if (typeof allowedRoot !== 'string' || !path.isAbsolute(allowedRoot)) fail('Configured root must be absolute');
  const root = await realpath(allowedRoot);
  if (!(await lstat(root)).isDirectory()) fail('Configured root must be a directory');
  async function resolveUnder(base, relative, directory) {
    let current = base;
    const components = relative.split('/');
    for (let i = 0; i < components.length; i++) {
      current = path.join(current, components[i]);
      const info = await lstat(current);
      if (info.isSymbolicLink() || (i < components.length - 1 || directory ? !info.isDirectory() : !info.isFile())) fail('Pointer must reference ordinary contained paths');
    }
    const resolved = await realpath(current);
    if (!resolved.startsWith(base + path.sep)) fail('Pointer escapes configured root');
    return resolved;
  }
  const projectPath = await resolveUnder(root, pointer.localPath, true);
  const resumePath = await resolveUnder(projectPath, pointer.resumePath, false);
  return { pointer, projectPath, resumePath };
}
