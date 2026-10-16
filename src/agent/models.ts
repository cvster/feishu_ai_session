import type { AgentKind } from '../config/profile-schema';
import { CODEX_STANDARD_REASONING_VALUES } from '../../packages/codex-core/src/models';
import type { AgentAdapter, AgentRunOptions } from './types';

export const DEFAULT_MODEL = 'default';
export interface ModelOption { value: string; label: string; unavailable?: boolean }
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
    if (typeof row.value !== 'string' || !row.value || row.value === DEFAULT_MODEL || row.value.length > 512 || /[\x00-\x1f]/.test(row.value)) continue;
    result.set(row.value, { value: row.value, label: typeof row.label === 'string' && row.label ? row.label : row.value });
  }
  return [...result.values()];
}
export async function loadModelChoices(agent: AgentAdapter, cwd?: string, current?: string): Promise<ModelChoices> {
  const options = supportedModels(agent.id as AgentKind);
  try {
    if (!agent.listModels) throw new Error('Native model discovery unavailable');
    options.push(...normalizeNativeModels(await agent.listModels({ cwd })));
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
type ReasoningEffort = NonNullable<AgentRunOptions['reasoningEffort']>;
const CLAUDE_REASONING_VALUES: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export function supportedReasoningEfforts(agentKind: AgentKind): readonly string[] {
  return agentKind === 'codex' ? CODEX_STANDARD_REASONING_VALUES : agentKind === 'claude' ? CLAUDE_REASONING_VALUES : [];
}
export function normalizeReasoningEffort(agentKind: AgentKind, value: string | undefined): ReasoningEffort {
  return supportedReasoningEfforts(agentKind).includes(value ?? '') ? value as ReasoningEffort : 'high';
}
