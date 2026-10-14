import type { AgentAdapter, AgentBotIdentity, AgentEvent, AgentRun, AgentRunOptions } from '../agent/types';
import { RunRejected } from '../runtime/errors';
import { WorkerClient, WorkerRequestError } from './client';
import { isJobActive } from './protocol';
import { jobIdFor } from './store';

/** Execution belongs to the worker; this object owns only a detachable observer. */
export class DurableClaudeAdapter implements AgentAdapter {
  readonly id = 'claude';
  readonly displayName = 'Claude Code';
  private identity?: AgentBotIdentity;
  constructor(readonly client: WorkerClient, private readonly cli: AgentAdapter) {}
  setBotIdentity(identity: AgentBotIdentity): void { this.identity = identity; }
  async isAvailable(): Promise<boolean> {
    if (!await this.cli.isAvailable()) return false;
    return this.client.health().then(() => true, () => false);
  }
  async prepareRun(): Promise<void> {
    try { await this.client.health(); }
    catch { throw new RunRejected('execution-worker-unavailable', 'Claude 执行服务不可用，本次请求未执行。请先启动独立 worker 服务。'); }
  }
  run(options: AgentRunOptions): AgentRun {
    const requestKey = options.requestKey ?? options.runId;
    const id = jobIdFor(requestKey);
    return this.observe(id, () => this.client.submit({ requestKey, options, botIdentity: this.identity }));
  }
  observe(id: string, submit?: () => Promise<unknown>): AgentRun {
    let detached = false;
    let done = false;
    let started: Promise<unknown> | undefined;
    let wake: (() => void) | undefined;
    const client = this.client;
    const start = () => started ??= submit ? submit() : Promise.resolve();
    return {
      runId: id,
      events: {
        async *[Symbol.asyncIterator]() {
          let after = 0;
          try {
            await start();
            while (!detached) {
              try {
                const snapshot = await client.snapshot(id, after);
                for (const row of snapshot.events) {
                  if (detached) return;
                  after = row.seq; yield row.event;
                }
                if (!isJobActive(snapshot.job)) { done = true; return; }
              } catch {
                // Connection loss is never a reason to resubmit or cancel a task.
              }
              if (!detached) await new Promise<void>(resolve => {
                const timer = setTimeout(() => { wake = undefined; resolve(); }, 500);
                wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
              });
            }
          } catch (error) {
            done = true;
            const knownRejection = error instanceof WorkerRequestError && error.status < 500;
            yield { type: 'error', terminationReason: 'failed', submissionStatus: knownRejection ? 'rejected' : 'unknown',
              retryable: knownRejection && error.retryable,
              message: `${knownRejection ? '本次请求未执行' : '请求接收未确认，未自动重发'}：${error instanceof Error ? error.message : String(error)}` } satisfies AgentEvent;
          }
        },
      },
      async detach() { detached = true; wake?.(); },
      async stop() { await start(); await client.stop(id); },
      async waitForExit(timeoutMs) {
        if (detached || done) return true;
        const deadline = Date.now() + timeoutMs;
        do {
          try { if (!isJobActive((await client.snapshot(id)).job)) return true; } catch { return false; }
          if (Date.now() >= deadline) return false;
          await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
        } while (true);
      },
    };
  }
}
