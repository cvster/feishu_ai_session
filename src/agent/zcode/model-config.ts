import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { zcodeStorageDir, type ZcodeOptions } from './client';

/** Runtime model credentials go only to the owned native process, never to prompts or job receipts. */
export async function loadZcodeRuntimeModel(options: ZcodeOptions, selected?: string) {
  const path = join(zcodeStorageDir(options), 'config.json');
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('ZCode CLI 模型配置无法读取'); }
  const ref = selected ?? (typeof config.model === 'string' ? config.model : config.model?.main);
  if (typeof ref !== 'string' || !ref.includes('/')) throw new Error('ZCode CLI 缺少 provider/model 默认模型');
  const separator = ref.indexOf('/'), providerId = ref.slice(0, separator), modelId = ref.slice(separator + 1);
  const provider = config.provider?.[providerId], model = provider?.models?.[modelId];
  if (!provider || !model || !['anthropic', 'openai', 'openai-compatible'].includes(provider.kind)) throw new Error('ZCode CLI 选定模型不在本地 provider 配置中');
  const opts = provider.options ?? {};
  const inputs = model.modalities?.input ?? [];
  return { revision: randomUUID(), generatedAt: Date.now(), model: { providerId, modelId },
    provider: { providerId, kind: provider.kind, source: 'user', label: provider.name,
      baseURL: opts.baseURL, apiKeyRequired: opts.apiKeyRequired,
      ...(opts.apiKey ? { apiKey: { source: 'inline', value: opts.apiKey } } : {}),
      headers: { ...provider.headers, ...opts.headers }, providerOptions: opts.providerOptions,
      models: [{ modelId, label: model.name, contextWindow: model.limit?.context, maxOutputTokens: model.limit?.output,
        supportsImages: inputs.includes('image'), supportsPdf: inputs.includes('pdf'), supportsVideo: inputs.includes('video'),
        providerOptions: model.options }],
    } };
}
