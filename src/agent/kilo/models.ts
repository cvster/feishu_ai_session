import { DEFAULT_MODEL, type ModelOption } from '../models';
import { KiloClient, type KiloOptions } from './client';

export interface KiloModel { id: string; name?: string; variants?: Record<string, unknown>; capabilities?: { input?: { image?: boolean } } }
export interface KiloCatalog { all: { id: string; name: string; models: Record<string, KiloModel> }[]; connected: string[]; default: Record<string, string> }
export function splitKiloModel(value: string): { providerID: string; modelID: string } {
  const slash = value.indexOf('/');
  if (slash < 1 || slash === value.length - 1) throw new Error('Kilo 模型必须为供应商ID/模型ID');
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}
export async function readKiloModels(client: KiloClient, cwd?: string): Promise<{ options: ModelOption[]; selected?: string; catalog: KiloCatalog; variant?: string }> {
  const [catalog, config, state] = await Promise.all([
    client.request<KiloCatalog>('GET', '/provider', undefined, cwd),
    client.request('GET', '/config', undefined, cwd),
    client.request('GET', '/config/model-state', undefined, cwd),
  ]);
  if (!Array.isArray(catalog.all) || !Array.isArray(catalog.connected)) throw new Error('Kilo 模型目录格式不兼容');
  const recent = state.recent?.[0];
  const selected = typeof config.model === 'string' ? config.model : recent?.providerID && recent?.modelID ? `${recent.providerID}/${recent.modelID}` : undefined;
  const selectedProvider = selected?.split('/')[0];
  const configured = new Set(Object.keys(config.provider ?? {}));
  const rows: ModelOption[] = [];
  // Native catalogs put built-in gateways first, often filling several card pages.
  // Prefer explicitly configured providers without hiding other connected choices.
  const priority = (id: string) => configured.has(id) ? 0 : id === selectedProvider ? 1 : 2;
  const connected = catalog.all.filter(row => catalog.connected.includes(row.id)).sort((a, b) =>
    priority(a.id) - priority(b.id) || Number(b.id === selectedProvider) - Number(a.id === selectedProvider));
  const names = new Map<string, number>();
  for (const p of connected) names.set(p.name || p.id, (names.get(p.name || p.id) ?? 0) + 1);
  for (const provider of connected) {
    const name = provider.name || provider.id;
    const label = names.get(name)! > 1 ? `${name} (${provider.id})` : name;
    const models = Object.entries(provider.models).sort(([a], [b]) =>
      Number(`${provider.id}/${b}` === selected) - Number(`${provider.id}/${a}` === selected));
    for (const [id, model] of models) {
      const variants = Object.entries(model.variants ?? {}).filter(([, v]) => !(v as { disabled?: boolean })?.disabled).map(([value]) => ({ value, label: value }));
      rows.push({ value: `${provider.id}/${id}`, label: `${label} / ${model.name || id}`,
        ...(variants.length ? { reasoningEfforts: variants } : {}) });
    }
  }
  const found = rows.find(row => row.value === selected);
  // Do not fabricate a default or borrow another provider's reasoning levels.
  return { catalog, selected, variant: selected ? state.variant?.[selected] : undefined,
    options: [{ value: DEFAULT_MODEL, label: '跟随 Kilo 当前默认模型', ...(found?.reasoningEfforts ? { reasoningEfforts: found.reasoningEfforts } : {}) }, ...rows] };
}
export async function listKiloModels(options: KiloOptions = {}, cwd?: string): Promise<ModelOption[]> {
  const client = new KiloClient(options, cwd);
  try { return (await readKiloModels(client, cwd)).options; } finally { await client.close(); }
}
