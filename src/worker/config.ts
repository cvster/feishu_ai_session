import { mkdir, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProfileConfig } from '../config/profile-schema';
import { writeFileAtomic } from '../platform/atomic-write';
import { isToolId } from '../tools/definitions';

export interface WorkerConfig { version: 1; toolId: string; options: Record<string, unknown> }
/** Read canonical settings without migrating files or launching any native process. */
export async function readWorkerConfig(profileDir: string, toolId: string): Promise<WorkerConfig | undefined> {
  if (!isToolId(toolId)) throw new Error('Invalid tool ID');
  try {
    const config = JSON.parse(await readFile(join(profileDir, 'workers', toolId, 'config.json'), 'utf8')) as WorkerConfig;
    if (config.version !== 1 || config.toolId !== toolId || !config.options || typeof config.options !== 'object' || Array.isArray(config.options)) throw new Error('Invalid worker config');
    return config;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
const legacy: Record<string, string> = { claude: 'execution-worker', zcode: 'execution-worker-zcode', kilo: 'execution-worker-kilo', dsh: 'execution-worker-dsh' };
async function exists(path: string) { return !!await stat(path).catch(error => { if (error.code === 'ENOENT') return; throw error; }); }
async function liveEndpoint(directory: string): Promise<boolean> {
  let endpoint;
  try { endpoint = JSON.parse(await readFile(join(directory, 'endpoint.json'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.url) || typeof endpoint.token !== 'string') throw new Error('Invalid legacy endpoint');
  try { await fetch(`${endpoint.url}/health`, { headers: { Authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(1500) });
    // Any listening service at a registered address must not be relocated under it.
    return true;
  } catch { return false; }
}
/** One-time import only. Worker configuration is independent after the first successful write. */
export async function loadWorkerConfig(profileDir: string, toolId: string, profile: ProfileConfig): Promise<WorkerConfig> {
  if (!isToolId(toolId)) throw new Error('Invalid tool ID');
  const directory = join(profileDir, 'workers', toolId), file = join(directory, 'config.json');
  const old = legacy[toolId] && join(profileDir, legacy[toolId]);
  if (old && await exists(old)) {
    if (await liveEndpoint(old)) throw new Error(`旧 ${toolId} worker 仍在运行，请单独停止该 worker 后迁移；桥接不会停止它。`);
    if (await exists(directory)) throw new Error(`新旧 ${toolId} worker 目录同时存在，请先核对并合并记录，未覆盖任何数据。`);
    await mkdir(join(profileDir, 'workers'), { recursive: true, mode: 0o700 });
    await rename(old, directory);
  }
  const existing = await readWorkerConfig(profileDir, toolId);
  if (existing) return existing;
  const options = { ...((profile as unknown as Record<string, unknown>)[toolId] as Record<string, unknown> ?? {}) };
  if (toolId === 'kilo') delete options.preferredClient;
  if (toolId === 'codex' && !options.codexHome && options.inheritCodexHome === false) options.codexHome = join(profileDir, 'codex-home');
  const config: WorkerConfig = { version: 1, toolId, options };
  await writeFileAtomic(file, JSON.stringify(config, null, 2), { mode: 0o600 }); return config;
}
