import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadZcodeProviderRegistry, loadZcodeRuntimeModel } from '../zcode/model-config';
import type { ZcodeOptions } from '../zcode/client';
import { writeFileAtomic } from '../../platform/atomic-write';
import { piStorageDir, type PiOptions } from './client';

// Pi supports shell/env expansions in credential strings. Imported literal
// keys and headers must retain their value, never become executable commands.
const literal = (value: string) => value.replace(/\$/g, '$$$$').replace(/^!/, '$!');
export function piProvidersFromZcode(registry: Awaited<ReturnType<typeof loadZcodeProviderRegistry>>) {
  const providers: Record<string, any> = {};
  for (const provider of registry.providers) {
    const api = provider.apiFormat === 'anthropic-messages' || provider.kind === 'anthropic' ? 'anthropic-messages' :
      provider.apiFormat === 'openai-responses' || provider.kind === 'openai' ? 'openai-responses' : 'openai-completions';
    if (!provider.baseURL || provider.apiKey?.source !== 'inline' || typeof provider.apiKey.value !== 'string') continue;
    providers[provider.providerId] = { name: provider.label ?? provider.providerId, baseUrl: provider.baseURL,
      api, apiKey: literal(provider.apiKey.value), authHeader: true,
      ...(provider.headers ? { headers: Object.fromEntries(Object.entries(provider.headers).filter(([, v]) => typeof v === 'string').map(([k, v]) => [k, literal(v as string)])) } : {}),
      models: provider.models.map(model => ({ id: model.modelId, name: model.label ?? model.modelId,
        reasoning: model.reasoning?.enabled === true, input: ['text', ...(model.supportsImages ? ['image'] : [])],
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}), ...(model.maxOutputTokens ? { maxTokens: model.maxOutputTokens } : {}) })) };
  }
  if (!Object.keys(providers).length) throw Error('Zcode 没有可导入 Pi 的 API Key 模型配置');
  return providers;
}
async function readOptional(path: string) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
}
/** Explicit one-time credential import. Never invoked by refresh, discovery or inference. */
export async function importZcodeToPi(zcode: ZcodeOptions, options: PiOptions = {}) {
  const [registry, selected] = await Promise.all([loadZcodeProviderRegistry(zcode), loadZcodeRuntimeModel(zcode)]);
  const providers = piProvidersFromZcode(registry), root = piStorageDir(options);
  const path = join(root, 'models.json'), settingsPath = join(root, 'settings.json');
  const existing = await readOptional(path), settings = await readOptional(settingsPath);
  if (!existing || typeof existing !== 'object' || Array.isArray(existing) || !settings || typeof settings !== 'object' || Array.isArray(settings)) throw Error('Pi 现有配置格式无效，未覆盖');
  await writeFileAtomic(path, JSON.stringify({ ...existing, providers: { ...existing.providers, ...providers } }, null, 2) + '\n', { mode: 0o600 });
  if (providers[selected.model.providerId]?.models.some((m: any) => m.id === selected.model.modelId))
    await writeFileAtomic(settingsPath, JSON.stringify({ ...settings, defaultProvider: selected.model.providerId, defaultModel: selected.model.modelId }, null, 2) + '\n', { mode: 0o600 });
  return { providers: Object.keys(providers).length, models: Object.values(providers).reduce((sum, p) => sum + p.models.length, 0), path };
}
