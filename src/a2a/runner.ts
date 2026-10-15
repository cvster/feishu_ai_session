import type { NormalizedMessage } from '@larksuite/channel';
import { claudeCapability, codexCapability } from '../agent/capability';
import { initialState, reduce } from '../card/run-state';
import type { Controls } from '../commands';
import type { AuxiliaryApproval } from '../bot/auxiliary-approvals';
import { prepareRunFlow, recordRunSessionEvent, startRunFlow } from '../bot/run-flow';
import { controlsForTool } from '../tools/context';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import type { ApiTask, TaskState } from './store';
import type { TaskExecutionContext } from './server';

export function createA2ARunner(deps: { controls: Controls; sessions: SessionStore; sessionCatalog?: SessionCatalog; workspaces: WorkspaceStore }) {
  return async (task: ApiTask, context: TaskExecutionContext, approval?: AuxiliaryApproval): Promise<{ state: TaskState; text: string; notice?: string }> => {
    const { controls: root, sessions, sessionCatalog, workspaces } = deps;
    const auxiliary = root.auxiliary!;
    return auxiliary.withRun(task.scope, async () => {
      if (!await context.valid()) throw new Error('API 授权已失效');
      const session = auxiliary.apiSession(task.sharedScope), binding = root.toolBindings!.get(task.scope);
      if (!session || !binding || binding.sharedScope !== task.sharedScope || binding.sourceId !== root.toolRegistry!.get(binding.toolId).sourceId) throw new Error('FF 会话身份已变化');
      workspaces.setCwd(task.scope, session.cwd);
      const controls = controlsForTool(root, binding.toolId, task.scope);
      const capability = binding.toolId === 'codex' ? codexCapability(controls.profileConfig) : claudeCapability(controls.profileConfig);
      const messageId = approval?.receiptMessageId ?? task.messageId;
      const text = approval ? `继续此前请求：${task.question}\n本次仅执行已确认操作：${approval.action}。不要重复已完成的动作。` : task.question;
      const message = { messageId, chatId: task.scope, chatType: 'p2p', senderId: task.actorId,
        senderName: `API：${task.callerName}`, createTime: Date.now(), content: text, resources: [], mentions: [], mentionAll: false,
        mentionedBot: true, rawContentType: 'text' } as NormalizedMessage;
      await root.auxiliaryApprovals!.remember(task.scope, [message], task.question);
      const grant = approval ? root.auxiliaryApprovals!.grant(task.scope, [messageId!], [task.actorId]) : undefined;
      if (approval && !grant) throw new Error('本次确认已失效');
      const prompt = await auxiliary.wrapPrompt(task.scope, text, [task.actorId], grant ? { id: grant.id, action: grant.action, ownerId: grant.ownerId } : undefined);
      const flowInput: Parameters<typeof startRunFlow>[0] = {
        scopeId: task.scope, scope: { source: 'a2a', chatId: task.scope, actorId: task.actorId }, prompt, attachments: [],
        access: { ok: true, reason: 'allowed-chat' }, capability, profileConfig: controls.profileConfig,
        sessions, sessionCatalog, workspaces, executor: root.executorForTool!(binding.toolId),
        checkSessionArchived: async () => !await context.valid() || !auxiliary.isActive(task.scope) ||
          !!(binding.toolId === 'codex' && binding.nativeId && await root.codexReplySync?.isThreadArchived?.(binding.nativeId)),
        now: Date.now(), requestKey: JSON.stringify(['a2a', root.profile, task.id, approval?.id ?? 'initial']),
        observability: { profile: root.profile, agent: binding.toolId, source: 'a2a', stage: 'submit' },
      };
      // Seed a routing entry under this task's own policy identity, so the existing
      // run flow resumes exactly the shared FF, never the linked original AA.
      const prepared = await prepareRunFlow(flowInput);
      if (!prepared.ok) return { state: 'TASK_STATE_FAILED', text: '', notice: prepared.rejectReason.userVisible };
      await auxiliary.prepareScope(task.scope, { scopeId: task.scope, agentId: binding.toolId,
        cwdRealpath: prepared.cwdRealpath, policyFingerprint: prepared.policy.policyFingerprint });
      const flow = await startRunFlow(flowInput);
      if (!flow.ok) return { state: 'TASK_STATE_FAILED', text: '', notice: flow.rejectReason.userVisible };
      const execution = flow.execution;
      let stopping: Promise<void> | undefined;
      const stop = () => stopping ??= execution.stop();
      context.onStop(stop);
      let state = structuredClone(initialState), observedTerminal = false;
      try {
        await context.working();
        for await (const event of execution.subscribe()) {
          if (!await context.valid()) {
            if (!context.closing()) await stop();
            return { state: 'TASK_STATE_REJECTED', text: '', notice: '任务已停止或授权已失效' };
          }
          if (event.type === 'system') {
            const nativeId = binding.toolId === 'codex' ? event.threadId : event.sessionId;
            const current = root.toolBindings!.get(task.scope)!;
            if (nativeId) {
              if (nativeId === current.linkedSource?.nativeId) throw new Error('拒绝恢复原会话');
              root.toolBindings!.set(task.scope, { ...current, nativeId, nativeCreated: true });
            }
          }
          recordRunSessionEvent({ scopeId: task.scope, botAppId: controls.profileConfig.accounts.app.id,
            sessions, sessionCatalog, capability, policy: flow.policy, event });
          if (event.type === 'user_input' && event.prompt.request.isBlocking) {
            // The first version has no arbitrary API-side approval/input channel.
            // Stop this turn instead of leaving an unanswerable blocking request.
            await stop(); return { state: 'TASK_STATE_FAILED', text: '', notice: '执行工具要求额外输入，请在个人工作群处理后提交新任务。' };
          }
          state = reduce(state, event);
          if (event.type === 'text') {
            const visible = await root.auxiliaryApprovals!.review(task.scope, execution.runId, messageId, state);
            await context.progress(visible.blocks.filter(b => b.kind === 'text').map(b => b.content).join('\n\n'));
          }
          if (event.type === 'done' || event.type === 'error') observedTerminal = true;
        }
        if (!observedTerminal || execution.handle.detached) throw new Error('运行结束状态未确认');
        const reviewed = await root.auxiliaryApprovals!.review(task.scope, execution.runId, messageId, state);
        const answer = reviewed.blocks.filter(b => b.kind === 'text').map(b => b.content).join('\n\n');
        if (reviewed.permissionApproval === 'pending' || reviewed.permissionApproval === 'approved') return {
          state: 'TASK_STATE_AUTH_REQUIRED', text: '', notice: '受限操作等待所有者在飞书确认，请继续查询原任务。',
        };
        if (reviewed.permissionApproval) return { state: 'TASK_STATE_REJECTED', text: '', notice: answer };
        return { state: state.terminal === 'done' ? 'TASK_STATE_COMPLETED' : state.terminal === 'interrupted' ? 'TASK_STATE_CANCELED' : 'TASK_STATE_FAILED', text: answer,
          ...(state.errorMsg ? { notice: state.errorMsg } : {}) };
      } catch (error) {
        if (!context.closing() && !execution.handle.detached) await stop().catch(() => {});
        throw error;
      } finally {
        await Promise.all([root.toolBindings!.flush(), sessions.flush(), sessionCatalog?.flush(), workspaces.flush()]);
      }
    });
  };
}
