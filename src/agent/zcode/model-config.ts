import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { zcodeStorageDir, type ZcodeOptions } from './client';
import type { ModelOption } from '../models';

async function readConfig(path: string, optional = false): Promise<any> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('ZCode 模型配置无法读取'); }
}
interface ModelConfig { provider: Record<string, any>; model?: string | { main?: string } }
function mergeConfig(base: any, override: any): any {
  const result = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) result[key] = value && typeof value === 'object' && !Array.isArray(value)
    ? mergeConfig(base?.[key], value) : value;
  return result;
}
/** Resolve current desktop provider rules, including personal model additions/removals, without copying keys. */
async function desktopRules(raw: any, path: string): Promise<ModelConfig> {
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.config?.providerConfigRules?.providerRules)) throw new Error('ZCode 供应商配置格式不兼容');
  const builtin = await readConfig(join(dirname(path), 'runtime/provider/bundled/zcode-builtin.json'), true);
  const templates = new Map((builtin?.config?.providerConfigRules?.templateRules ?? []).map((r: any) => [r.templateId, r.config]));
  const rules = new Map<string, any>();
  for (const rule of [...(builtin?.config?.providerConfigRules?.providerRules ?? []), ...raw.config.providerConfigRules.providerRules]) {
    const before = rules.get(rule.providerId) ?? {};
    rules.set(rule.providerId, { ...before, ...rule, config: mergeConfig(mergeConfig(templates.get(rule.templateId), before.config), rule.config) });
  }
  const modelRules = [...(builtin?.config?.modelConfigRules?.builtinProviderModelRules ?? []),
    ...(raw.config.modelConfigRules?.providerModelRules ?? []), ...(raw.config.modelConfigRules?.manualProviderModelRules ?? [])];
  const providers: Record<string, any> = Object.create(null);
  const order = [...new Set<string>([...(raw.config.providerOrder ?? []), ...rules.keys()])];
  for (const id of order) {
    const rule = rules.get(id); if (!rule) continue;
    const c = rule.config ?? {}, api = c.api, access = c.access;
    if (rule.enabled === false || c.visibility === 'hidden' || !api?.baseUrl || !access?.apiKey || !['api-key', 'zhipu-coding-plan-api-key'].includes(access.type)) continue;
    const kinds: Record<string, string> = { 'anthropic-messages': 'anthropic', 'openai-chat-completions': 'openai-compatible', 'openai-responses': 'openai' };
    if (!kinds[api.type]) continue;
    const ids = [...new Set<string>([...(c.modelOrder ?? []), ...(c.personalModelIds ?? []), ...(c.builtinModelIds ?? [])])];
    // modelOrder orders declared models; it must not resurrect a model removed from the declared IDs.
    const declared = new Set([...(c.personalModelIds ?? []), ...(c.builtinModelIds ?? [])]);
    const models: Record<string, any> = Object.create(null);
    for (const modelId of ids) {
      if (!declared.has(modelId)) continue;
      let cfg: any = {};
      for (const r of modelRules) if (r.providerId === id && r.modelId === modelId) cfg = mergeConfig(cfg, r.config);
      if (cfg.enabled === false) continue;
      const p = cfg.properties ?? {};
      models[modelId] = { name: p.name ?? modelId, limit: { context: p.contextWindow, output: p.maxOutputTokens },
        modalities: { input: ['text', ...(p.inputFormat?.supportsImage ? ['image'] : [])] }, options: cfg.providerOptions };
    }
    providers[id] = { name: rule.providerName ?? id, kind: kinds[api.type], apiFormat: api.type,
      options: { apiKey: access.apiKey, baseURL: api.baseUrl, headers: api.headers }, models };
  }
  return { provider: providers };
}
async function effectiveConfig(options: ZcodeOptions): Promise<ModelConfig> {
  const args = options.args ?? [], settingsIndex = args.indexOf('--settings');
  const explicit = options.modelConfigPath ?? (settingsIndex >= 0 ? args[settingsIndex + 1] : undefined);
  const nativePath = join(zcodeStorageDir(options), 'config.json');
  if (explicit) {
    const config = await readConfig(explicit);
    return config.config?.providerConfigRules ? desktopRules(config, explicit) : config;
  }
  if (!options.dataDir && !process.env.ZCODE_STORAGE_DIR) {
    const desktopRoot = join(homedir(), '.zcode', 'v2');
    const modernPath = join(desktopRoot, 'provider_config.json');
    const modern = await readConfig(modernPath, true);
    if (modern) return desktopRules(modern, modernPath);
    const desktop = await readConfig(join(desktopRoot, 'config.json'), true);
    if (desktop?.provider) {
      const cli = await readConfig(nativePath, true);
      return { ...desktop, model: cli?.model ?? desktop.model };
    }
  }
  return await readConfig(nativePath);
}
function modelEntries(config: ModelConfig) {
  const rows: Array<{ providerId: string; modelId: string; provider: any; model: any }> = [];
  for (const [providerId, provider] of Object.entries(config.provider ?? {})) {
    if (provider.enabled === false || provider.systemDisabledReason || !['anthropic', 'openai', 'openai-compatible'].includes(provider.kind)) continue;
    for (const [modelId, model] of Object.entries(provider.models ?? {}) as [string, any][]) {
      if (model.enabled !== false && !model.disabledReason) rows.push({ providerId, modelId, provider, model });
    }
  }
  return rows;
}
export async function listZcodeModels(options: ZcodeOptions = {}): Promise<ModelOption[]> {
  return modelEntries(await effectiveConfig(options)).map(({ providerId, modelId, provider, model }) => ({
    value: `${providerId}/${modelId}`, label: `${provider.name ?? providerId} / ${model.name ?? modelId} (${providerId})`,
  }));
}
/** Credentials are read afresh only in the worker, sent over private stdin, never in prompts or receipts. */
export async function loadZcodeRuntimeModel(options: ZcodeOptions, selected?: string) {
  const config = await effectiveConfig(options), rows = modelEntries(config);
  const configured = typeof config.model === 'string' ? config.model : config.model?.main;
  // Explicit selections never fall back. The default sentinel follows the native registry recommendation order.
  const ref = selected ?? configured ?? (rows[0] && `${rows[0].providerId}/${rows[0].modelId}`);
  const entry = rows.find(r => `${r.providerId}/${r.modelId}` === ref);
  if (!entry) throw new Error('ZCode 选定模型已移除或不可用，请在 /config 中重新选择');
  const { providerId, modelId, provider, model } = entry, opts = provider.options ?? {};
  const inputs = model.modalities?.input ?? [];
  return { revision: randomUUID(), generatedAt: Date.now(), model: { providerId, modelId },
    provider: { providerId, kind: provider.kind, apiFormat: provider.apiFormat, source: 'user', label: provider.name,
      baseURL: opts.baseURL, apiKeyRequired: opts.apiKeyRequired,
      ...(opts.apiKey ? { apiKey: { source: 'inline', value: opts.apiKey } } : {}),
      headers: { ...provider.headers, ...opts.headers }, providerOptions: opts.providerOptions,
      models: [{ modelId, label: model.name, contextWindow: model.limit?.context, maxOutputTokens: model.limit?.output,
        supportsImages: inputs.includes('image'), supportsPdf: inputs.includes('pdf'), supportsVideo: inputs.includes('video'), providerOptions: model.options }],
    } };
}
