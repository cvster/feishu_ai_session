import type { ModelOption } from '../models';
import { PiClient, type PiOptions } from './client';

export async function readPiModels(client: PiClient): Promise<ModelOption[]> {
  const [catalog, state] = await Promise.all([client.request('get_available_models'), client.request('get_state')]);
  if (!Array.isArray(catalog?.models)) throw Error('Pi 模型目录格式不兼容');
  const rows: ModelOption[] = [];
  for (const model of catalog.models) {
    if (typeof model.provider !== 'string' || typeof model.id !== 'string') continue;
    const selected = model.provider === state?.model?.provider && model.id === state.model.id;
    // Obtain native supported levels rather than guessing from a model name.
    await client.request('set_model', { provider: model.provider, modelId: model.id });
    const levels = (await client.request('get_available_thinking_levels'))?.levels;
    if (!Array.isArray(levels) || !levels.every(level => typeof level === 'string')) throw Error('Pi 推理档位格式不兼容');
    rows.push({ value: `${model.provider}/${model.id}`, label: `${model.name || model.id} (${model.provider})`,
      reasoningEfforts: levels.map(value => ({ value, label: value })),
      ...(selected ? { isDefault: true, defaultReasoningEffort: state.thinkingLevel } : {}) });
  }
  // This is an ephemeral --no-session process; model selection never alters a user's session.
  return rows;
}
export async function listPiModels(options: PiOptions, cwd?: string) {
  const client = new PiClient(options, cwd);
  try { return await readPiModels(client); } finally { await client.close(); }
}
