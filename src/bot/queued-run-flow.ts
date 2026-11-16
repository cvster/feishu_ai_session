import type { StartRunFlowInput, StartRunFlowResult } from './run-flow';
import { prepareRunFlow } from './run-flow';
import { DurableAgentAdapter } from '../worker/adapter';
import { jobIdFor } from '../worker/store';
import { resolveModelArg, resolveReasoningEffort } from '../agent/models';
import type { WorkerJob } from '../worker/protocol';
/** Policy and workspace checks remain in the bridge; all waiting/execution is worker-owned. */
export async function submitQueuedRunFlow(
  input: StartRunFlowInput,
  agent: DurableAgentAdapter,
): Promise<Extract<StartRunFlowResult, { ok: false }> | { ok: true; job: WorkerJob }> {
  const prepared = await prepareRunFlow(input);
  if (!prepared.ok) return prepared;
  if (!input.requestKey) throw new Error('Durable submission requires a request key');
  if (await input.checkSessionArchived?.())
    return {
      ok: false,
      rejectReason: { code: 'session-archived', userVisible: '会话已归档，未提交新消息。' },
    };
  const policy = prepared.policy;
  const job = await agent.submitQueued({
    enqueue: true,
    requestKey: input.requestKey,
    options: {
      runId: jobIdFor(input.requestKey),
      requestKey: input.requestKey,
      prompt: policy.prompt,
      cwd: prepared.cwdRealpath,
      sessionId: prepared.sessionId,
      threadId: prepared.threadId,
      sessionName: input.sessionName,
      initialSessionId:
        prepared.sessionId || prepared.threadId ? undefined : input.initialSessionId,
      model:
        input.model ??
        resolveModelArg(input.profileConfig.agentKind, input.profileConfig.preferences.model),
      reasoningEffort: resolveReasoningEffort(input.profileConfig.preferences.reasoningEffort),
      images: policy.attachments
        .filter((a) => a.kind === 'image' && a.decision === 'accepted')
        .map((a) => a.path)
        .filter((p): p is string => !!p),
      attachmentPaths: policy.attachments
        .filter((a) => a.decision === 'accepted' && a.kind !== 'image')
        .map((a) => a.path)
        .filter((p): p is string => !!p),
      accessMode: policy.accessMode,
      sandbox: policy.sandbox,
      permissionMode: policy.permissionMode,
      delivery: input.delivery
        ? { ...input.delivery, policyFingerprint: policy.policyFingerprint }
        : undefined,
      stopGraceMs: input.stopGraceMs,
      idleTimeoutMs: input.idleTimeoutMs,
    },
  });
  return { ok: true, job };
}
