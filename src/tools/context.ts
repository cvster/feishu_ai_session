import { commandSessionCatalogIdentity } from '../bot/session-catalog-identity';
import { canUseDm, canUseGroup } from '../policy/access';
import type { Controls, CommandContext } from '../commands';
import { toolProfile } from './runtime';
import type { AgentKind } from '../config/profile-schema';

const roots = new WeakMap<Controls, Controls>();

/** View over shared controls: global service changes still reach the root;
 * tool/model reads are scoped to an immutable group binding. */
export function controlsForTool(root: Controls, toolId: AgentKind, scope?: string): Controls {
  root = roots.get(root) ?? root;
  const proxy = new Proxy(root, {
    get(target, key, receiver) {
      const binding = scope ? target.toolBindings?.get(scope) : undefined;
      const profile = toolProfile(target.profileConfig, toolId);
      if (binding?.model !== undefined) profile.preferences.model = binding.model === 'default' ? undefined : binding.model;
      if (binding?.reasoningEffort) profile.preferences.reasoningEffort = binding.reasoningEffort;
      if (key === 'profileConfig') return profile;
      if (key === 'cfg') return { ...target.cfg, agentKind: toolId,
        preferences: { ...target.cfg.preferences, model: profile.preferences.model, reasoningEffort: profile.preferences.reasoningEffort } };
      if (toolId !== 'codex' && ['codexSubmissions', 'codexReplySync', 'codexUserInput'].includes(String(key))) return undefined;
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
  if (!ctx.controls.toolRegistry) return ctx;
  const id = toolForScope(ctx.controls, ctx.scope);
  const tool = ctx.controls.toolRegistry.get(id);
  const binding = ctx.controls.toolBindings?.get(ctx.scope);
  if (binding && binding.sourceId !== tool.sourceId) throw new Error('会话数据来源已变化，不能恢复到其他账户/目录');
  const controls = controlsForTool(ctx.controls, id, ctx.scope);
  const access = ctx.msg.chatType === 'p2p' ? canUseDm(controls.profileConfig, controls, ctx.msg.senderId) : canUseGroup(controls.profileConfig, controls, ctx.msg.chatId, ctx.msg.senderId);
  return { ...ctx, agent: tool.agent, controls,
    sessionCatalogIdentity: await commandSessionCatalogIdentity({ msg: ctx.msg, scope: ctx.scope, mode: ctx.chatMode, workspaces: ctx.workspaces, controls, access }),
    runExecutor: ctx.controls.executorForTool?.(id) ?? ctx.runExecutor };
}
