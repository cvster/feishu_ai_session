import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ZcodeClient, zcodeStorageDir, type ZcodeOptions } from './client';
import { normalizeNativeModels, type ModelOption } from '../models';

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
function modelChoices(entries: ReturnType<typeof modelEntries>): ModelOption[] {
  return entries.map(({ providerId, modelId, provider, model }) => ({
    value: `${providerId}/${modelId}`, label: `${provider.name ?? providerId} / ${model.name ?? modelId} (${providerId})`,
    ...(model.reasoning?.enabled ? { reasoningEfforts: nativeReasoning(model.reasoning).levels } : {}),
  }));
}
export async function listZcodeModels(options: ZcodeOptions = {}): Promise<ModelOption[]> {
  return modelChoices(modelEntries(await effectiveConfig(options)));
}
/** Credentials are read afresh only in the worker, sent over private stdin, never in prompts or receipts. */
export async function loadZcodeRuntimeModel(options: ZcodeOptions, selected?: string) {
  const config = await effectiveConfig(options), rows = modelEntries(config);
  const configured = typeof config.model === 'string' ? config.model : config.model?.main;
  // Explicit selections never fall back. The default sentinel follows the native registry recommendation order.
  const ref = selected ?? configured ?? (rows[0] && `${rows[0].providerId}/${rows[0].modelId}`);
  const entry = rows.find(r => `${r.providerId}/${r.modelId}` === ref);
  if (!entry) throw new Error('ZCode 选定模型已移除或不可用，请在 /config 中重新选择');
  const { providerId, modelId } = entry;
  return { revision: randomUUID(), generatedAt: Date.now(), model: { providerId, modelId }, provider: nativeProvider(entry) };
}
function nativeReasoning(reasoning: any) {
  return { enabled: reasoning.enabled === true,
    levels: reasoning.levels ?? (reasoning.variants ?? []).map((value: string) => ({ value, label: value })),
    ...(reasoning.defaultLevel ?? reasoning.defaultVariant ? { defaultLevel: reasoning.defaultLevel ?? reasoning.defaultVariant } : {}),
    ...(reasoning.providerOptionsByLevel ? { providerOptionsByLevel: reasoning.providerOptionsByLevel } : {}) };
}
function nativeProvider({ providerId, modelId, provider, model }: ReturnType<typeof modelEntries>[number], metadataOnly = false) {
  const opts = provider.options ?? {}, inputs = model.modalities?.input ?? [];
  return { providerId, kind: provider.kind, apiFormat: provider.apiFormat, source: 'user', label: provider.name,
    baseURL: opts.baseURL, apiKeyRequired: metadataOnly ? false : opts.apiKeyRequired,
    ...(!metadataOnly && opts.apiKey ? { apiKey: { source: 'inline', value: opts.apiKey } } : {}),
    ...(!metadataOnly ? { headers: { ...provider.headers, ...opts.headers }, providerOptions: opts.providerOptions } : {}),
    models: [{ modelId, label: model.name, contextWindow: model.limit?.context, maxOutputTokens: model.limit?.output,
      ...(model.reasoning ? { reasoning: { ...nativeReasoning(model.reasoning), ...(metadataOnly ? { providerOptionsByLevel: undefined } : {}) } } : {}),
      supportsImages: inputs.includes('image'), supportsPdf: inputs.includes('pdf'), supportsVideo: inputs.includes('video'),
      ...(!metadataOnly ? { providerOptions: model.options } : {}) }],
  };
}
/** An owned, isolated native process resolves capabilities. No keys, sessions, generation, or user-config writes. */
export async function listZcodeModelCapabilities(options: ZcodeOptions = {}): Promise<ModelOption[]> {
  const config = await effectiveConfig(options), entries = modelEntries(config);
  const choices = modelChoices(entries);
  if (!entries.length) return choices;
  const root = await mkdtemp(join(tmpdir(), 'zcode-model-catalog-'));
  // Explicit settings are already resolved above. The metadata process must not load or mutate them.
  const args = [...(options.args ?? [])];
  const settingsIndex = args.indexOf('--settings'); if (settingsIndex >= 0) args.splice(settingsIndex, 2);
  const client = new ZcodeClient({ ...options, args, dataDir: join(root, 'data') }, root);
  try {
    const providers = new Map<string, ReturnType<typeof nativeProvider>>();
    for (const entry of entries) {
      const native = nativeProvider(entry, true), previous = providers.get(entry.providerId);
      if (previous) previous.models.push(...native.models); else providers.set(entry.providerId, native);
    }
    const result = await client.request('workspace/updateProviderRegistry', {
      workspace: { workspacePath: root, workspaceKey: 'bridge-model-catalog' },
      registry: { revision: randomUUID(), generatedAt: Date.now(), providers: [...providers.values()] }, includeWorkspaceState: true,
    }, 10_000);
    const available = result.workspaceState?.settings?.model?.available;
    if (!Array.isArray(available)) throw new Error('ZCode 原生模型能力格式不兼容');
    const configured = typeof config.model === 'string' ? config.model : config.model?.main;
    return normalizeNativeModels(choices.map((choice) => {
      const native = available.find((row: any) => `${row.ref?.providerId}/${row.ref?.modelId}` === choice.value);
      return { ...choice, ...(native?.reasoning?.enabled ? { reasoningEfforts: native.reasoning.levels,
        defaultReasoningEffort: native.reasoning.defaultLevel } : {}), isDefault: choice.value === (configured ?? choices[0]?.value) };
    }));
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
}
