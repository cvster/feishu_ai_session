import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { checkAgentAvailability } from '../preflight';
import { resolveModelArg, resolveReasoningEffort } from '../models';
import { PiClient, piCommand, piSessionId, type PiOptions } from './client';
import { listPiModels } from './models';
import { PiSessionFiles } from './sessions';
import { piText } from './conversation';

export class PiAdapter implements AgentAdapter {
  readonly id = 'pi'; readonly displayName = 'Pi';
  constructor(readonly options: PiOptions = {}) {}
  checkAvailability() { const c = piCommand(this.options); return checkAgentAvailability({ agentId: this.id,
    agentName: this.displayName, command: c.binary, binaryPath: c.binary, args: [...c.args, '--version'] }); }
  async isAvailable() { return (await this.checkAvailability()).ok; }
  listModels(options: { cwd?: string } = {}) { return listPiModels(this.options, options.cwd); }
  run(opts: AgentRunOptions): AgentRun {
    const queue: AgentEvent[] = []; let wake: (() => void) | undefined;
    let ended = false, stopping = false, sent = false, client: PiClient | undefined, sessionId: string | undefined;
    let resolveSettled!: (event: any) => void, rejectSettled!: (error: Error) => void;
    const settled = new Promise<any>((yes, no) => { resolveSettled = yes; rejectSettled = no; }); void settled.catch(() => {});
    const push = (event: AgentEvent) => {
      if (ended) return; queue.push(event);
      if (event.type === 'done' || event.type === 'error') ended = true;
      wake?.();
    };
    let assistantText = '', assistantThinking = '', modelFailed = false;
    const receive = (event: any) => {
      if (!sent || ended) return;
      if (event.type === 'message_start' && event.message?.role === 'assistant') { assistantText = ''; assistantThinking = ''; }
      if (event.type === 'message_update') {
        const delta = event.assistantMessageEvent;
        if (delta?.type === 'text_delta' && typeof delta.delta === 'string') { assistantText += delta.delta; push({ type: 'text', delta: delta.delta }); }
        if (delta?.type === 'thinking_delta' && typeof delta.delta === 'string') { assistantThinking += delta.delta; push({ type: 'thinking', delta: delta.delta }); }
      }
      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const message = event.message, text = piText(message.content);
        if (text.startsWith(assistantText) && text.length > assistantText.length) push({ type: 'text', delta: text.slice(assistantText.length) });
        const thinking = Array.isArray(message.content) ? message.content.filter((b: any) => b.type === 'thinking').map((b: any) => b.thinking ?? '').join('') : '';
        if (thinking.startsWith(assistantThinking) && thinking.length > assistantThinking.length) push({ type: 'thinking', delta: thinking.slice(assistantThinking.length) });
        modelFailed = message.stopReason === 'error';
        if (message.usage) push({ type: 'usage', inputTokens: message.usage.input, outputTokens: message.usage.output,
          cachedInputTokens: message.usage.cacheRead, costUsd: message.usage.cost?.total });
      }
      if (event.type === 'tool_execution_start') push({ type: 'tool_use', id: event.toolCallId, name: event.toolName, input: event.args });
      if (event.type === 'tool_execution_end') push({ type: 'tool_result', id: event.toolCallId, output: piText(event.result?.content), isError: event.isError === true });
      if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(event.method)) {
        rejectSettled(Error('Pi 扩展请求交互，请在 Pi 原工具处理；本次未自动回答')); void client?.request('abort').catch(() => {});
      }
      // agent_end can be followed by automatic retries/compaction. Only settled is terminal.
      if (event.type === 'agent_settled') resolveSettled(event);
    };
    const task = (async () => {
      try {
        if (!opts.cwd) throw Error('Pi 需要项目目录');
        const access = opts.accessMode ?? (opts.sandbox === 'read-only' ? 'read-only' : opts.sandbox === 'workspace-write' ? 'workspace' : 'full');
        // Pi has no filesystem/process sandbox. Never silently widen a restricted request.
        if (access !== 'full') throw Error('Pi 不提供原生权限沙箱；本次受限权限请求未执行，请选择完整权限或使用支持沙箱的工具');
        const args: string[] = [];
        if (opts.sessionId) {
          const file = await new PiSessionFiles(this.options).find(opts.sessionId);
          if (resolve(file.header.cwd) !== resolve(opts.cwd)) throw Error('Pi 会话的项目目录不匹配');
          args.push('--session', file.path);
        } else args.push('--session-id', piSessionId(opts.initialSessionId ?? randomUUID()));
        if (opts.sessionName) args.push('--name', opts.sessionName);
        const model = resolveModelArg(this.id, opts.model);
        if (model) args.push('--model', model);
        const effort = resolveReasoningEffort(opts.reasoningEffort);
        if (effort) args.push('--thinking', effort);
        if (stopping) { push({ type: 'done', terminationReason: 'interrupted' }); return; }
        client = new PiClient(this.options, opts.cwd, args);
        client.onEvent(receive);
        void client.exited.then(() => rejectSettled(Error('Pi 原生进程已退出，执行状态未确认；未自动重发')));
        const state = await client.request('get_state');
        sessionId = piSessionId(state?.sessionId);
        if (sessionId !== (opts.sessionId ?? opts.initialSessionId ?? sessionId) || state.isStreaming || state.isCompacting) throw Error('Pi 会话身份或运行状态不匹配');
        const selected = state.model && `${state.model.provider}/${state.model.id}`;
        if (model && selected !== model) throw Error('Pi 已选模型不可用，请刷新模型列表；未自动更换供应商');
        if (effort) {
          const available = (await client.request('get_available_thinking_levels'))?.levels;
          if (!Array.isArray(available) || !available.includes(effort) || state.thinkingLevel !== effort) throw Error('Pi 已选推理档位不可用，请刷新设置');
        }
        const images: { type: 'image'; data: string; mimeType: string }[] = [];
        for (const path of opts.images ?? []) {
          const bytes = await readFile(path), ext = path.toLowerCase().split('.').at(-1);
          const mimeType = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[ext ?? ''];
          if (!mimeType || bytes.length > 25 * 1024 * 1024) throw Error('Pi 图片格式不支持或文件过大');
          images.push({ type: 'image', data: bytes.toString('base64'), mimeType });
        }
        push({ type: 'system', sessionId, cwd: opts.cwd, model: selected, reasoningEffort: state.thinkingLevel });
        if (stopping) { push({ type: 'done', sessionId, terminationReason: 'interrupted' }); return; }
        sent = true;
        const response = await client.request('prompt', { message: opts.prompt, ...(images.length ? { images } : {}) });
        if (response?.disposition !== 'started') throw Error('Pi 未启动本次请求（已处理或排队）；未自动重发');
        const terminal = await settled;
        if (stopping) { push({ type: 'done', sessionId, terminationReason: 'interrupted' }); return; }
        const entries = await client.request('get_entries');
        const user = Array.isArray(entries?.entries) ? [...entries.entries].reverse().find(e => e.type === 'message' && e.message?.role === 'user') : undefined;
        if (user?.id) push({ type: 'system', sessionId, turnId: user.id });
        if (modelFailed && !stopping) push({ type: 'error', message: 'Pi 模型请求失败，请在 Pi 检查模型及账号配置', terminationReason: 'failed' });
        else push({ type: 'done', sessionId, terminationReason: stopping || terminal.aborted ? 'interrupted' : 'normal' });
      } catch (error) {
        push({ type: 'error', message: error instanceof Error ? error.message : 'Pi 执行失败',
          terminationReason: stopping ? 'interrupted' : 'failed', submissionStatus: sent ? 'unknown' : 'rejected' });
      } finally { await client?.close(); wake?.(); }
    })();
    return { runId: opts.runId,
      events: { async *[Symbol.asyncIterator]() { while (!ended || queue.length) { if (queue.length) yield queue.shift()!; else await new Promise<void>(done => { wake = done; }); } } },
      async stop() {
        stopping = true;
        if (client && sent && !ended) {
          try { await client.request('abort', {}, 5000); }
          finally { resolveSettled({ aborted: true }); await client.close(); }
        }
      },
      async waitForExit(timeoutMs) {
        let timer: ReturnType<typeof setTimeout>;
        return Promise.race([task.then(() => true), new Promise<boolean>(done => { timer = setTimeout(() => done(false), timeoutMs); })]).finally(() => clearTimeout(timer!));
      },
    };
  }
}
