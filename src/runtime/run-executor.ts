import { DEFAULT_MODEL, normalizeNativeModels, resolveReasoningEffort } from '../agent/models';
import type { NativeSessionLocks } from '../tools/locks';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../agent/types';
import { ActiveRuns, type RunHandle } from '../bot/active-runs';
import { ProcessPool } from '../bot/process-pool';
import type { RunPolicyAllow } from '../policy/run-policy';
import { log } from '../core/logger';
import { RunRejected, SpawnFailed } from './errors';
import type { RunDelivery } from '../worker/protocol';

export interface RunExecutorDeps {
  agent: AgentAdapter;
  pool: ProcessPool;
  activeRuns: ActiveRuns;
  createRunId?: () => string;
  now?: () => number;
  postDoneExitGraceMs?: number;
  sessionNameForScope?(scope: string): string | undefined;
  initialSessionIdForScope?(scope: string): string | undefined;
  nativeSessionLocks?: NativeSessionLocks;
  nativeSessionKey?(nativeId: string): string;
}

export interface SubmitRunInput {
  submissionId?: string;
  /** Synchronous cancellation check around pool/preflight waits. */
  validateBeforeStart?: () => void;
  /** Fresh external-state check immediately before starting the adapter. */
  beforeSpawn?: () => Promise<void>;
  scopeId: string;
  policy: RunPolicyAllow;
  sessionId?: string;
  threadId?: string;
  model?: string;
  reasoningEffort?: string;
  images?: readonly string[];
  attachmentPaths?: readonly string[];
  stopGraceMs?: number;
  requestKey?: string;
  delivery?: RunDelivery;
  idleTimeoutMs?: number;
  nowait?: boolean;
  observability?: {
    profile: string;
    agent: string;
    source: string;
    stage: string;
  };
}

export interface RunExecution {
  runId: string;
  scopeId: string;
  run: AgentRun;
  handle: RunHandle;
  subscribe(): AsyncIterable<AgentEvent>;
  stop(): Promise<void>;
}

const DEFAULT_POST_DONE_EXIT_GRACE_MS = 2000;

export class RunExecutor {
  private readonly nativeSessionLocks?: NativeSessionLocks;
  private readonly nativeSessionKey?: RunExecutorDeps['nativeSessionKey'];
  private readonly initialSessionIdForScope?: RunExecutorDeps['initialSessionIdForScope'];
  private readonly sessionNameForScope: RunExecutorDeps['sessionNameForScope'];
  private readonly agent: AgentAdapter;
  private readonly pool: ProcessPool;
  private readonly activeRuns: ActiveRuns;
  private readonly createRunId: () => string;
  private readonly now: () => number;
  private readonly postDoneExitGraceMs: number;

  constructor(deps: RunExecutorDeps) {
    this.agent = deps.agent;
    this.sessionNameForScope = deps.sessionNameForScope;
    this.initialSessionIdForScope = deps.initialSessionIdForScope;
    this.nativeSessionLocks = deps.nativeSessionLocks;
    this.nativeSessionKey = deps.nativeSessionKey;
    this.pool = deps.pool;
    this.activeRuns = deps.activeRuns;
    this.createRunId = deps.createRunId ?? randomUUID;
    this.now = deps.now ?? Date.now;
    this.postDoneExitGraceMs = deps.postDoneExitGraceMs ?? DEFAULT_POST_DONE_EXIT_GRACE_MS;
  }

