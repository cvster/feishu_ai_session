import type { NormalizedMessage } from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types';
import type { Controls } from '../commands';
import type { ActiveRuns } from './active-runs';
import type { PendingQueue } from './pending-queue';
import { DurableAgentAdapter } from '../worker/adapter';
import { messageRequestId } from '../worker/identity';
import { log } from '../core/logger';

/** Both Feishu and Web persist before entering the same debounce/active-run queue. */
export async function enqueuePersonalInput({ agent, controls, activeRuns, pending, scope, msg }: {
  agent: AgentAdapter; controls: Controls; activeRuns: ActiveRuns; pending: PendingQueue; scope: string; msg: NormalizedMessage;
}): Promise<void> {
  if (agent instanceof DurableAgentAdapter) {
    try {
      const id = messageRequestId(msg);
      if ((await agent.client.list()).some(job => job.options.delivery?.scope === scope && job.options.delivery.messageIds?.includes(id))) return;
    } catch { /* Submission will fail closed if the worker remains unavailable. */ }
    if (controls.workerInbox && !await controls.workerInbox.receive(scope, msg)) return;
    if (controls.workerInbox && !controls.workerInbox.markQueued(scope, msg)) return;
    if (activeRuns.get(scope)) pending.block(scope);
  }

  if (activeRuns.newRunsPaused()) return; // durable pending will resume on reconnect
  const size = pending.push(scope, msg);
  log.info('intake', 'queued', { scope, queueSize: size });
}
