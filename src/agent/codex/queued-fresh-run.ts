import { CodexThreadReader } from '../../session/codex-thread-reader';
import type { AgentEvent, AgentRun } from '../types';
import { createCodexQueueRun } from './queue';
import { resolveSharedCodexEndpoint } from '../../../packages/codex-core/src/queue';
import { homedir } from 'node:os';
import { join } from 'node:path';

type FreshQueueOptions = Omit<Parameters<typeof createCodexQueueRun>[0], 'threadId'> & {
  developerInstructions?: string;
};

/** Prefer Desktop's writer for creation and its lifecycle notifications. */
export function createCodexQueuedFreshRun(options: FreshQueueOptions): AgentRun {
  let creator: CodexThreadReader | undefined;
  let task: AgentRun | undefined;
  let closed = false;
  let started = false;
  let settled = false;
  let settle!: () => void;
  const completed = new Promise<void>((resolve) => { settle = resolve; });
  const events = (async function* (): AsyncGenerator<AgentEvent> {
    started = true;
    try {
      if (closed) return;
      const home = options.codexHome ?? options.env?.CODEX_HOME ?? process.env.CODEX_HOME ??
        (options.inheritCodexHome ? join(homedir(), '.codex') : join(options.profileStateDir, 'codex-home'));
      const remote = await resolveSharedCodexEndpoint({
        codexHome: home, remote: options.remote ?? options.env?.CODEX_QUEUE_REMOTE ?? process.env.CODEX_QUEUE_REMOTE,
      });
      creator = new CodexThreadReader({
        binary: options.binary, profileStateDir: options.profileStateDir, codexHome: home,
        inheritCodexHome: options.inheritCodexHome, env: options.env,
        ...(remote ? { sharedServer: true, passive: true, remote } : {}),
      });
      const threadId = await creator.createIdleThread({ ...options, threadSource: 'user' });
      await creator?.stop();
      if (closed) return;
      // Expose the binding before submitting the first turn; shutdown drains
      // system events and flushes the catalog for snapshot-sync recovery.
      yield { type: 'system', threadId, cwd: options.cwd,
        model: options.model, reasoningEffort: options.reasoningEffort };
      if (closed) return;
      task = createCodexQueueRun({ ...options, threadId });
      yield* task.events;
    } catch (error) {
      if (!closed) yield { type: 'error', terminationReason: 'failed',
        message: `Codex 首轮提交失败：${error instanceof Error ? error.message : String(error)}` };
    } finally {
      await creator?.stop();
      settled = true;
      settle();
    }
  })();
  const close = async (cancel: boolean): Promise<void> => {
    if (settled) return;
    closed = true;
    if (!started) { settled = true; settle(); return; }
    if (task) {
      if (cancel) await task.stop();
      else await task.detach!();
    }
    await completed;
  };
  return {
    runId: options.runId, events,
    stop: () => close(true),
    detach: () => close(false),
    waitForExit(timeoutMs) {
      if (settled) return Promise.resolve(true);
      return Promise.race([completed.then(() => true),
        new Promise<boolean>((resolve) => { const timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.(); })]);
    },
  };
}
