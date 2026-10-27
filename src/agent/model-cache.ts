import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import { DEFAULT_MODEL, loadModelChoices, normalizeNativeModels, supportedModels, type ModelChoices } from './models';
import type { AgentAdapter } from './types';

/** Settings reads use only the persisted catalogue. Only an explicit refresh contacts the worker. */
export async function cachedModelChoices(path: string, agent: AgentAdapter, cwd: string | undefined, current: string, refresh = false): Promise<ModelChoices> {
  let cached: ModelChoices | undefined;
  try {
    const data = JSON.parse(await readFile(path, 'utf8'));
    if (data.version === 1 && Array.isArray(data.options)) {
      const options = normalizeNativeModels(data.options);
      cached = { options: [options.find(row => row.value === DEFAULT_MODEL) ?? supportedModels(agent.id)[0]!, ...options.filter(row => row.value !== DEFAULT_MODEL)], available: true };
    }
  } catch { /* A missing/invalid cache does not trigger native discovery. */ }
  let notice: string | undefined;
  if (refresh) {
    const fresh = await loadModelChoices(agent, cwd);
    if (fresh.available) {
      cached = fresh;
      await writeFileAtomic(path, JSON.stringify({ version: 1, options: fresh.options }) + '\n', { mode: 0o600 });
    } else notice = '刷新模型失败，保留缓存和原选择，请稍后再点刷新模型。';
  }
  const choices = cached ?? { options: supportedModels(agent.id), available: false };
  const options = [...choices.options];
  if (current !== DEFAULT_MODEL && !options.some(row => row.value === current)) options.push({ value: current, label: `当前选择 · ${current}` });
  return { ...choices, options, ...(notice ? { notice } : !cached ? { notice: '暂无缓存模型列表，点击“刷新模型”读取。' } : {}) };
}
