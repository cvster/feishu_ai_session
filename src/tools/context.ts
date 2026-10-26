import { commandSessionCatalogIdentity } from '../bot/session-catalog-identity';
import { canUseDm, canUseGroup } from '../policy/access';
import type { Controls, CommandContext } from '../commands';
import { toolProfile } from './runtime';
import type { AgentKind } from '../config/profile-schema';
import { RunRejected } from '../runtime/errors';
import { WorkerRequestError } from '../worker/client';

const roots = new WeakMap<Controls, Controls>();

/** View over shared controls: global service changes still reach the root;
 * tool/model reads are scoped to an immutable group binding. */
export function controlsForTool(root: Controls, toolId: AgentKind, scope?: string): Controls {
  root = roots.get(root) ?? root;
  const proxy = new Proxy(root, {
    get(target, key, receiver) {
      const binding = scope ? target.toolBindings?.get(scope) : undefined;
      const profile = toolProfile(target.profileConfig, toolId);
      const shared = binding?.linkedSource || binding?.auxiliaryWorkgroup;
      const settingsScope = scope && shared ? target.toolBindings?.settingsScope(scope) : scope;
      const settings = shared ? (settingsScope ? target.toolBindings?.get(settingsScope) : undefined) : binding;
      if (shared) { profile.preferences.model = undefined; profile.preferences.reasoningEffort = undefined; }
      if (settings?.model !== undefined) profile.preferences.model = settings.model === 'default' ? undefined : settings.model;
      if (settings?.reasoningEffort) profile.preferences.reasoningEffort = settings.reasoningEffort;
      if (key === 'runControlIcons') return { ...target.runControlIcons, supportsFork: true, ...(binding?.linkedSource ? { auxiliary: true } : {}) };
      if (key === 'profileConfig') return profile;
      if (key === 'cfg') return { ...target.cfg, agentKind: toolId,
        preferences: { ...target.cfg.preferences, model: profile.preferences.model, reasoningEffort: profile.preferences.reasoningEffort } };
      if (key === 'workerInbox') return target.workerRuntimes?.get(toolId)?.inbox;
      if (key === 'workerReplySync') return target.workerRuntimes?.get(toolId)?.replies;
      return Reflect.get(target, key, receiver);
    },
  });
  roots.set(proxy, root);
  return proxy;
}

export function toolForScope(controls: Controls, scope: string): AgentKind {
  return controls.toolBindings?.get(scope)?.toolId ?? controls.profileConfig.agentKind;
}

export async function routeCommandContext(ctx: CommandContext): Promise<CommandContext> {
  if (!ctx.controls.toolRegistry || !ctx.controls.toolRegistry.has(toolForScope(ctx.controls, ctx.scope))) return ctx;
  const id = toolForScope(ctx.controls, ctx.scope);
  const tool = ctx.controls.toolRegistry.get(id);
  const binding = ctx.controls.toolBindings?.get(ctx.scope);
  if (binding && binding.sourceId !== tool.sourceId) throw new Error('会话数据来源已变化，不能恢复到其他账户/目录');
  const controls = controlsForTool(ctx.controls, id, ctx.scope);
  const access = ctx.msg.chatType === 'p2p' ? canUseDm(controls.profileConfig, controls, ctx.msg.senderId) : canUseGroup(controls.profileConfig, controls, ctx.msg.chatId, ctx.msg.senderId);
  return { ...ctx, agent: tool.agent, controls,
    sessionCatalogIdentity: ctx.sessionCatalogIdentity?.agentId === id ? ctx.sessionCatalogIdentity : await commandSessionCatalogIdentity({ msg: ctx.msg, scope: ctx.scope, mode: ctx.chatMode, workspaces: ctx.workspaces, controls, access }),
    runExecutor: ctx.controls.executorForTool?.(id) ?? ctx.runExecutor };
}

/** Fail closed when a bound worker cannot confirm its native session state. */
export async function isWorkerScopeArchived(controls: Controls, scope: string): Promise<boolean> {
  const binding = controls.toolBindings?.get(scope);
  if (!binding?.nativeId) return false;
  const tool = controls.toolRegistry?.find(binding.toolId);
  if (!tool) throw new RunRejected('execution-worker-unavailable', '会话 worker 暂时不可用');
  if (tool.sourceId !== binding.sourceId) throw new RunRejected('archive-check-unavailable', '会话 worker 身份不匹配');
  const { DurableAgentAdapter } = await import('../worker/adapter');
  if (!(tool.agent instanceof DurableAgentAdapter)) return false;
  try {
    const health = await tool.agent.client.health();
    if (health.capabilities?.conversation) return (await tool.agent.client.conversation(binding.nativeId)).archived;
    if (health.capabilities?.sessions.list) {
      const row = (await tool.listSessions()).find(row => row.nativeId === binding.nativeId);
      if (!row && binding.nativeCreated !== false) throw new RunRejected('archive-check-unavailable', '无法确认原会话状态');
      return row?.archived === true;
    }
    throw new RunRejected('archive-check-unavailable', 'worker 不支持会话状态查询');
  } catch (error) {
    if (error instanceof WorkerRequestError && !error.retryable && (error.status < 500 || error.status === 501))
      throw new RunRejected('archive-check-unavailable', '无法确认原会话状态');
    throw error;
  }
}
