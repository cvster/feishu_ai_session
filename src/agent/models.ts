import type { AgentKind } from '../config/profile-schema';
import type { AgentAdapter } from './types';

export const DEFAULT_MODEL = 'default';
export const DEFAULT_REASONING = 'default';
export const INITIAL_REASONING = 'high';
export const UNIFIED_REASONING = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export interface ReasoningOption { value: string; label: string }
export interface ModelOption {
  value: string; label: string; unavailable?: boolean;
  reasoningEfforts?: ReasoningOption[];
  defaultReasoningEffort?: string;
  isDefault?: boolean;
}
/** Only the default sentinel is local. Concrete models always belong to the native tool. */
export function supportedModels(_agentKind: AgentKind): ModelOption[] {
  return [{ value: DEFAULT_MODEL, label: '跟随工具默认模型' }];
}
export function isDefaultModel(value: string | undefined): boolean { return !value || value === DEFAULT_MODEL; }
export function normalizeModelSelection(_agentKind: AgentKind, value: string | undefined): string {
  return value && value.length <= 512 && !/[\x00-\x1f]/.test(value) ? value : DEFAULT_MODEL;
}
export function resolveModelArg(agentKind: AgentKind, value: string | undefined): string | undefined {
  const selected = normalizeModelSelection(agentKind, value);
  return selected === DEFAULT_MODEL ? undefined : selected;
}
export function modelLabel(agentKind: AgentKind, value: string | undefined, options?: readonly ModelOption[]): string {
  const selected = normalizeModelSelection(agentKind, value);
  return (options ?? supportedModels(agentKind)).find(model => model.value === selected)?.label ?? selected;
}
export interface ModelChoices {
  options: ModelOption[];
  available: boolean;
  notice?: string;
}
export function normalizeNativeModels(rows: ModelOption[]): ModelOption[] {
  const result = new Map<string, ModelOption>();
  for (const row of rows) {
    if (typeof row.value !== 'string' || !row.value || row.value.length > 512 || /[\x00-\x1f]/.test(row.value)) continue;
    const reasoningEfforts = Array.isArray(row.reasoningEfforts) ? [...new Map(row.reasoningEfforts
      .filter(option => validEffort(option?.value) && option.value !== DEFAULT_REASONING)
      .map(option => [option.value, { value: option.value, label: typeof option.label === 'string' ? option.label : option.value }])).values()] : undefined;
    result.set(row.value, { value: row.value, label: typeof row.label === 'string' && row.label ? row.label : row.value,
      ...(reasoningEfforts ? { reasoningEfforts } : {}),
      ...(validEffort(row.defaultReasoningEffort) ? { defaultReasoningEffort: row.defaultReasoningEffort } : {}),
      ...(row.isDefault ? { isDefault: true } : {}) });
  }
  return [...result.values()];
}
export async function loadModelChoices(agent: AgentAdapter, cwd?: string, current?: string): Promise<ModelChoices> {
  const options = supportedModels(agent.id as AgentKind);
  try {
    if (!agent.listModels) throw new Error('Native model discovery unavailable');
    const native = normalizeNativeModels(await agent.listModels({ cwd }));
    const defaultModel = native.find(model => model.value === DEFAULT_MODEL) ?? native.find(model => model.isDefault);
    if (defaultModel) options[0] = { ...defaultModel, value: DEFAULT_MODEL, label: '跟随工具默认模型' };
    options.push(...native.filter(model => model.value !== DEFAULT_MODEL));
    if (current && current !== DEFAULT_MODEL && !options.some(model => model.value === current)) {
      options.push({ value: current, label: `已不可用 · ${current}`, unavailable: true });
      return { options, available: true, notice: '已选模型已不在工具列表中；请选择其他模型，或跟随工具默认。' };
    }
    return { options, available: true };
  } catch {
    if (current && current !== DEFAULT_MODEL) options.push({ value: current, label: `未验证 · ${current}`, unavailable: true });
    return { options, available: false, notice: '暂时无法读取工具模型列表，保留原选择。可重新打开 /config 刷新，或选择跟随工具默认。' };
  }
}
/** Native levels are tokens, not free text; never guess unsupported levels. */
function validEffort(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value); }
export function supportedReasoningEfforts(_agentKind: AgentKind, model?: ModelOption): readonly string[] {
  return model?.reasoningEfforts?.map(option => option.value) ?? [];
}
export function normalizeReasoningEffort(_agentKind: AgentKind, value: string | undefined): string {
  if (UNIFIED_REASONING.includes(value as typeof UNIFIED_REASONING[number])) return value!;
  if (['off', 'none', 'minimal', 'instant'].includes(value ?? '')) return 'low';
  return INITIAL_REASONING;
}
export function resolveReasoningEffort(value: string | undefined): string | undefined {
  return validEffort(value) && value !== DEFAULT_REASONING ? value : undefined;
}
export function reasoningOptions(_model?: ModelOption): ReasoningOption[] {
  const labels = ['低', '中', '高', '很高', '最高', '极限'];
  return UNIFIED_REASONING.map((value, index) => ({ value, label: labels[index]! }));
}
