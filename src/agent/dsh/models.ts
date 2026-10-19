import { DEFAULT_MODEL, type ModelOption } from '../models';
import { DshClient, type DshOptions } from './client';

export function splitDshModel(value: string) {
  const slash = value.indexOf('/');
  if (slash < 1 || slash === value.length - 1) throw new Error('DSH 模型必须为供应商ID/模型ID');
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}
export async function readDshModels(client: DshClient): Promise<{ options: ModelOption[]; selected: string; effort?: string }> {
  const catalog = await client.request('session/modelCatalog');
  if (!Array.isArray(catalog.groups) || !Array.isArray(catalog.routableProviders) || !catalog.default?.provider || !catalog.default?.model) throw new Error('DSH 模型目录格式不兼容');
  const options: ModelOption[] = [];
  const names = new Map<string, number>();
  for (const group of catalog.groups) names.set(group.name, (names.get(group.name) ?? 0) + 1);
  for (const group of catalog.groups) if (catalog.routableProviders.includes(group.id)) {
    const name = names.get(group.name)! > 1 ? `${group.name} (${group.id})` : group.name || group.id;
    for (const model of group.models) options.push({ value: `${group.id}/${model.id}`, label: `${name} / ${model.name || model.id}`,
      ...(model.reasoning?.efforts?.length ? { reasoningEfforts: model.reasoning.efforts.map((e: any) => ({ value: e.id, label: e.name || e.id })),
        defaultReasoningEffort: model.reasoning.defaultEffort } : {}) });
  }
  const selected = `${catalog.default.provider}/${catalog.default.model}`;
  const current = options.find(row => row.value === selected);
  return { selected, effort: catalog.default.reasoningEffort, options: [{ value: DEFAULT_MODEL, label: '跟随 DSH 当前默认模型',
    ...(current?.reasoningEfforts ? { reasoningEfforts: current.reasoningEfforts, defaultReasoningEffort: current.defaultReasoningEffort } : {}) }, ...options] };
}
export async function listDshModels(options: DshOptions = {}, cwd?: string): Promise<ModelOption[]> {
  const client = new DshClient(options, cwd);
  try { return (await readDshModels(client)).options; } finally { await client.close(); }
}
