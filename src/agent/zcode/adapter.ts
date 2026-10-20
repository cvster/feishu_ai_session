import { listZcodeModelCapabilities, loadZcodeProviderRegistry, loadZcodeRuntimeModel } from './model-config';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { resolveReasoningEffort } from '../models';
import { AgentPreflightError, checkAgentAvailability, type AgentPreflightDiagnostic } from '../preflight';
import { ZcodeClient, zcodeCommand, type ZcodeOptions } from './client';
import { ZcodeRemoteClient, readZcodePairing } from './remote-client';

export function zcodeWorkspace(cwd: string) {
  return { workspacePath: cwd, workspaceKey: createHash('sha256').update(cwd).digest('hex') };
}
/** The independent worker owns this connection; bridge restarts only detach observers. */
export class ZcodeAdapter implements AgentAdapter {
  readonly id = 'zcode'; readonly displayName = 'ZCode';
  get desktopRemoteEnabled() { return !!this.options.remoteControlFile; }
  get desktopRemoteConfigId() { return this.options.remoteControlFile ? createHash('sha256').update(resolve(this.options.remoteControlFile)).digest('hex') : undefined; }
  constructor(readonly options: ZcodeOptions = {}) {}
  async checkAvailability() {
    if (this.options.remoteControlFile) {
      try { await readZcodePairing(this.options.remoteControlFile); }
      catch {
        const diagnostic: AgentPreflightDiagnostic = { code: 'agent-binary-not-readable', agentId: 'zcode', agentName: 'ZCode', command: 'desktop-remote', field: 'zcode.remoteControlFile' };
        return { ok: false as const, diagnostic, error: new AgentPreflightError(diagnostic, 'ZCode 远控配对文件不可用，请重新配对') };
      }
    }
    const command = zcodeCommand(this.options);
    return checkAgentAvailability({ agentId: 'zcode', agentName: 'ZCode', command: command.binary, binaryPath: command.binary, args: [...command.args, '--version'] });
  }
  async isAvailable(): Promise<boolean> { return (await this.checkAvailability()).ok; }
  listModels() { return listZcodeModelCapabilities(this.options); }
  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('ZCode requires a project directory');
    const client = this.options.remoteControlFile ? new ZcodeRemoteClient(this.options.remoteControlFile, opts.cwd) : new ZcodeClient(this.options, opts.cwd);
    const queue: AgentEvent[] = []; let wake: (() => void) | undefined;
    let ended = false, stopping = false, sessionId: string | undefined, sent = false, currentTurn: string | undefined;
    const inputId = `bridge-${opts.runId}`;
    let ownTurnStarted = false; const sequences = new Map<string, number>();
    const push = (event: AgentEvent) => { if (!ended) { queue.push(event); if (event.type === 'done' || event.type === 'error') { ended = true; finish(); } wake?.(); } };
    let response = '';
    let finish!: () => void; const finished = new Promise<void>(resolve => { finish = resolve; });
    client.onInteraction = method => push({ type: 'error', terminationReason: 'failed',
      ...(this.options.remoteControlFile ? { submissionStatus: sent ? 'unknown' as const : 'rejected' as const } : {}),
      message: this.options.remoteControlFile ? `ZCode 桌面请求交互 ${method}，请在桌面处理。本次飞书观察结束，桌面任务未取消；桥接未自动同意或重发。` : `ZCode 请求尚未适配的交互 ${method}，桥接未自动同意。` });
    client.onNotification((method, params) => {
      const event = params?.event ?? params;
      if (method !== 'session/event' || !event || event.sessionId !== sessionId || !sent) return;
      const payload = event.payload ?? {};
      if (payload.inputId && payload.inputId !== inputId) return;
      if (event.type === 'turn.started') { currentTurn = event.turnId; ownTurnStarted = true; return; }
      if (!ownTurnStarted && payload.inputId !== inputId) return;
      if (currentTurn && event.turnId && currentTurn !== event.turnId) return;
      const sequenceKey = event.turnId ?? '';
      if (typeof event.seq === 'number') {
        if (event.seq <= (sequences.get(sequenceKey) ?? -1)) return;
        sequences.set(sequenceKey, event.seq);
      }
      if (event.type === 'model.streaming' || event.type === 'part.delta') {
        if (payload.kind === 'text_delta' || payload.field === 'text') { response += payload.delta ?? ''; push({ type: 'text', delta: payload.delta ?? '' }); }
        else if (payload.kind === 'reasoning_delta' || payload.field === 'reasoning') push({ type: 'thinking', delta: payload.delta ?? '' });
      }
      if (event.type === 'tool.updated') {
        const id = payload.toolCallId; if (!id) return;
        if (payload.kind === 'result' || payload.kind === 'error' || payload.status === 'completed' || payload.status === 'failed') {
          const output = payload.result?.content ?? payload.output ?? payload.error ?? '';
          push({ type: 'tool_result', id, output: typeof output === 'string' ? output : JSON.stringify(output), isError: payload.kind === 'error' || payload.status === 'failed' || payload.result?.success === false });
        } else if (payload.kind !== 'progress' && payload.kind !== 'batch') push({ type: 'tool_use', id, name: payload.toolName ?? 'ZCode tool', input: payload.input ?? {} });
      }
      if (event.type === 'turn.completed') {
        if (typeof payload.response === 'string' && payload.response.startsWith(response) && payload.response.length > response.length) push({ type: 'text', delta: payload.response.slice(response.length) });
        if (payload.resultType && !['success', 'cancelled'].includes(payload.resultType)) push({ type: 'error', terminationReason: 'failed', message: `ZCode task ended: ${payload.resultType}` });
        else push({ type: 'done', sessionId, terminationReason: stopping || payload.resultType === 'cancelled' ? 'interrupted' : 'normal' });
      }
      if (event.type === 'turn.failed') push({ type: 'error', terminationReason: stopping ? 'interrupted' : 'failed', message: payload.error?.message ?? 'ZCode task failed' });
    });
    const task = (async () => {
      try {
        const mode = opts.accessMode === 'read-only' || opts.sandbox === 'read-only' ? 'plan' : opts.accessMode === 'workspace' || opts.sandbox === 'workspace-write' ? 'build' : 'yolo';
        const workspace = zcodeWorkspace(opts.cwd!);
        await client.request('workspace/updateProviderRegistry', { workspace,
          registry: await loadZcodeProviderRegistry(this.options), includeWorkspaceState: false });
        // A missing override means follow this conversation, not the first provider's default.
        const runtimeModel = !opts.sessionId || opts.model ? await loadZcodeRuntimeModel(this.options, opts.model) : undefined;
        const effort = resolveReasoningEffort(opts.reasoningEffort);
        const modelParams = runtimeModel ? { runtimeModel } : {};
        const snapshot = opts.sessionId
          ? await client.request('session/resume', { sessionId: opts.sessionId, workspace })
          : await client.request('session/create', { workspace, mode, titleGenerationEnabled: false, ...modelParams });
        sessionId = snapshot.session?.sessionId ?? snapshot.sessionId;
        if (!sessionId || (opts.sessionId && sessionId !== opts.sessionId)) throw new Error('ZCode returned a mismatched session');
        if (snapshot.session?.status === 'running' || snapshot.runtime?.isRunning) throw new Error('ZCode 会话正在运行，请在原入口完成后继续。');
        if ((snapshot.restoreWarning || snapshot.runtime?.lastError?.type === 'ZCODE_RUNTIME_MODEL_UNAVAILABLE' || snapshot.lastError?.type === 'ZCODE_RUNTIME_MODEL_UNAVAILABLE') && !opts.model) throw new Error('ZCode 原会话模型无法恢复，请在 /config 选择当前供应商下的模型；本次未执行，也未自动换用其他供应商。');
        if (opts.sessionId && runtimeModel) await client.request('session/setModel', { sessionId, model: runtimeModel.model, runtimeModel });
        const selected = runtimeModel?.model ?? snapshot.settings?.model?.current ?? snapshot.session?.model;
        push({ type: 'system', sessionId, cwd: opts.cwd, ...(selected?.providerId && selected?.modelId ? { model: `${selected.providerId}/${selected.modelId}` } : {}) });
        await client.request('session/setMode', { sessionId, mode });
        if (effort) {
          await client.request('session/setThoughtLevel', { sessionId, thoughtLevel: effort });
          if (runtimeModel) Object.assign(runtimeModel, { thoughtLevel: effort });
        }
        await client.request('session/subscribe', { sessionId, deliveryKind: 'web-remote-replayable' });
        if (stopping) { push({ type: 'done', sessionId, terminationReason: 'interrupted' }); return; }
        sent = true;
        // Attachment context and any FF JSON envelope are supplied by the caller.
        const result = await client.request('session/send', { sessionId, inputId, content: opts.prompt, ...modelParams });
        if (result.accepted !== true) throw new Error('ZCode did not acknowledge task acceptance');
        await finished;
      } catch (error) {
        push({ type: 'error', terminationReason: stopping ? 'interrupted' : 'failed', submissionStatus: sent ? 'unknown' : 'rejected',
          message: error instanceof Error ? error.message : String(error) });
      } finally { await client.close(); wake?.(); }
    })();
    void client.exited.then(() => { if (!ended) push({ type: 'error', terminationReason: 'failed', submissionStatus: sent ? 'unknown' : 'rejected', message: 'ZCode 连接已断开，任务状态未确认；未自动重发。' }); });
    return { runId: opts.runId,
      events: { async *[Symbol.asyncIterator]() { while (!ended || queue.length) { if (queue.length) yield queue.shift()!; else await new Promise<void>(resolve => { wake = resolve; }); } } },
      async stop() {
        stopping = true;
        if (sessionId && sent && !ended) {
          try {
            await client.request('session/stop', { sessionId });
            push({ type: 'done', sessionId, terminationReason: 'interrupted' });
          } catch {
            push({ type: 'error', terminationReason: 'failed', submissionStatus: 'unknown', message: 'ZCode 停止回执未确认；已关闭本次原生连接，未自动重发。' });
            await client.close();
          }
        }
      },
      async waitForExit(timeoutMs) { let timer: ReturnType<typeof setTimeout>; return Promise.race([task.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]).finally(() => clearTimeout(timer!)); },
    };
  }
}
