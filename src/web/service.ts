import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { normalize } from 'node:path';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { QueuedMessage } from '../bot/message-queue';
import type { Controls } from '../commands';
import type { SessionCatalog } from '../session/catalog';
import { DurableAgentAdapter } from '../worker/adapter';
import type { WorkerCapabilities } from '../worker/protocol';
import type { ToolSession } from '../tools/types';
import { sessionOperations } from '../tools/session-api';
import { log } from '../core/logger';
import { initialState, reduce, type RunState } from '../card/run-state';
import { writeFileAtomic } from '../platform/atomic-write';
import type { WebControlResult } from './controls';
import { runProgress } from '../card/run-progress';
import { WebMarkdown, type WebAnswerSection } from './markdown';
import { renameChat } from '../bot/group';
import { sharedPersonalScope, sharedJobPersonalScope, namedSharedMessages, feishuSenderName } from '../worker/shared-history';
import { isPersonalWorkgroup, type ToolBinding } from '../tools/bindings';

export class WebError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export interface WebSession {
  id: string; scope: string; toolId: string; tool: string; project: string; cwd: string; name: string;
  updatedAtMs: number; favorite: boolean; online: boolean; canSend: boolean; canRename: boolean; nativeConversation: boolean;
}
export interface WebTurn { id: string; input: string; inputMessages?: { senderName: string; text: string }[]; answer: string; answerSections?: WebAnswerSection[]; requestIds?: string[]; progress?: string[]; status: string; createdAtMs: number; origin: 'bridge' | 'native' }
export interface WebConversation { session: WebSession; turns: WebTurn[]; queuedMessages?: QueuedMessage[]; confirmedRequestIds?: string[]; notice?: string }
interface Receipt { fingerprint: string; sessionId: string; owner: string; createdAt: number; messageId?: string; enqueued?: boolean }
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const answer = (s: RunState) => s.blocks.flatMap(b => b.kind === 'text' ? [b.content] : []).join('\n\n');