  private async validateModel(options: Pick<AgentRunOptions, 'model' | 'cwd' | 'reasoningEffort'>): Promise<void> {
    const effort = resolveReasoningEffort(options.reasoningEffort);
    if (options.reasoningEffort && options.reasoningEffort !== 'default' && !effort) throw new RunRejected('model-unavailable', '推理档位格式无效，请通过 /config 重新选择。');
    options.reasoningEffort = effort;
    if (this.agent.mapsReasoningEffort || (!options.model && !effort) || !this.agent.listModels) return;
    let models;
    try { models = await this.agent.listModels({ cwd: options.cwd }); }
    catch { throw new RunRejected('model-unavailable', '暂时无法确认工具模型列表，本次未执行。请重新打开 /config 刷新后重试。'); }
    models = normalizeNativeModels(models);
    if (options.model && !models.some(model => model.value === options.model)) throw new RunRejected('model-unavailable', '已选模型已移除或不可用，本次未执行。请通过 /config 重新选择模型。');
    const selected = options.model ? models.find(model => model.value === options.model)
      : models.find(model => model.value === DEFAULT_MODEL) ?? models.find(model => model.isDefault);
    if (effort && !selected?.reasoningEfforts?.some(option => option.value === effort)) throw new RunRejected('model-unavailable', '已选模型的推理档位已变化或未提供该档位，本次未执行。请通过 /config 刷新，或选择跟随工具默认。');
  }

  async submit(input: SubmitRunInput): Promise<RunExecution> {
    const nativeId = input.threadId ?? input.sessionId;
    if (!nativeId || !this.nativeSessionLocks || !this.nativeSessionKey) return this.submitImpl(input);
    const release = this.nativeSessionLocks.acquire(this.nativeSessionKey(nativeId));
    if (!release) throw new RunRejected('run-already-active', '同一工具会话已有桥接任务运行');
    try {
      return await this.submitImpl(input, release);
    } catch (e) { release(); throw e; }
  }

  private async submitImpl(input: SubmitRunInput, releaseNative?: () => void): Promise<RunExecution> {
    const submittedAt = this.now();
    if (input.policy.expiresAt <= this.now()) {
      throw new RunRejected('policy-expired', 'run policy expired before spawn');
    }
    if (this.activeRuns.newRunsPaused()) {
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    const releaseScope = this.activeRuns.reserve(input.scopeId);
    if (!releaseScope) {
      throw new RunRejected('run-already-active', 'another run is already active for this scope');
    }

    const release = input.nowait ? this.pool.tryAcquire() : await this.pool.acquire();
    if (!release) {
      releaseScope();
      throw new RunRejected('pool-full', 'process pool is full');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }

    const runId = input.requestKey ? createHash('sha256').update(input.requestKey).digest('hex') : this.createRunId();
    const startedAt = this.now();
    const queueWaitMs = startedAt - submittedAt;
    const runOptions = {
      runId,
      prompt: input.policy.prompt,
      cwd: input.policy.cwdRealpath,
      sessionId: input.sessionId,
      sessionName: this.sessionNameForScope?.(input.scopeId),
      initialSessionId: input.sessionId ? undefined : this.initialSessionIdForScope?.(input.scopeId),
      requestKey: input.requestKey,
      delivery: input.delivery,
      idleTimeoutMs: input.idleTimeoutMs,
      threadId: input.threadId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      images: input.images,
      ...((this.agent.id === 'zcode' || this.agent.id === 'kilo' || this.agent.id === 'dsh') ? { accessMode: input.policy.accessMode } : {}),
      attachmentPaths: input.attachmentPaths,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
      stopGraceMs: input.stopGraceMs,
    };
    let run: AgentRun;
    try {
      input.validateBeforeStart?.();
      await this.validateModel(runOptions);
      await this.agent.prepareRun?.(runOptions);
      await input.beforeSpawn?.();
      input.validateBeforeStart?.();
    } catch (err) {
      release();
      releaseScope();
      if (err instanceof SpawnFailed || err instanceof RunRejected) throw err;
      throw new SpawnFailed('agent prepare failed', err, 'agent-prepare-failed');
    }
    if (this.activeRuns.newRunsPaused()) {
      release();
      releaseScope();
      throw new RunRejected(
        'reconnect-in-progress',
        this.activeRuns.newRunsPauseReason() ?? 'new runs are temporarily paused',
      );
    }
    try {
      run = this.agent.run(runOptions);
    } catch (err) {
      release();
      releaseScope();
      throw new SpawnFailed('agent spawn failed', err);
    }
    const dimensions = {
      runId,
      profile: input.observability?.profile ?? 'unknown',
      agent: input.observability?.agent ?? this.agent.id,
      scope: input.scopeId,
      source: input.observability?.source ?? 'unknown',
      stage: input.observability?.stage ?? 'submit',
    };
    log.info('run', 'started', {
      ...dimensions,
      queueWaitMs,
      accessMode: input.policy.accessMode,
      sandbox: input.policy.sandbox,
      permissionMode: input.policy.permissionMode,
    });

    let handle: RunHandle;
    try {
      handle = this.activeRuns.register(input.scopeId, run);
    } catch (err) {
      releaseScope();
      release();
      await run.stop().catch(() => {});
      throw new RunRejected(
        'run-already-active',
        err instanceof Error ? err.message : 'another run is already active for this scope',
      );
    }
    let cleaned = false;
    const cleanup = async (waitForExit: boolean): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      this.activeRuns.unregister(input.scopeId, run);
      release();
      try {
        if (waitForExit || (releaseNative && !handle.detached)) {
          const exited = await run.waitForExit(this.postDoneExitGraceMs);
          if (!exited) {
            if (run.detach) { await run.detach(); return; }
            log.warn('run', 'post-done-exit-timeout', {
              ...dimensions,
              graceMs: this.postDoneExitGraceMs,
            });
            await run.stop().catch((err) => {
              log.warn('run', 'post-done-stop-failed', {
                ...dimensions,
                err: err instanceof Error ? err.message : String(err),
              });
            });
          }
        }
      } finally {
        releaseNative?.();
      }
    };
    const fanout = new EventFanout(observeRunEvents(run.events, {
      dimensions,
      startedAt,
      now: this.now,
    }), async () => {
      await cleanup(!handle.interrupted && !handle.detached);
    });

    return {
      runId,
      scopeId: input.scopeId,
      run,
      handle,
      subscribe: () => fanout.subscribe(),
      stop: async () => {
        handle.interrupted = true;
        await run.stop();
        await run.waitForExit(this.postDoneExitGraceMs);
        await cleanup(false);
      },
    };
  }
}

