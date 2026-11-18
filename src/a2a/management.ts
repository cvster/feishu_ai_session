import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as lockfile from 'proper-lockfile';

/** Shared by CLI and Web: never overwrite another administrator's config changes. */
export async function withA2AConfigLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, 'a2a-config.lock');
  await writeFile(lockPath, '', { flag: 'a', mode: 0o600 });
  const release = await lockfile.lock(lockPath, { realpath: false, retries: { retries: 5, minTimeout: 30, maxTimeout: 200 } });
  try { return await work(); } finally { await release(); }
}