/** Personal bindings, queue and native worker snapshots are the only sources of truth. */
export class PersonalSessionService {
  private markdown = new WebMarkdown();
  private receipts: Record<string, Receipt> = {};
  private favorites: Record<string, string> = {};
  private operations = new Map<string, Promise<unknown>>();
  private metadata = new Map<string, { label: string; sourceId: string; rows: ToolSession[]; capabilities?: WorkerCapabilities; online: boolean; listed: boolean }>();
  private listedAt = 0;
  private conversations = new Map<string, WebConversation>();
  private groups = new Map<string, { mode: string; name?: string; bindingName?: string }>();
  private listing?: Promise<void>;
  private jobs = new Map<string, { cursor: number; state: RunState; turnId?: string; nativeId?: string; updatedAt?: number }>();
  constructor(private readonly deps: {
    controls: Controls; catalog?: SessionCatalog; channel: LarkChannel; path: string;
    enqueue(msg: NormalizedMessage): Promise<void>;
    control?(id: string, scope: string, owner: string, action: string, values?: unknown): Promise<WebControlResult>;
    create?(owner: string, toolId: string, cwd: string, name: string): Promise<{ scope?: string } & WebControlResult>;
    cwdFor?(scope: string): string | undefined;
  }) {}
  async load() {
    try {
      const r = JSON.parse(await readFile(this.deps.path, 'utf8'));
      if (r.version !== 1 || !r.receipts || Array.isArray(r.receipts)) throw new Error('网页请求账本无效');
      this.receipts = r.receipts;
      if (r.favorites !== undefined) {
        if (!r.favorites || typeof r.favorites !== 'object' || Array.isArray(r.favorites) || Object.entries(r.favorites).some(([id, owner]) => !/^[a-f0-9]{64}$/.test(id) || typeof owner !== 'string' || !owner)) throw new Error('网页收藏记录无效');
        this.favorites = r.favorites;
      }
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  private owner() {
    const c = this.deps.controls;
    if (c.ownerRefreshState !== 'ok' || !c.botOwnerId) throw new WebError(503, '暂时无法确认当前所有者，请稍后重试');
    return c.botOwnerId;
  }
  ownerIdentity(): string { return this.owner(); }
  private identity(scope: string, b: { toolId: string; sourceId: string; nativeId?: string }) {
    return hash(JSON.stringify([this.deps.controls.profile, this.deps.controls.profileConfig.accounts.app.id, scope, b.toolId, b.sourceId, b.nativeId]));
  }
  private receiptScopes(scope: string): string[] {
    return [scope, ...(this.deps.controls.toolBindings?.entries() ?? []).flatMap(([source]) =>
      sharedPersonalScope(this.deps.controls, this.deps.catalog, source) === scope ? [source] : [])];
  }
  /**
   * Active personal routes plus fresh groups whose native session is created by
   * their first message, so a group created here can be used before that.
   */
  private bindings(): [string, ToolBinding][] {
    const tools = this.deps.controls.toolBindings, active = tools?.activePersonalBindings() ?? [];
    const scopes = new Set(active.map(([scope]) => scope));
    return [...active, ...(tools?.entries() ?? []).filter(([scope, b]) => !scopes.has(scope) && b.nativeCreated === false &&
      isPersonalWorkgroup(scope, b) && !this.deps.catalog?.isScopeArchived(scope))];
  }
  private async refresh(force = false) {
    if (this.listing) return this.listing;
    if (!force && Date.now() - this.listedAt < 15_000) return;
    this.listing = (async () => {
      const tools = this.deps.controls.toolRegistry?.all() ?? [];
      const present = new Set<string>(tools.map(t => t.id));
      for (const [id, m] of this.metadata) if (!present.has(id)) m.online = false;
      await Promise.all(tools.map(async tool => {
        const previous = this.metadata.get(tool.id);
        try {
          if (!(tool.agent instanceof DurableAgentAdapter)) throw new Error('Worker required');
          const health = await tool.agent.client.health();
          const rows = health.capabilities?.sessions.list ? await tool.listSessions() : [];
          this.metadata.set(tool.id, { label: tool.label, sourceId: tool.sourceId, rows, capabilities: health.capabilities, online: true, listed: health.capabilities?.sessions.list === true });
        } catch { this.metadata.set(tool.id, { label: tool.label, sourceId: tool.sourceId, rows: previous?.sourceId === tool.sourceId ? previous.rows : [], capabilities: previous?.capabilities, online: false, listed: previous?.sourceId === tool.sourceId && previous.listed === true }); }
      }));
      const bindings = this.bindings();
      const scopes = new Set(bindings.map(([scope]) => scope));
      for (const scope of this.groups.keys()) if (!scopes.has(scope)) this.groups.delete(scope);
      await Promise.all(bindings.map(async ([scope, binding]) => {
        try {
          // Read mode and the actual group title in one request, independently
          // of worker name synchronization and old binding labels.
          const result = await this.deps.channel.rawClient.im.v1.chat.get({ path: { chat_id: scope } });
          const data = result.data;
          if (result.code || !data || !['group', 'topic', 'p2p'].includes(data.chat_mode ?? '')) throw new Error('群信息未确认');
          this.groups.set(scope, { mode: data.chat_mode!, name: data.name?.trim() || undefined, bindingName: binding.name });
        } catch { this.groups.set(scope, { ...this.groups.get(scope), mode: 'unavailable', bindingName: binding.name }); }
      }));
      this.listedAt = Date.now();
    })().finally(() => { this.listing = undefined; });
    return this.listing;
  }
  async list(): Promise<WebSession[]> {
    this.owner(); await this.refresh(); const owner = this.owner();
    return this.bindings().flatMap(([scope, b]) => {
      if (this.deps.controls.auxiliary?.isAuxiliary(scope) || ['topic', 'p2p'].includes(this.groups.get(scope)?.mode ?? '')) return [];
      // A not-yet-started session is only shown while its group is confirmed.
      if (b.nativeCreated === false && this.groups.get(scope)?.mode !== 'group') return [];
      const meta = this.metadata.get(b.toolId), tool = this.deps.controls.toolRegistry?.find(b.toolId);
      const row = meta?.sourceId === b.sourceId ? meta.rows.find(r => r.nativeId === b.nativeId) : undefined;
      if (row?.archived || (meta?.sourceId === b.sourceId && meta.listed && meta.capabilities?.sessionListAuthoritative && b.nativeCreated !== false && b.nativeId && !row)) return [];
      const catalog = this.deps.catalog?.entries().filter(r => r.scopeId === scope && r.status === 'active' && r.agentId === b.toolId &&
        (!r.sourceId || r.sourceId === b.sourceId) && (!r.botAppId || r.botAppId === this.deps.controls.profileConfig.accounts.app.id) &&
        (r.threadId ?? r.sessionId) === b.nativeId).sort((a, z) => z.updatedAt - a.updatedAt)[0];
      // Project ownership is stable even when the tool changes cwd while executing.
      const cwd = normalize(this.deps.cwdFor?.(scope) ?? catalog?.cwdRealpath ?? row?.cwd ?? '.');
      const online = this.groups.get(scope)?.mode === 'group' && meta?.online === true && !!tool && tool.sourceId === b.sourceId && (!!row || b.nativeCreated === false);
      const group = this.groups.get(scope);
      // A confirmed name sync may be newer than our 15-second group snapshot.
      const name = group?.bindingName !== b.name ? b.name : group?.name ?? b.name;
      // Use native activity rather than the catalog's periodically refreshed timestamp.
      // Pending bridge input should also appear immediately, before the worker lists it.
      const activity = [row?.updatedAtMs ?? catalog?.boundAt ?? catalog?.updatedAt ?? 0,
        ...this.receiptScopes(scope).flatMap(source => this.deps.controls.workerRuntimes?.get(b.toolId)?.inbox.receipts(source) ?? [])
          .map(r => Number(r.message.createTime)).filter(t => t >= (catalog?.boundAt ?? 0))];
      const updatedAtMs = Math.max(0, ...activity.filter(t => Number.isFinite(t) && t >= 0));
      return [{ id: this.identity(scope, b), scope, toolId: b.toolId, tool: meta?.label ?? b.toolId,
        updatedAtMs,
        favorite: this.favorites[hash(JSON.stringify([owner, this.identity(scope, b)]))] === owner, cwd, project: cwd.split(/[/\\]/).filter(Boolean).pop() ?? cwd, name: name ?? row?.name ?? b.nativeId!, online,
        canSend: online && meta?.capabilities?.jobs.submit === true,
        canRename: this.groups.get(scope)?.mode === 'group',
        nativeConversation: meta?.capabilities?.conversation === true }];
    });
  }
  private async resolve(id: string, write = false) {
    this.owner(); if (write) await this.refresh(true);
    const session = (await this.list()).find(s => s.id === id);
    if (!session) throw new WebError(404, '会话已归档、群已失效或绑定已变化');
    const b = this.deps.controls.toolBindings!.get(session.scope)!;
    const tool = this.deps.controls.toolRegistry?.find(b.toolId);
    if (write && (!session.online || !(tool?.agent instanceof DurableAgentAdapter))) throw new WebError(503, 'Worker 离线或会话不可用');
    return { session, b, client: tool?.sourceId === b.sourceId && tool.agent instanceof DurableAgentAdapter ? tool.agent.client : undefined };
  }
  private assertBinding(id: string, scope: string) {
    this.owner();
    const b = this.bindings().find(([s, b]) => s === scope && this.identity(s, b) === id);
    if (!b || this.deps.controls.auxiliary?.isAuxiliary(scope)) throw new WebError(409, '会话绑定已变化，未继续提交');
  }
  private serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const task = (this.operations.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    this.operations.set(key, task); void task.finally(() => { if (this.operations.get(key) === task) this.operations.delete(key); }).catch(() => {});
    return task;
  }
  private save() { return this.serial('ledger', () => writeFileAtomic(this.deps.path, JSON.stringify({ version: 1, receipts: this.receipts, favorites: this.favorites }) + '\n', { mode: 0o600 })); }
  async favorite(id: string, favorite: boolean) {
    if (typeof favorite !== 'boolean') throw new WebError(400, '收藏状态需为布尔值');
    return this.serial('favorite:' + id, async () => {
      const owner = this.owner();
      const { session } = await this.resolve(id);
      this.assertBinding(id, session.scope);
      if (this.owner() !== owner) throw new WebError(409, '所有者已变化');
      const key = hash(JSON.stringify([owner, id])), previous = this.favorites[key];
      if (favorite) this.favorites[key] = owner;
      else delete this.favorites[key];
      try { await this.save(); } catch (error) { if (previous) this.favorites[key] = previous; else delete this.favorites[key]; throw error; }
      return { favorite };
    });
  }
  async send(id: string, requestId: string, text: string) {
    if (!/^[\w-]{16,120}$/.test(requestId) || !text.trim() || text.length > 16_000) throw new WebError(400, '需要唯一请求 ID 和 1–16000 字文本');
    return this.serial('send:' + requestId, async () => {
      const owner = this.owner(), fingerprint = hash(JSON.stringify([id, owner, text]));
      const old = this.receipts[requestId];
      if (old && old.fingerprint !== fingerprint) throw new WebError(409, '同一请求 ID 的内容或会话已变化');
      if (old?.enqueued) {
        const { session } = await this.resolve(id); this.assertBinding(id, session.scope);
        return { requestId, status: 'queued', queuedMessages: this.deps.controls.messageQueue?.list(session.scope) ?? [] };
      }
      const { session } = await this.resolve(id, true);
      if (!session.canSend) throw new WebError(503, '此会话不可发送');
      if (await this.deps.channel.getChatMode(session.scope) !== 'group') throw new WebError(409, '群已转为话题模式');
      const receipt = this.receipts[requestId] ??= { fingerprint, sessionId: id, owner, createdAt: Date.now() };
      if (receipt.enqueued) return { requestId, status: 'queued', queuedMessages: this.deps.controls.messageQueue?.list(session.scope) ?? [] };
      await this.save(); this.assertBinding(id, session.scope);
      if (!receipt.messageId) {
        if (Date.now() - receipt.createdAt > 55 * 60_000) throw new WebError(409, '发送结果未确认且已超过去重窗口，请检查群消息');
        const response = await this.deps.channel.rawClient.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: {
          receive_id: session.scope, msg_type: 'text', content: JSON.stringify({ text: `来自网页\n${text}` }), uuid: hash(fingerprint + requestId).slice(0, 48),
        } });
        if (response.code || !response.data?.message_id) throw new WebError(502, '群消息发送未确认；重试会复用请求 ID');
        receipt.messageId = response.data.message_id; await this.save();
      }
      this.assertBinding(id, session.scope);
      await this.deps.enqueue({ messageId: receipt.messageId, chatId: session.scope, chatType: 'group', senderId: owner,
        createTime: receipt.createdAt, content: text, resources: [], mentions: [], mentionAll: false, mentionedBot: true, rawContentType: 'text' });
      receipt.enqueued = true; await this.save();
      return { requestId, status: 'queued', queuedMessages: this.deps.controls.messageQueue?.list(session.scope) ?? [] };
    });
  }
  async removeQueuedMessage(id: string, messageId: string) {
    if (!/^[a-f0-9]{48}$/.test(messageId)) throw new WebError(400, '排队消息 ID 无效');
    const owner = this.owner(), { session } = await this.resolve(id);
    this.assertBinding(id, session.scope);
    if (this.owner() !== owner) throw new WebError(409, '所有者已变化');
    const queue = this.deps.controls.messageQueue;
    if (!queue || !await queue.remove(session.scope, messageId, owner))
      throw new WebError(409, '消息已开始处理或已移除，未停止当前任务');
    return { removed: true, queuedMessages: queue.list(session.scope) };
  }
  async rename(id: string, name: string) {
    name = name.trim(); if (!name || name.length > 100 || /[\u0000-\u001f]/.test(name)) throw new WebError(400, '名称需为 1–100 字');
    this.owner();
    const entry = this.bindings().find(([scope, b]) => this.identity(scope, b) === id);
    if (!entry) throw new WebError(404, '会话已归档、群已失效或绑定已变化');
    const [scope, binding] = entry;
    this.assertBinding(id, scope);
    const group = await this.deps.channel.rawClient.im.v1.chat.get({ path: { chat_id: scope } });
    if (group.code || !group.data) throw new WebError(503, '群状态未确认，暂不可改名');
    if (group.data.chat_mode !== 'group') throw new WebError(409, '仅支持个人 AI 会话群');
    this.assertBinding(id, scope);
    await renameChat(this.deps.channel, scope, name);
    this.assertBinding(id, scope);
    this.groups.set(scope, { mode: 'group', name, bindingName: this.deps.controls.toolBindings?.get(scope)?.name });
    const tool = this.deps.controls.toolRegistry?.find(binding.toolId);
    if (tool?.sourceId === binding.sourceId && binding.nativeId) {
      try { await sessionOperations(tool).rename(binding.nativeId, name); }
      catch (err) { log.warn('web', 'native-name-update-failed', { toolId: binding.toolId, err: err instanceof Error ? err.message : String(err) }); }
    }
    this.listedAt = 0; return { name };
  }
  /** Create a personal AI group in an existing project; its session starts with the first message. */
  async create(toolId: string, cwd: string, name: string) {
    name = name.trim(); if (name.length > 100 || /[\u0000-\u001f]/.test(name)) throw new WebError(400, '名称最多 100 字');
    if (!cwd.startsWith('/') || cwd.length > 4096) throw new WebError(400, '项目路径无效');
    const owner = this.owner();
    if (!this.deps.controls.toolRegistry?.find(toolId)) throw new WebError(404, '工具 worker 未发现');
    if (!this.deps.create) throw new WebError(503, '会话操作尚未就绪');
    return this.serial('create', async () => {
      const result = await this.deps.create!(owner, toolId, cwd, name);
      if (!result.scope) return { elements: result.elements };
      this.listedAt = 0;
      const session = (await this.list()).find(row => row.scope === result.scope);
      return { elements: result.elements, ...(session ? { session } : {}) };
    });
  }
  async control(id: string, action: string, values?: unknown) {
    return this.serial('control:' + id, async () => {
      const { session } = await this.resolve(id, true);
      this.assertBinding(id, session.scope);
      if (action === 'refresh') {
        return { conversation: await this.read(id), elements: [] };
      }
      if (!this.deps.control) throw new WebError(503, '会话操作尚未就绪');
      const result = await this.deps.control(id, session.scope, this.owner(), action, values);
      this.listedAt = 0; return result;
    });
  }
  async read(id: string): Promise<WebConversation> {
    const { session, b, client } = await this.resolve(id);
    const queuedMessages = this.deps.controls.messageQueue?.list(session.scope) ?? [];
    const owner = this.owner(), requests = new Map<string, string[]>(), confirmedRequestIds: string[] = [];
    // Messages sent before the first run created the native session were recorded under its pending identity.
    const ids = new Set([id, this.identity(session.scope, { ...b, nativeId: undefined })]);
    for (const [requestId, receipt] of Object.entries(this.receipts)) if (ids.has(receipt.sessionId) && receipt.owner === owner && receipt.messageId) {
      const ids = requests.get(receipt.messageId) ?? []; ids.push(requestId); requests.set(receipt.messageId, ids);
      if (receipt.enqueued) confirmedRequestIds.push(requestId);
    }
    const runtime = this.deps.controls.workerRuntimes?.get(b.toolId);
    const receipts = this.receiptScopes(session.scope).flatMap(scope => runtime?.inbox.receipts(scope) ?? []);
    const turns: WebTurn[] = receipts.filter(r => r.status === 'pending' || r.status === 'rejected' || r.status === 'cancelled').map(r => ({ id: 'receipt:' + r.message.messageId,
      input: r.message.content, answer: '', requestIds: requests.get(r.message.messageId), status: r.status === 'pending' ? 'queued' : r.status, createdAtMs: Number(r.message.createTime), origin: 'bridge' }));
    for (const turn of turns) {
      const receipt = receipts.find(r => 'receipt:' + r.message.messageId === turn.id)!;
      if (receipt.scope !== session.scope) turn.inputMessages = [{ senderName: await feishuSenderName(this.deps.channel, receipt.message), text: receipt.message.content }];
    }
    if (!session.online || !client) return { session, queuedMessages, confirmedRequestIds, turns: this.conversations.get(id)?.turns ?? turns, notice: 'Worker 离线；恢复后会重新读取会话' };
    try {
      const [native, allJobs] = await Promise.all([session.nativeConversation && b.nativeCreated !== false && b.nativeId ? client.conversation(b.nativeId) : undefined, client.list()]);
      this.assertBinding(id, session.scope);
      if ((native?.id !== undefined && native.id !== b.nativeId) || native?.archived) throw new WebError(404, '会话已归档或身份变化');
      const jobs = allJobs.filter(j => (j.options.delivery?.scope === session.scope || sharedJobPersonalScope(this.deps.controls, this.deps.catalog, j) === session.scope) &&
        j.options.delivery?.sourceId === b.sourceId && j.options.delivery.botAppId === this.deps.controls.profileConfig.accounts.app.id);
      const linkedTurns = new Set<string>(), matchedJobTimes: number[] = [];
      for (const job of jobs) {
        const cacheKey = b.sourceId + ':' + job.id;
        let view = this.jobs.get(cacheKey);
        if (!view) { view = { cursor: 0, state: structuredClone(initialState) }; this.jobs.set(cacheKey, view); }
        const snapshot = view.updatedAt !== job.updatedAt || ['running', 'accepted'].includes(job.status) ? await client.snapshot(job.id, view.cursor) : undefined;
        for (const row of snapshot?.events ?? []) {
          if (row.seq <= view.cursor) continue;
          view.cursor = row.seq; view.state = reduce(view.state, row.event);
          if (row.event.type === 'system') { if (row.event.turnId) view.turnId = row.event.turnId; if (row.event.threadId ?? row.event.sessionId) view.nativeId = row.event.threadId ?? row.event.sessionId; }
        }
        view.updatedAt = job.updatedAt;
        if ((job.options.threadId ?? job.options.sessionId ?? view.nativeId) !== b.nativeId) continue;
        matchedJobTimes.push(job.createdAt);
        if (view.turnId) linkedTurns.add(view.turnId);
        const shared = job.options.delivery!.scope !== session.scope;
        const inputs = shared ? (await namedSharedMessages(this.deps.controls, this.deps.channel, job)).map(message => ({ message })) :
          receipts.filter(r => r.scope === session.scope && job.options.delivery?.messageIds?.includes(r.message.messageId));
        const ids = new Set(inputs.map(r => 'receipt:' + r.message.messageId));
        for (let i = turns.length - 1; i >= 0; i--) if (ids.has(turns[i]!.id)) turns.splice(i, 1);
        // Job prompts contain bridge policy/context. Never return them to Web.
        if (!inputs.length) continue;
        const status = job.status === 'running' ? (view.state.footer === 'waiting_input' ? 'waiting_input' : 'running') : job.status;
        const nativeTurn = native?.turns.find(t => t.bridgeJobId === job.id || t.id === view!.turnId);
        if (nativeTurn) linkedTurns.add(nativeTurn.id);
        let state = shared ? view.state : nativeTurn?.state ?? view.state;
        if (shared && this.deps.controls.auxiliaryApprovals) state = await this.deps.controls.auxiliaryApprovals.review(job.options.delivery!.scope, job.id, job.options.delivery!.replyTo, state);
        if (shared && sharedJobPersonalScope(this.deps.controls, this.deps.catalog, job) !== session.scope) continue;
        turns.push({ id: 'job:' + job.id, input: inputs.map(r => r.message.content).join('\n\n'), answer: answer(state), status,
          ...(shared ? { inputMessages: inputs.map(r => ({ senderName: r.message.senderName!, text: r.message.content })) } : {}),
          answerSections: this.markdown.sections(state),
          requestIds: inputs.flatMap(r => requests.get(r.message.messageId) ?? []),
          progress: runProgress({ ...state, terminal: ['running', 'accepted'].includes(job.status) ? 'running' : 'done' }),
          createdAtMs: job.createdAt, origin: 'bridge' });
      }
      const historyBoundary = Math.min(...matchedJobTimes);
      for (const turn of native?.turns ?? []) if (!linkedTurns.has(turn.id) && (!turn.bridge || turn.createdAtMs < historyBoundary)) turns.push({
        id: 'native:' + turn.id, input: turn.bridge ? '' : turn.input, answer: answer(turn.state), status: turn.state.footer === 'waiting_input' ? 'waiting_input' : turn.state.terminal,
        answerSections: this.markdown.sections(turn.state),
        progress: runProgress(turn.state),
        createdAtMs: turn.createdAtMs, origin: turn.bridge ? 'bridge' : 'native',
      });
      turns.sort((a, z) => a.createdAtMs - z.createdAtMs || a.id.localeCompare(z.id));
      const result = { session, turns, queuedMessages, confirmedRequestIds, ...(!session.nativeConversation ? { notice: '此 worker 尚未提供原生对话读取；当前显示桥接消息' } : {}) };
      this.assertBinding(id, session.scope);
      this.conversations.set(id, result); return result;
    } catch (e) {
      if (e instanceof WebError) throw e;
      return { session: { ...session, online: false, canSend: false, canRename: false }, queuedMessages, confirmedRequestIds, turns: this.conversations.get(id)?.turns ?? turns, notice: '会话读取失败，稍后自动重试' };
    }
  }
}
