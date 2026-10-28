import type { NormalizedMessage } from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import type { Controls } from '../commands';
import type { ActiveRuns } from './active-runs';
import type { PendingQueue } from './pending-queue';
import { DurableAgentAdapter } from '../worker/adapter';
import { messageRequestId } from '../worker/identity';
import { log } from '../core/logger';
import { isJobActive } from '../worker/protocol';

/** Both Feishu and Web persist before entering the same debounce/active-run queue. */
export async function enqueuePersonalInput({ agent, controls, activeRuns, pending, scope, msg }: {
  agent: AgentAdapter; controls: Controls; activeRuns: ActiveRuns; pending: PendingQueue; scope: string; msg: NormalizedMessage;
}): Promise<{ queued: boolean }> {
  let queued = pending.isBlocked(scope) || !!activeRuns.get(scope) || pending.snapshot().some(row => row.scope === scope && row.messages.length > 0);
  if (agent instanceof DurableAgentAdapter) {
    try {
      const id = messageRequestId(msg);
      const jobs = await agent.client.list();
      if (jobs.some(job => job.options.delivery?.scope === scope && job.options.delivery.messageIds?.includes(id))) return { queued: false };
      const binding = controls.toolBindings?.get(scope);
      queued ||= jobs.some(job => isJobActive(job) && (job.options.delivery?.scope === scope || !!binding?.nativeId &&
        job.options.delivery?.sourceId === binding.sourceId &&
        (job.options.threadId ?? job.options.sessionId ?? job.options.initialSessionId) === binding.nativeId));
    } catch { /* Submission will fail closed if the worker remains unavailable. */ }
    if (controls.workerInbox && !await controls.workerInbox.receive(scope, msg)) return { queued };
    if (controls.workerInbox && !controls.workerInbox.markQueued(scope, msg)) return { queued };
    if (activeRuns.get(scope)) pending.block(scope);
  }

  if (activeRuns.newRunsPaused()) return { queued }; // durable pending will resume on reconnect
  const size = pending.push(scope, msg);
  log.info('intake', 'queued', { scope, queueSize: size });
  return { queued };
}
