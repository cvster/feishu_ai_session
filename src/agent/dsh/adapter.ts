import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { resolveModelArg, resolveReasoningEffort } from '../models';
import { checkAgentAvailability } from '../preflight';
import { DshClient, dshCommand, dshSessionId, type DshOptions } from './client';
import { listDshModels, readDshModels, splitDshModel } from './models';

export function dshPermission(mode: AgentRunOptions['accessMode'] | AgentRunOptions['sandbox']): string {
  return mode === 'read-only' ? 'read-only' : mode === 'workspace' || mode === 'workspace-write' ? 'workspace-write' : 'danger-full-access';
}
const textOf = (content: any, type = 'text'): string => Array.isArray(content) ? content.filter(b => b.type === type).map(b => b.text ?? '').join('') : '';
export class DshAdapter implements AgentAdapter {
  readonly id = 'dsh'; readonly displayName = 'Dsh';
  constructor(readonly options: DshOptions = {}) {}
  checkAvailability() {
    const command = dshCommand(this.options);
    return checkAgentAvailability({ agentId: 'dsh', agentName: this.displayName, command: command.binary, binaryPath: command.binary, args: [...command.args, '--version'] });
  }
  async isAvailable() { return (await this.checkAvailability()).ok; }
  listModels(options: { cwd?: string } = {}) { return listDshModels(this.options, options.cwd); }
  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('DSH requires a project directory');
    const client = new DshClient(this.options, opts.cwd), requestId = `bridge-${randomUUID()}`;
    const queue: AgentEvent[] = []; let wake: (() => void) | undefined;
    let ended = false, stopping = false, sent = false, admitted = false, receipt = false, turnEnded = false;
    let sessionId: string | undefined, baseline = -1, lastSeq = -1, closeStream: (() => void) | undefined;
    let polling: ReturnType<typeof setInterval> | undefined, pollingNow = false;
    let finish!: () => void; const finished = new Promise<void>(done => { finish = done; });
    const push = (e: AgentEvent) => { if (ended) return; queue.push(e); if (e.type === 'done' || e.type === 'error') { ended = true; finish(); } wake?.(); };
    const fail = (message: string, unknown = sent) => push({ type: 'error', message, terminationReason: stopping ? 'interrupted' : 'failed', submissionStatus: unknown ? 'unknown' : 'rejected' });
    const streams = new Map<string, { next: number; text: string; thinking: string }>();
    let currentAttempt: string | undefined;
    const receive = (frame: any) => {
      if (ended) return;
      if (frame.type === 'snapshot') { baseline = frame.cursor; lastSeq = baseline; return; }
      if (!sent) return;
      if (frame.type === 'assistant-stream' && receipt) {
        const f = frame.frame;
        if (f.type === 'start') { currentAttempt = f.attemptId; streams.set(f.attemptId, { next: 0, text: '', thinking: '' }); }
        const state = streams.get(f.attemptId);
        if (state && f.type === 'chunk') {
          if (f.index < state.next) return;
          if (f.index !== state.next) { fail('DSH 流式事件缺失，执行状态未确认；未自动重发'); return; }
          state.next++;
          const c = f.chunk;
          if (c.type === 'text-delta' || c.type === 'reasoning-delta') {
            const field = c.type === 'text-delta' ? 'text' : 'thinking'; state[field] += c.text;
            push({ type: field, delta: c.text });
          }
        }
        return;
      }
      if (frame.type !== 'event' || !Number.isSafeInteger(frame.event?.seq) || frame.event.seq <= Math.max(baseline, lastSeq)) return;
      const e = frame.event, d = e.data; lastSeq = e.seq;
      if (e.type === 'agent/inbox/spliced' && d.inserted?.some((m: any) => m.source?.rpcId === requestId)) receipt = true;
      if (e.type === 'user/message' && d.source?.rpcId === requestId) { receipt = true; if (d.id) push({ type: 'system', sessionId, turnId: d.id }); }
      if (!receipt) return;
      if (e.type === 'assistant/message') {
        const state = currentAttempt ? streams.get(currentAttempt) : undefined;
        for (const [field, type] of [['text', 'text'], ['thinking', 'reasoning']] as const) {
          const full = textOf(d.message?.content, type), prior = state?.[field] ?? '';
          if (full.startsWith(prior) && full.length > prior.length) push({ type: field, delta: full.slice(prior.length) });
        }
        currentAttempt = undefined;
        if (d.usage) push({ type: 'usage', inputTokens: d.usage.inputTokens, outputTokens: d.usage.outputTokens,
          cachedInputTokens: d.usage.cacheReadTokens, reasoningOutputTokens: d.usage.reasoningTokens });
      }
      if (e.type === 'tool/call') {
        let input: unknown = d.arguments; try { input = JSON.parse(d.arguments); } catch {}
        push({ type: 'tool_use', id: d.callId, name: d.name, input });
      }
      if (e.type === 'tool/result') push({ type: 'tool_result', id: d.message.toolCallId, output: textOf(d.message.content), isError: d.message.isError === true });
      if (e.type === 'turn/end') {
        turnEnded = true;
        if (d.reason?.kind === 'error' || d.reason?.kind === 'blocked') {
          const code = d.reason.error?.code;
          fail(code === 'MISSING_CREDENTIAL' ? 'DSH 尚未配置此供应商的 API 凭据，请先在 DSH 配置模型账号。' : 'DSH 任务失败，请在原工具检查模型、账号或权限；未自动重发。', false);
        }
      }
    };
    const poll = async () => {
      if (ended || !admitted || !sessionId || pollingNow) return;
      pollingNow = true;
      try {
        const projection = await client.request('session/projections', { request: { sessionId } });
        const values = projection?.values;
        if (values?.userQuestions?.active?.length) {
          fail('DSH 请求原生交互问答，飞书转接尚未支持；本次未自动回答。', false);
          await client.request('session/cancel', { request: { sessionId } }); return;
        }
        if (receipt && turnEnded) {
          const list = await client.request('session/list', { _request: {} });
          const row = list.items?.find((r: any) => r.sessionId === sessionId);
          if (row && row.running === false) push({ type: 'done', sessionId, terminationReason: stopping ? 'interrupted' : 'normal' });
        }
      } catch { fail('DSH 状态读取失败，执行状态未确认；未自动重发。'); }
      finally { pollingNow = false; }
    };
    const task = (async () => {
      try {
        const { rows, archived } = await client.roster();
        const existing = opts.sessionId ? rows.find(r => r.sessionId === opts.sessionId) : undefined;
        if (opts.sessionId && (!existing || archived.has(opts.sessionId) || existing.running || resolve(existing.cwd) !== resolve(opts.cwd!)))
          throw new Error('DSH 会话不存在、已归档、正在运行或工作目录不匹配');
        const catalog = await readDshModels(client);
        const saved = existing?.projections?.values?.modelSelection?.next;
        const explicit = resolveModelArg('dsh', opts.model);
        const model = explicit ?? (saved?.provider && saved.model ? `${saved.provider}/${saved.model}` : catalog.selected);
        const option = catalog.options.find(o => o.value === model);
        if (!option) throw new Error('DSH 已选模型不可用，请刷新 /config；未自动更换供应商');
        const effort = resolveReasoningEffort(opts.reasoningEffort) ?? (!explicit ? saved?.reasoningEffort : undefined);
        if (effort && !option.reasoningEfforts?.some(e => e.value === effort)) throw new Error('DSH 已选推理档位已不可用，请刷新 /config');
        if (stopping) { push({ type: 'done', terminationReason: 'interrupted' }); return; }
        sessionId = opts.sessionId ?? dshSessionId((await client.request('session/create', { request: { cwd: opts.cwd,
          ...(opts.initialSessionId ? { sessionId: dshSessionId(opts.initialSessionId) } : {}) } })).sessionId);
        if (!opts.sessionId && opts.sessionName) await client.request('session/rename', { request: { sessionId, title: opts.sessionName } });
        if (explicit || effort || !saved) await client.request('session/selectModel', { request: { sessionId, ...splitDshModel(model), ...(effort ? { reasoningEffort: effort } : {}) } });
        const preset = dshPermission(opts.accessMode ?? opts.sandbox);
        const permission = await client.request('commands/execute', { agentId: sessionId, line: `/permission ${preset}`, submittedAttachments: [] });
        if (!permission || permission.result?.kind === 'error') throw new Error('DSH 无法设置本次原生权限，未提交任务');
        const configured = await client.request('session/projections', { request: { sessionId } });
        if (configured?.values?.permissions?.currentValue !== preset) throw new Error('DSH 原生权限回读不匹配，未提交任务');
        push({ type: 'system', sessionId, cwd: opts.cwd, model, ...(effort ? { reasoningEffort: effort } : {}) });
        closeStream = await client.subscribe('session/follow', { request: { address: { kind: 'session', sessionId }, assistantStream: true, maxMessages: 10 } }, receive,
          () => fail('DSH 事件连接断开，执行状态未确认；未自动重发。'));
        if (stopping) { push({ type: 'done', sessionId, terminationReason: 'interrupted' }); return; }
        sent = true;
        const answer = await client.request('session/prompt', { request: { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: opts.prompt }] } });
        if (answer?.accepted !== true) throw new Error('DSH 未确认消息接收；未自动重发');
        admitted = true; polling = setInterval(() => void poll(), 750);
        await finished;
      } catch (error) { fail(error instanceof Error ? error.message : 'DSH 执行失败', sent); }
      finally { if (polling) clearInterval(polling); closeStream?.(); await client.close(); wake?.(); }
    })();
    void client.exited.then(() => { if (!ended) fail('DSH 原生服务已退出，执行状态未确认；未自动重发。'); });
    return { runId: opts.runId,
      events: { async *[Symbol.asyncIterator]() { while (!ended || queue.length) { if (queue.length) yield queue.shift()!; else await new Promise<void>(done => { wake = done; }); } } },
      async stop() {
        stopping = true;
        if (sessionId && sent && !ended) {
          try { await client.request('session/cancel', { request: { sessionId } }); push({ type: 'done', sessionId, terminationReason: 'interrupted' }); }
          catch { fail('DSH 停止回执未确认；已关闭本次独立服务，未自动重发。'); await client.close(); }
        }
      },
      async waitForExit(timeoutMs) {
        let timer: ReturnType<typeof setTimeout>;
        return Promise.race([task.then(() => true), new Promise<boolean>(done => { timer = setTimeout(() => done(false), timeoutMs); })]).finally(() => clearTimeout(timer!));
      },
    };
  }
}
