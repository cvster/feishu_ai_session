import { readFile, stat } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { join } from 'node:path';
import { resolveAppPaths } from './app-paths';

/** A local, declarative file shared by foreground bridge and independent worker.
 * Never evaluate shell code or print credential values. Explicit file values win. */
export async function loadRuntimeEnv(profile: string, rootDir?: string): Promise<string | undefined> {
  const path = join(resolveAppPaths({ profile, rootDir }).profileDir, 'runtime.env');
  let content: string;
  try {
    const meta = await stat(path);
    if (process.platform !== 'win32' && (meta.mode & 0o077)) throw new Error(`请先执行 chmod 600 ${path}；runtime.env 可能包含凭据`);
    content = await readFile(path, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  const values = parseEnv(content);
  for (const name of Object.keys(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || ['HOME', 'USERPROFILE', 'LARK_CHANNEL_HOME', 'NODE_OPTIONS'].includes(name))
      throw new Error(`runtime.env 不允许设置 ${name}`);
  }
  Object.assign(process.env, values);
  return path;
}
