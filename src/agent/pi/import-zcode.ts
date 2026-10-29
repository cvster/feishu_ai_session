import { readFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadZcodeProviderRegistry, loadZcodeRuntimeModel } from '../zcode/model-config';
import type { ZcodeOptions } from '../zcode/client';
import { writeFileAtomic } from '../../platform/atomic-write';
import { piStorageDir, type PiOptions } from './client';
import { PiSessionFiles, piActiveBranch } from './sessions';

// Pi supports shell/env expansions in credential strings. Imported literal
// keys and headers must retain their value, never become executable commands.
const literal = (value: string) => value.replace(/\$/g, '$$$$').replace(/^!/, '$!');
export function piProviderIds(registry: Awaited<ReturnType<typeof loadZcodeProviderRegistry>>): Record<string, string> {
  const names = registry.providers.map(p => p.label?.trim() || p.providerId);
  const ids: Record<string, string> = Object.create(null);
  for (const [index, provider] of registry.providers.entries()) {
    const name = names[index]!;
    // A provider ID is the prefix of provider/model CLI selections. Unsafe or
    // ambiguous display names keep the original identity rather than guessing.
    ids[provider.providerId] = !/[\s/:,*?\\\x00-\x1f]/.test(name) && names.filter(n => n === name).length === 1 ? name : provider.providerId;
  }
  if (new Set(Object.values(ids)).size !== Object.keys(ids).length) throw Error('Zcode 供应商名称与标识冲突，未导入 Pi');
  if (Object.entries(ids).some(([oldId, id]) => oldId !== id && Object.hasOwn(ids, id))) throw Error('Zcode 供应商名称与其他供应商标识冲突，未导入 Pi');
  return ids;
}
export function renamePiModel(value: string, ids: Readonly<Record<string, string>>): string {
  const slash = value.indexOf('/');
  return slash > 0 && ids[value.slice(0, slash)] ? `${ids[value.slice(0, slash)]}${value.slice(slash)}` : value;
}
export function renamePiSettings(settings: Record<string, any>, ids: Readonly<Record<string, string>>): Record<string, any> {
  return { ...settings,
    ...(typeof settings.defaultProvider === 'string' && ids[settings.defaultProvider] ? { defaultProvider: ids[settings.defaultProvider] } : {}),
    ...(Array.isArray(settings.enabledModels) ? { enabledModels: settings.enabledModels.map((m: unknown) => typeof m === 'string' ? renamePiModel(m, ids) : m) } : {}),
    ...(settings.modelThinkingLevels && typeof settings.modelThinkingLevels === 'object' ? { modelThinkingLevels:
      Object.fromEntries(Object.entries(settings.modelThinkingLevels).map(([m, level]) => [renamePiModel(m, ids), level])) } : {}) };
}
export function piProvidersFromZcode(registry: Awaited<ReturnType<typeof loadZcodeProviderRegistry>>) {
  const ids = piProviderIds(registry);
  const providers: Record<string, any> = {};
  for (const provider of registry.providers) {
    const api = provider.apiFormat === 'anthropic-messages' || provider.kind === 'anthropic' ? 'anthropic-messages' :
      provider.apiFormat === 'openai-responses' || provider.kind === 'openai' ? 'openai-responses' : 'openai-completions';
    if (!provider.baseURL || provider.apiKey?.source !== 'inline' || typeof provider.apiKey.value !== 'string') continue;
    providers[ids[provider.providerId]!] = { name: provider.label ?? provider.providerId, baseUrl: provider.baseURL,
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
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw Error('Pi 现有配置无法读取，未导入'); }
}
/** Explicit one-time credential import. Never invoked by refresh, discovery or inference. */
export async function importZcodeToPi(zcode: ZcodeOptions, options: PiOptions = {}) {
  const [registry, selected] = await Promise.all([loadZcodeProviderRegistry(zcode), loadZcodeRuntimeModel(zcode)]);
  const providers = piProvidersFromZcode(registry), root = piStorageDir(options);
  const providerIds = Object.fromEntries(Object.entries(piProviderIds(registry)).filter(([, id]) => providers[id]));
  const path = join(root, 'models.json'), settingsPath = join(root, 'settings.json');
  const existing = await readOptional(path), settings = await readOptional(settingsPath);
  if (!existing || typeof existing !== 'object' || Array.isArray(existing) || !settings || typeof settings !== 'object' || Array.isArray(settings)) throw Error('Pi 现有配置格式无效，未覆盖');
  for (const [oldId, id] of Object.entries(providerIds)) if (oldId !== id && existing.providers?.[oldId] && existing.providers?.[id] &&
    (existing.providers[id].baseUrl !== providers[id].baseUrl || existing.providers[id].apiKey !== providers[id].apiKey))
    throw Error('Pi 已存在同名的其他供应商，未覆盖');
  const files = new PiSessionFiles(options);
  const sessions = await files.list();
  // Write ahead with both identities. If interrupted, old and migrated sessions
  // remain resolvable; a repeat import completes the remaining migration.
  await writeFileAtomic(path, JSON.stringify({ ...existing, providers: { ...existing.providers, ...providers } }, null, 2) + '\n', { mode: 0o600 });
  let migratedSessions = 0;
  for (const session of sessions) {
    const current = await files.find(session.header.id), branch = piActiveBranch(current.entries);
    const choice = [...branch].reverse().find(e => e.type === 'model_change');
    const assistant = [...branch].reverse().find(e => e.type === 'message' && e.message?.role === 'assistant')?.message;
    const oldId = choice?.provider ?? assistant?.provider, modelId = choice?.modelId ?? assistant?.model;
    const id = providerIds[oldId];
    if (!id || id === oldId || !providers[id]?.models.some((m: any) => m.id === modelId)) continue;
    const file = await open(current.path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat(), last = Buffer.alloc(1);
      if (!stat.isFile() || stat.mtimeMs !== current.updatedAtMs) throw Error('Pi 会话已发生变化，请稍后重试导入');
      if (stat.size) await file.read(last, 0, 1, stat.size - 1);
      if (!stat.size || last[0] !== 10) throw Error('Pi 会话末尾尚未写入完整记录，请稍后重试导入');
      // Select the same model under its new identity by appending native metadata.
      // Existing messages, tool output, branches and usage records remain byte-for-byte intact.
      await file.writeFile(JSON.stringify({ type: 'model_change', id: randomUUID().replaceAll('-', '').slice(0, 8),
        parentId: current.entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), provider: id, modelId }) + '\n');
      await file.sync(); migratedSessions++;
    } finally { await file.close(); }
  }
  const nextSettings = renamePiSettings(settings, providerIds);
  const selectedId = providerIds[selected.model.providerId];
  if (selectedId && providers[selectedId]?.models.some((m: any) => m.id === selected.model.modelId)) {
    nextSettings.defaultProvider = selectedId; nextSettings.defaultModel = selected.model.modelId;
  }
  await writeFileAtomic(settingsPath, JSON.stringify(nextSettings, null, 2) + '\n', { mode: 0o600 });
  const finalProviders = { ...existing.providers, ...providers };
  for (const [oldId, id] of Object.entries(providerIds)) if (oldId !== id) delete finalProviders[oldId];
  await writeFileAtomic(path, JSON.stringify({ ...existing, providers: finalProviders }, null, 2) + '\n', { mode: 0o600 });
  return { providers: Object.keys(providers).length, models: Object.values(providers).reduce((sum, p) => sum + p.models.length, 0), path, providerIds, migratedSessions };
}
