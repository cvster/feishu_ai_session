import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';
import { DEFAULT_MODEL, loadModelChoices, normalizeNativeModels, supportedModels, type ModelChoices } from './models';
import type { AgentAdapter } from './types';

export function modelCachePath(profileDir: string, appId: string, toolId: string, sourceId?: string, cwd?: string) {
  const key = createHash('sha256').update(JSON.stringify([appId, toolId, sourceId, cwd])).digest('hex');
  return join(profileDir, 'model-cache', key + '.json');
}

async function readCached(path: string, agent: AgentAdapter): Promise<ModelChoices | undefined> {
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (data.version === 1 && Array.isArray(data.options)) {
      const options = normalizeNativeModels(data.options);
      return { options: [options.find(row => row.value === DEFAULT_MODEL) ?? supportedModels(agent.id)[0]!, ...options.filter(row => row.value !== DEFAULT_MODEL)], available: true };
    }
  } catch { /* A missing/invalid cache does not trigger native discovery. */ }
}

/** Settings only read disk; refresh is requested by the background poller or the refresh button. */
export async function cachedModelChoices(path: string, agent: AgentAdapter, cwd: string | undefined, current: string, refresh = false,
  options: { fallbackPath?: string; isActive?: () => boolean } = {}): Promise<ModelChoices> {
  let cached = await readCached(path, agent) ?? (options.fallbackPath ? await readCached(options.fallbackPath, agent) : undefined);
  let notice: string | undefined;
  if (refresh) {
    const fresh = await loadModelChoices(agent, cwd);
    if (fresh.available) {
      cached = fresh;
      if (!options.isActive || options.isActive()) await writeFileAtomic(path, JSON.stringify({ version: 1, options: fresh.options }) + '\n', { mode: 0o600 });
    } else notice = '刷新模型失败，保留缓存和原选择，请稍后再点刷新模型。';
  }
  const choices = cached ?? { options: supportedModels(agent.id), available: false };
  const models = [...choices.options];
  if (current !== DEFAULT_MODEL && !models.some(row => row.value === current)) models.push({ value: current, label: `当前选择 · ${current}` });
  return { ...choices, options: models, ...(notice ? { notice } : !cached ? { notice: '暂无缓存模型列表，点击“刷新模型”读取。' } : {}) };
}