function observeRunEvents(
  events: AsyncIterable<AgentEvent>,
  opts: {
    dimensions: Record<string, unknown>;
    startedAt: number;
    now: () => number;
  },
): AsyncIterable<AgentEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      for await (const event of events) {
        if (event.type === 'done') {
          log.info('run', 'completed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
          });
          yield event;
          return;
        }
        if (event.type === 'error') {
          log.warn('run', 'failed', {
            ...opts.dimensions,
            result: event.terminationReason,
            durationMs: opts.now() - opts.startedAt,
            error: event.message,
          });
          yield event;
          return;
        }
        yield event;
      }
    },
  };
}

class EventFanout {
  private readonly source: AsyncIterable<AgentEvent>;
  private readonly onDone: () => Promise<void>;
  private readonly buffer: AgentEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private started = false;
  private done = false;
  private error: unknown;

  constructor(source: AsyncIterable<AgentEvent>, onDone: () => Promise<void>) {
    this.source = source;
    this.onDone = onDone;
  }

  subscribe(): AsyncIterable<AgentEvent> {
    return {
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async (): Promise<IteratorResult<AgentEvent>> => {
            this.start();
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            if (this.done) return { done: true, value: undefined };
            await new Promise<void>((resolve) => {
              const wake = (): void => {
                this.waiters.delete(wake);
                resolve();
              };
              this.waiters.add(wake);
            });
            if (index < this.buffer.length) {
              return { done: false, value: this.buffer[index++]! };
            }
            if (this.error) throw this.error;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const event of this.source) {
        this.buffer.push(event);
        this.wakeAll();
        if (isTerminalEvent(event)) break;
      }
    } catch (err) {
      this.error = err;
    } finally {
      await this.onDone();
      this.done = true;
      this.wakeAll();
    }
  }

  private wakeAll(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

function isTerminalEvent(event: AgentEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}
