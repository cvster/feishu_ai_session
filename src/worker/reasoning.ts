import { INITIAL_REASONING, UNIFIED_REASONING, normalizeNativeModels, normalizeReasoningEffort, type ModelOption } from '../agent/models';
import type { AgentAdapter, AgentRunOptions } from '../agent/types';
import type { WorkerSessionService } from './protocol';

export interface ReasoningSelection {
  effort: string;
  nativeEffort?: string;
  model?: string;
  source: 'native' | 'initial';
  notice?: string;
}

/** Native tokens remain model-owned. Only known positive effort levels are ordered. */
export function mapReasoningEffort(requested: string, model?: ModelOption): string | undefined {
  const levels = model?.reasoningEfforts?.map(row => row.value) ?? [];
  if (levels.includes(requested)) return requested;
  const rank = UNIFIED_REASONING.indexOf(requested as typeof UNIFIED_REASONING[number]);
  if (rank < 0) return undefined;
  const available = levels.flatMap(value => {
    const position = value === 'minimal' ? -1 : UNIFIED_REASONING.indexOf(value as typeof UNIFIED_REASONING[number]);
    return position >= 0 || value === 'minimal' ? [{ value, position }] : [];
  }).sort((a, b) => Math.abs(a.position - rank) - Math.abs(b.position - rank) || a.position - b.position);
  if (available.length) return available[0]!.value;
  if (levels.includes('thinking')) return 'thinking';
  return undefined;
}

export async function readReasoningSelection(agent: AgentAdapter, sessions: WorkerSessionService | undefined,
  nativeId?: string, cwd?: string, models?: ModelOption[]): Promise<ReasoningSelection> {
  let current: { model?: string; reasoningEffort?: string } | undefined;
  let notice: string | undefined;
  if (nativeId && sessions?.conversation) {
    try {
      const snapshot = await sessions.conversation(nativeId);
      if (snapshot.id !== nativeId || (cwd && snapshot.cwd !== cwd)) throw new Error('Native settings identity mismatch');
      const previous = [...snapshot.turns].reverse().find(turn => turn.state.execution?.model)?.state.execution;
      current = snapshot.settings ?? previous;
      if (current && previous && !current.reasoningEffort && previous.model === current.model)
        current = { ...current, reasoningEffort: previous.reasoningEffort };
    } catch { notice = '暂时无法读取原会话档位，初始选择高；保存后按所选模型自动适配。'; }
  }
  const nativeEffort = current?.reasoningEffort;
  if (nativeEffort && nativeEffort !== 'default' && nativeEffort !== 'unavailable') return {
    effort: normalizeReasoningEffort(agent.id, nativeEffort), nativeEffort, model: current?.model, source: 'native',
  };
  const rows = models ?? normalizeNativeModels(await agent.listModels?.({ cwd }) ?? []);
  const model = current?.model ? rows.find(row => row.value === current!.model) : rows.find(row => row.value === 'default') ?? rows.find(row => row.isDefault);
  // A catalog's suggested default is not evidence of an existing session's setting.
  return { effort: INITIAL_REASONING, model: current?.model ?? (model?.value === 'default' ? undefined : model?.value), source: 'initial',
    ...(notice || nativeId ? { notice: notice ?? '原工具未提供当前档位，初始选择高；保存后按所选模型自动适配。' } : {}) };
}

/** Resolve at execution time; the persisted request/fingerprint keeps the user's original choice. */
export async function resolveRunReasoning(agent: AgentAdapter, sessions: WorkerSessionService | undefined, options: AgentRunOptions) {
  const models = normalizeNativeModels(await agent.listModels?.({ cwd: options.cwd }) ?? []);
  if (options.model && !models.some(row => row.value === options.model)) throw new Error('已选模型已移除或不可用，请刷新模型列表。');
  const nativeId = options.threadId ?? options.sessionId;
  const selection = await readReasoningSelection(agent, sessions, nativeId, options.cwd, models);
  const requested = options.reasoningEffort && options.reasoningEffort !== 'default'
    ? normalizeReasoningEffort(agent.id, options.reasoningEffort) : nativeId ? selection.effort : INITIAL_REASONING;
  const modelId = options.model ?? selection.model;
  const model = modelId ? models.find(row => row.value === modelId) : models.find(row => row.value === 'default') ?? models.find(row => row.isDefault);
  return { requested, nativeEffort: mapReasoningEffort(requested, model), model: model?.value === 'default' ? undefined : model?.value };
}
