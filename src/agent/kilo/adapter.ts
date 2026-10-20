import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { resolveReasoningEffort } from '../models';
import { checkAgentAvailability } from '../preflight';
import { KiloClient, KiloHttpError, kiloCommand, kiloSessionId, type KiloOptions } from './client';
import { listKiloModels, readKiloModels, splitKiloModel } from './models';

export function kiloPermissions(mode: AgentRunOptions['accessMode'] | AgentRunOptions['sandbox']) {
  const rule = (permission: string, action: 'allow' | 'ask' | 'deny') => ({ permission, pattern: '*', action });
  if (mode === 'read-only') return [rule('*', 'deny'), ...['read', 'glob', 'grep', 'list', 'external_directory'].map(name => rule(name, 'allow'))];
  if (mode === 'workspace' || mode === 'workspace-write') return [rule('*', 'ask'), ...['read', 'glob', 'grep', 'list', 'edit'].map(name => rule(name, 'allow')), rule('external_directory', 'deny')];
  return [rule('*', 'allow')];
}
export class KiloAdapter implements AgentAdapter {
  readonly id = 'kilo'; readonly displayName = 'Kilo';
  constructor(readonly options: KiloOptions = {}) {}
  checkAvailability() {
    const command = kiloCommand(this.options);
    return checkAgentAvailability({ agentId: 'kilo', agentName: 'Kilo', command: command.binary, binaryPath: command.binary, args: [...command.args, '--version'] });
  }
  async isAvailable() { return (await this.checkAvailability()).ok; }
  listModels(options: { cwd?: string } = {}) { return listKiloModels(this.options, options.cwd); }
  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('Kilo requires a project directory');
    const client = new KiloClient(this.options, opts.cwd, opts.sessionId);
    const inputId = `msg_${Date.now().toString(16)}${randomBytes(12).toString('hex')}`;
    const queue: AgentEvent[] = []; let wake: (() => void) | undefined;
    let ended = false, stopping = false, sent = false, sessionId: string | undefined;
    let finish!: () => void; const finished = new Promise<void>(resolve => { finish = resolve; });
    const push = (event: AgentEvent) => {
      if (ended) return; queue.push(event);
      if (event.type === 'done' || event.type === 'error') { ended = true; finish(); }
      wake?.();
    };
    const assistantIds = new Set<string>(), eventIds = new Set<string>(), usages = new Set<string>();
    const parts = new Map<string, { type: string; text: string; toolStatus?: string }>();
    let chain = Promise.resolve();
    const fail = (message: string, unknown = sent) => push({ type: 'error', terminationReason: stopping ? 'interrupted' : 'failed',
      submissionStatus: unknown ? 'unknown' : 'rejected', message });
    const part = (value: any) => {
      if (!assistantIds.has(value.messageID)) return;
      const previous = parts.get(value.id), text = typeof value.text === 'string' ? value.text : '';
      if (value.type === 'text' || value.type === 'reasoning') {
        if (text.startsWith(previous?.text ?? '') && text.length > (previous?.text.length ?? 0)) {
          push({ type: value.type === 'text' ? 'text' : 'thinking', delta: text.slice(previous?.text.length ?? 0) });
        }
        if (text.length >= (previous?.text.length ?? 0)) parts.set(value.id, { type: value.type, text });
      }
      if (value.type === 'tool' && value.state) {
        const status = value.state.status;
        if (status === 'pending') return;
        if (!previous?.toolStatus) push({ type: 'tool_use', id: value.callID, name: value.tool, input: value.state.input ?? {} });
        if (status !== previous?.toolStatus && ['completed', 'error'].includes(status)) push({ type: 'tool_result', id: value.callID,
          output: value.state.output ?? value.state.error ?? '', isError: status === 'error' });
        parts.set(value.id, { type: 'tool', text: '', toolStatus: status });
      }
    };
    const message = (info: any) => {
      if (info.role !== 'assistant' || info.parentID !== inputId) return;
      assistantIds.add(info.id);
      if (info.error) { fail('Kilo 模型执行失败，请在原工具检查账号、模型或上下文；本次未自动重发。', false); return; }
      if (info.modelID && info.providerID) push({ type: 'system', sessionId, model: `${info.providerID}/${info.modelID}`, ...(info.variant ? { reasoningEffort: info.variant } : {}) });
      if (info.time?.completed && !usages.has(info.id)) {
        usages.add(info.id); push({ type: 'usage', inputTokens: info.tokens?.input, outputTokens: info.tokens?.output,
          cachedInputTokens: info.tokens?.cache?.read, reasoningOutputTokens: info.tokens?.reasoning, costUsd: info.cost });
      }
    };
    const complete = async (reason?: string) => {
      if (!sessionId || ended) return;
      // Fill any missing stream suffix from the authoritative messages, scoped to this input.
      const rows = await client.request('GET', `/session/${sessionId}/message`, undefined, opts.cwd);
      if (!Array.isArray(rows)) throw new Error('Kilo 返回了无效的消息记录');
      for (const row of rows) { message(row.info); if (assistantIds.has(row.info?.id)) for (const p of row.parts ?? []) part(p); }
      if (!ended && (assistantIds.size || stopping)) push({ type: 'done', sessionId, terminationReason: stopping || reason === 'interrupted' ? 'interrupted' : 'normal' });
      else if (!ended) fail('Kilo 未返回与本次输入匹配的结果，未自动重发。');
    };
    const event = async (event: any) => {
      if (ended || !sent) return;
      if (event.id && eventIds.has(event.id)) return;
      if (event.id) eventIds.add(event.id);
      const p = event.properties ?? {};
      if (p.sessionID !== sessionId && p.info?.sessionID !== sessionId && p.part?.sessionID !== sessionId) return;
      if (event.type === 'message.updated') message(p.info);
      if (event.type === 'message.part.updated') part(p.part);
      if (event.type === 'message.part.delta' && assistantIds.has(p.messageID)) {
        const previous = parts.get(p.partID);
        if (previous && p.field === 'text') part({ id: p.partID, messageID: p.messageID, type: previous.type, text: previous.text + (p.delta ?? '') });
      }
      if (event.type === 'permission.asked' || event.type === 'question.asked') {
        fail('Kilo 请求原生权限确认或交互问答，飞书转接尚未支持；本次未自动同意。', false);
        await client.request('POST', `/session/${sessionId}/abort?scope=session`, undefined, opts.cwd);
      }
      if (event.type === 'session.error') fail('Kilo 任务失败，请在原工具检查；未自动重发。', false);
      if (event.type === 'session.idle' || (event.type === 'session.turn.close' && p.reason !== 'superseded')) await complete(p.reason);
    };
    const task = (async () => {
      try {
        let info = opts.sessionId ? await client.request('GET', `/session/${kiloSessionId(opts.sessionId)}`, undefined, opts.cwd) : undefined;
        if (info && (info.id !== opts.sessionId || resolve(info.directory) !== resolve(opts.cwd!))) throw new Error('Kilo 原会话或工作目录不匹配');
        if (info?.time?.archived) throw new Error('Kilo 会话已归档');
        if (info) {
          const statuses = await client.request('GET', '/session/status', undefined, opts.cwd);
          if (statuses[info.id] && statuses[info.id].type !== 'idle') throw new Error('Kilo 会话正在运行，请先在原入口停止');
        }
        const { options, selected, variant: defaultVariant } = await readKiloModels(client, opts.cwd);
        let model = opts.model ?? (info?.model?.providerID && info.model.id ? `${info.model.providerID}/${info.model.id}` : undefined);
        // Legacy sessions may store their choice only in the last user message.
        let savedVariant = info?.model?.variant;
        if (info && !model) {
          const history = await client.request('GET', `/session/${info.id}/message`, undefined, opts.cwd);
          const last = [...history].reverse().find(row => row.info?.role === 'user');
          if (last?.info?.model) { model = `${last.info.model.providerID}/${last.info.model.modelID}`; savedVariant = last.info.model.variant; }
        }
        model ??= selected;
        const option = model ? options.find(row => row.value === model) : undefined;
        if (model && !option) throw new Error('Kilo 原会话或已选模型不可用，请在 /config 重新选择；未自动更换供应商');
        const requestedEffort = resolveReasoningEffort(opts.reasoningEffort);
        const inheritedEffort = resolveReasoningEffort(opts.model ? undefined : savedVariant ?? (!opts.sessionId ? defaultVariant : undefined));
        // Native implicit defaults are not necessarily selectable variants; let Kilo retain them.
        const effort = requestedEffort ?? (option?.reasoningEfforts?.some(row => row.value === inheritedEffort) ? inheritedEffort : undefined);
        if (requestedEffort && !option?.reasoningEfforts?.some(row => row.value === requestedEffort)) throw new Error('Kilo 已选模型的推理档位不可用，请刷新 /config');
        const permission = kiloPermissions(opts.accessMode ?? opts.sandbox);
        if (stopping) { push({ type: 'done', terminationReason: 'interrupted' }); return; }
        if (!info) {
          const metadata = await client.sessionCreationMetadata();
          info = await client.request('POST', '/session', { title: opts.sessionName ?? '飞书会话', permission, ...(metadata ? { metadata } : {}) }, opts.cwd);
        }
        sessionId = kiloSessionId(info.id);
        if (opts.sessionId && sessionId !== opts.sessionId) throw new Error('Kilo 返回了不匹配的会话');
        if (opts.sessionId) await client.request('PATCH', `/session/${sessionId}`, { permission }, opts.cwd);
        push({ type: 'system', sessionId, cwd: opts.cwd, ...(model ? { model } : {}), ...(effort ? { reasoningEffort: effort } : {}) });
        await client.subscribe(opts.cwd!, e => { chain = chain.then(() => event(e)).catch(() => fail('Kilo 事件处理失败，未自动重发。')); },
          () => fail('Kilo 事件连接已断开，执行状态未确认；未自动重发。'));
        if (stopping) { push({ type: 'done', sessionId, terminationReason: 'interrupted' }); return; }
        sent = true;
        await client.request('POST', `/session/${sessionId}/prompt_async`, { messageID: inputId,
          parts: [{ type: 'text', text: opts.prompt }], ...(model ? { model: splitKiloModel(model) } : {}), ...(effort ? { variant: effort } : {}),
        }, opts.cwd);
        await finished; await chain;
      } catch (error) { fail(error instanceof Error ? error.message : 'Kilo 执行失败', error instanceof KiloHttpError && error.status < 500 ? false : sent); }
      finally { await client.close(); wake?.(); }
    })();
    void client.exited.then(() => { if (!ended) fail('Kilo 服务已退出，执行状态未确认；未自动重发。'); });
    return { runId: opts.runId,
      events: { async *[Symbol.asyncIterator]() { while (!ended || queue.length) { if (queue.length) yield queue.shift()!; else await new Promise<void>(resolve => { wake = resolve; }); } } },
      async stop() {
        stopping = true;
        if (sessionId && sent && !ended) {
          try {
            await client.request('POST', `/session/${sessionId}/abort?scope=session`, undefined, opts.cwd);
            if (!ended) push({ type: 'done', sessionId, terminationReason: 'interrupted' });
          } catch { fail('Kilo 停止回执未确认，已关闭本次连接；未自动重发。'); await client.close(); }
        }
      },
      async waitForExit(timeoutMs) { let timer: ReturnType<typeof setTimeout>; return Promise.race([task.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })]).finally(() => clearTimeout(timer!)); },
    };
  }
}
