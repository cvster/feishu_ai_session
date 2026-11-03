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
  /** Last seen session entry id per native session, used as an incremental read cursor. */
  private readonly leafCursors = new Map<string, string>();
  private rememberCursor(sessionId: string, leafId: string) {
    this.leafCursors.delete(sessionId); this.leafCursors.set(sessionId, leafId);
    while (this.leafCursors.size > 256) this.leafCursors.delete(this.leafCursors.keys().next().value as string);
  }
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
    const entriesSnapshot = async (since?: string): Promise<{ entries: any[]; leafId?: string } | undefined> => {
      try {
        const data = await client?.request('get_entries', since ? { since } : {});
        return Array.isArray(data?.entries) ? data : undefined;
      } catch { return undefined; }
    };
    // Pi stores exactly the prompt it accepted, but may also expand slash commands or
    // skills. Only an exact or long-enough containment counts; short text never does.
    const sameInput = (text: string | undefined) => {
      if (!text) return false;
      if (text === opts.prompt) return true;
      return Math.min(text.length, opts.prompt.length) >= 32
        && (text.includes(opts.prompt) || opts.prompt.includes(text));
    };
    let submittedAt = 0;
    /**
     * Entry id of the prompt this run submitted, or undefined when it cannot be proven.
     * The settle pass may fall back to the first entry written after submission (Pi can
     * rewrite a slash command or a skill); an in-flight answer never guesses.
     *
     * A run that is stopped before the entry is readable keeps no turn id: the client is
     * already closed by then, and the Web shows that turn as an unlinked native one.
     */
    const submittedTurnId = async (settle: boolean): Promise<string | undefined> => {
      const sid = sessionId;
      if (!sid) return undefined;
      const readOnce = async (since?: string) => {
        const data = await entriesSnapshot(since);
        if (!data) return undefined;
        const users = data.entries.filter((entry: any) => entry?.type === 'message'
          && entry.message?.role === 'user');
        const stampedAt = (entry: any) => Date.parse(entry?.timestamp);
        // Pi runs on this host, so an entry of this run is always stamped after the submit.
        const fresh = users.filter((entry: any) => { const at = stampedAt(entry); return Number.isFinite(at) && at >= submittedAt; });
        // An unreadable timestamp cannot prove freshness: it may confirm a text match, never
        // stand in for freshness on its own, so the positional fallback below ignores it.
        const unreadable = settle ? users.filter((entry: any) => !Number.isFinite(stampedAt(entry))) : [];
        const usable = new Set<any>([...fresh, ...unreadable]);
        const matched = users.filter((entry: any) => usable.has(entry) && sameInput(piText(entry.message?.content)));
        return { fresh, matched, leafId: data.leafId };
      };
      let since = this.leafCursors.get(sid);
      let read = await readOnce(since);
      // A rewritten session either fails the cursor read or answers with nothing at all.
      // Only the settle pass may pay for a second, full read.
      if (settle && since && !read?.fresh.length) {
        this.leafCursors.delete(sid);
        since = undefined;
        read = await readOnce();
      }
      if (!read) {
        // Never guess from a partial view: drop the cursor so the next pass reads fully.
        if (since) this.leafCursors.delete(sid);
        return undefined;
      }
      // Several matches mean Pi wrote the prompt more than once, so an in-flight answer
      // must stay silent; the settle pass takes the newest, which is the one just written.
      if (!settle && read.matched.length !== 1) return undefined;
      const chosen = read.matched.at(-1) ?? (settle ? read.fresh[0] : undefined);
      if (!chosen) return undefined;
      if (typeof read.leafId === 'string') this.rememberCursor(sid, read.leafId);
      return chosen.id as string | undefined;
    };
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
        submittedAt = Date.now();
        const response = await client.request('prompt', { message: opts.prompt, ...(images.length ? { images } : {}) });
        if (response?.disposition !== 'started') throw Error('Pi 未启动本次请求（已处理或排队）；未自动重发');
        // Publish the session entry id of this prompt as early as possible: it is the
        // only durable native turn id, and the Web needs it while the run is active
        // to collapse the bridge job and the native turn into one message.
        let turnId = await submittedTurnId(false);
        if (turnId) push({ type: 'system', sessionId, turnId });
        const terminal = await settled;
        if (stopping) { push({ type: 'done', sessionId, terminationReason: 'interrupted' }); return; }
        if (!turnId) { turnId = await submittedTurnId(true); if (turnId) push({ type: 'system', sessionId, turnId }); }
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
