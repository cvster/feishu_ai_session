import type { AgentAdapter, AgentBotIdentity, AgentEvent, AgentRun, AgentRunOptions } from '../agent/types';
import { resolveReasoningEffort } from '../agent/models';
import { RunRejected } from '../runtime/errors';
import { WorkerClient, WorkerRequestError } from './client';
import { isJobActive } from './protocol';
import { jobIdFor } from './store';

/** Execution belongs to the worker; this object owns only a detachable observer. */
export class DurableAgentAdapter implements AgentAdapter {
  get id(): string { return this.client.toolId; }
  get displayName(): string { return this.cli.displayName; }
  private identity?: AgentBotIdentity;
  constructor(readonly client: WorkerClient, private readonly cli: AgentAdapter) {}
  setBotIdentity(identity: AgentBotIdentity): void { this.identity = identity; }
  async isAvailable(): Promise<boolean> {
    if (!await this.cli.isAvailable()) return false;
    return this.client.health().then(() => true, () => false);
  }
  async listModels(options?: { cwd?: string }) {
    if (this.id === 'zcode' && 'desktopRemoteEnabled' in this.cli && this.cli.desktopRemoteEnabled === true) {
      await this.prepareRun(); return this.client.models(options?.cwd);
    }
    if (!this.cli.listModels) throw new Error('工具未提供原生模型列表');
    return this.cli.listModels(options);
  }
  async prepareRun(options?: AgentRunOptions): Promise<void> {
    let capabilities;
    try { capabilities = await this.client.health(); }
    catch { throw new RunRejected('execution-worker-unavailable', `${this.displayName} 执行服务不可用，本次请求未执行。请先启动对应工具的独立 worker 服务。`); }
    if (this.id === 'zcode' && !capabilities?.zcodeRegistryResume) throw new RunRejected('model-unavailable', 'ZCode worker 尚未升级到保留原会话供应商的版本，本次未执行。请单独升级 ZCode worker。');
    if (this.id === 'kilo' && (!capabilities?.kiloEditorSync || !capabilities?.kiloDesktopSync)) throw new RunRejected('model-unavailable', 'Kilo worker 尚未升级到编辑器和桌面 App 实时同步版本，本次未执行。请单独升级 Kilo worker。');
    if (this.id === 'zcode' && 'desktopRemoteEnabled' in this.cli && (
      (this.cli.desktopRemoteEnabled === true) !== (capabilities?.zcodeDesktopRemote === true) ||
      (this.cli.desktopRemoteEnabled === true && 'desktopRemoteConfigId' in this.cli && this.cli.desktopRemoteConfigId !== capabilities?.zcodeDesktopRemoteConfigId)
    )) throw new RunRejected('execution-worker-unavailable', 'ZCode worker 的桌面配对模式与配置不一致，请单独升级或重启 ZCode worker；本次未执行。');
    const effort = resolveReasoningEffort(options?.reasoningEffort);
    // Old Claude workers preserve these exact tokens, but coerce unknown levels to high.
    const legacySafe = this.id === 'claude' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort ?? '');
    if (effort && !legacySafe && !capabilities?.nativeReasoningEfforts) {
      throw new RunRejected('model-unavailable', '对应 worker 版本尚不支持该原生推理档位。请单独升级该 worker，或选择跟随工具默认。');
    }
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

/** Backward compatible constructor for existing Claude integrations. */
export class DurableClaudeAdapter extends DurableAgentAdapter {}
