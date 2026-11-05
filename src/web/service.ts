import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, normalize } from 'node:path';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { QueuedMessage } from '../bot/message-queue';
import type { Controls } from '../commands';
import type { SessionCatalog } from '../session/catalog';
import { DurableAgentAdapter } from '../worker/adapter';
import type { WorkerCapabilities } from '../worker/protocol';
import type { AgentKind } from '../config/profile-schema';
import type { AgentTool, ToolSession } from '../tools/types';
import { sessionOperations } from '../tools/session-api';
import { log } from '../core/logger';
import { initialState, reduce, startRunRuntime, updateRunRuntime, type RunState } from '../card/run-state';
import { writeFileAtomic } from '../platform/atomic-write';
import type { WebControlResult } from './controls';
import { renderRunStatus, runStatusColor } from '../card/run-status-render';
import { runProgress } from '../card/run-progress';
import { WebMarkdown, type WebAnswerSection } from './markdown';
import { renameChat } from '../bot/group';
import { sharedPersonalScope, sharedJobPersonalScope, namedSharedMessages, feishuSenderName } from '../worker/shared-history';
import { messageRequestId } from '../worker/identity';
import { isPersonalWorkgroup, type ToolBinding } from '../tools/bindings';
import { DEFAULT_MODEL, resolveModelArg, type ModelOption } from '../agent/models';
import { cachedModelChoices, modelCachePath } from '../agent/model-cache';
import { isStorableModel } from '../agent/defaults';

export class WebError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export interface WebSession {
  id: string; scope: string; toolId: string; tool: string; project: string; cwd: string; name: string;
  updatedAtMs: number; favorite: boolean; online: boolean; canSend: boolean; canRename: boolean; nativeConversation: boolean;
}
export interface WebTurn { id: string; input: string; inputMessages?: { senderName: string; text: string }[]; answer: string; answerSections?: WebAnswerSection[]; requestIds?: string[]; progress?: string[]; statusText?: string; statusColor?: string; status: string; createdAtMs: number; origin: 'bridge' | 'native' }
export interface WebConversation { session: WebSession; turns: WebTurn[]; queuedMessages?: QueuedMessage[]; confirmedRequestIds?: string[]; notice?: string }
/** A tool whose native default model can be read and written from the web. */
export interface WebAgentDefaults { tool: AgentKind; label: string; value?: string; effective?: string; options: ModelOption[]; available: boolean; notice?: string }
interface Receipt { fingerprint: string; sessionId: string; owner: string; createdAt: number; messageId?: string; enqueued?: boolean; scope?: string; queued?: boolean }
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const answer = (s: RunState) => s.blocks.flatMap(b => b.kind === 'text' ? [b.content] : []).join('\n\n');
interface ToolSnapshot { label: string; sourceId: string; rows: ToolSession[]; capabilities?: WorkerCapabilities; online: boolean; listed: boolean; seq: number }
interface GroupSnapshot { mode: string; name?: string; bindingName?: string; seq: number }

/** Personal bindings, queue and native worker snapshots are the only sources of truth. */
export class PersonalSessionService {
  private markdown = new WebMarkdown();
  private receipts: Record<string, Receipt> = {};
  private favorites: Record<string, string> = {};
  private operations = new Map<string, Promise<unknown>>();
  private metadata = new Map<string, ToolSnapshot>();
  private listedAt = 0;
  private conversations = new Map<string, WebConversation>();
  private groups = new Map<string, GroupSnapshot>();
  /** Monotonic counter: a read that started earlier can never overwrite a newer fact. */
  private observations = 0;
  private listing?: Promise<void>;
  private terminalClocks = new Map<string, { signature: string; checkedAt: number }>();
  private jobs = new Map<string, { cursor: number; state: RunState; turnId?: string; nativeId?: string; updatedAt?: number }>();
  constructor(private readonly deps: {
    controls: Controls; catalog?: SessionCatalog; channel: LarkChannel; path: string;
    enqueue(msg: NormalizedMessage): Promise<void | { queued: boolean }>;
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
  settings() { this.owner(); return this.deps.controls.auxiliary?.prefixSettings() ?? { sharedSessionPrefix: false }; }
  async updateSettings(enabled: boolean) {
    const owner = this.owner(), auxiliary = this.deps.controls.auxiliary;
    if (!auxiliary) throw new WebError(503, '会话共享管理尚未就绪');
    const settings = await auxiliary.setPrefixSettings(enabled, owner);
    return { ...settings, sessions: await this.list() };
  }
  ownerIdentity(): string { return this.owner(); }
  /** In-flight re-lists, so a double click cannot spawn two tool processes. */
  private readonly modelRefreshes = new Map<AgentKind, Promise<WebAgentDefaults>>();
  private defaultTools(): AgentTool[] {
    return (this.deps.controls.toolRegistry?.all() ?? []).filter(tool => tool.agent.listModels !== undefined);
  }
  /** Model lists come from each tool's own cache, keyed per tool and project. */
  private modelCache(tool: AgentTool) {
    const profile = this.deps.controls.profileConfig;
    return modelCachePath(dirname(this.deps.path), profile.accounts.app.id, tool.id, tool.sourceId);
  }
  /** One tool's model catalogue; `refresh` shells out to the tool, so callers use it sparingly. */
  private async modelRow(tool: AgentTool, refresh: boolean): Promise<WebAgentDefaults> {
    const store = this.deps.controls.agentDefaults, saved = store?.get(tool.id);
    const cache = this.modelCache(tool);
    const listed = await cachedModelChoices(cache, tool.agent, undefined, DEFAULT_MODEL, refresh);
    const options = listed.options.filter(row => row.value !== DEFAULT_MODEL);
    if (saved && !options.some(row => row.value === saved)) options.push({ value: saved, label: `不在模型列表 · ${saved}`, unavailable: true });
    const effective = options.find(row => row.isDefault)?.value;
    const notices = [store?.brokenReason ?? listed.notice].filter((text): text is string => !!text);
    const preferred = this.deps.controls.profileConfig.agentKind === tool.id
      ? resolveModelArg(tool.id, this.deps.controls.profileConfig.preferences.model) : undefined;
    if (preferred) notices.push(`${tool.agent.displayName} 已有全局模型偏好 ${preferred}，未单独设置模型的会话会优先使用它`);
    if (saved && !listed.available) notices.push('模型列表暂不可用，无法确认该值是否仍然有效');
    return { tool: tool.id, label: tool.agent.displayName, ...(saved ? { value: saved } : {}), ...(effective ? { effective } : {}),
      options, available: listed.available && options.length > 0, ...(notices.length ? { notice: notices.join('；') } : {}) };
  }
  async agentDefaults(): Promise<{ tools: WebAgentDefaults[] }> {
    this.owner();
    const tools = await Promise.all(this.defaultTools().map(tool => this.modelRow(tool, false)));
    return { tools };
  }
  /** Explicit re-list; POST so the write guard checks the request origin. */
  async refreshAgentModels(tool: string): Promise<{ tools: WebAgentDefaults[] }> {
    this.owner();
    const found = this.requireDefaultTool(tool);
    let run = this.modelRefreshes.get(found.id);
    if (!run) {
      const started = this.modelRow(found, true), done = () => this.modelRefreshes.delete(found.id);
      run = started;
      this.modelRefreshes.set(found.id, started);
      started.then(done, done);
    }
    return { tools: [await run] };
  }
  /** true/false when the worker says so, undefined when it cannot be asked. */
  private async modelSupport(tool: AgentTool): Promise<boolean | undefined> {
    const client = (tool.agent as { client?: { health(): Promise<{ capabilities?: { models?: boolean } }> } }).client;
    if (!client) return undefined;
    try { return (await client.health()).capabilities?.models; } catch { return undefined; }
  }
  private requireDefaultTool(tool: string): AgentTool {
    const found = this.defaultTools().find(candidate => candidate.id === tool);
    if (!found) throw new WebError(400, '该执行工具不支持设置默认模型');
    return found;
  }
  async updateAgentDefaults(tool: string, value: string) {
    this.owner();
    const found = this.requireDefaultTool(tool), store = this.deps.controls.agentDefaults;
    if (!store) throw new WebError(503, '默认模型设置尚未就绪');
    if (store.brokenReason) throw new WebError(503, store.brokenReason);
    // Clearing is always safe; a wrong stored token would break every later run,
    // so anything else must be verified against a real catalogue first.
    if (value === DEFAULT_MODEL) { await store.set(found.id, undefined); return { tools: [await this.modelRow(found, false)] }; }
    const row = await this.modelRow(found, false);
    if (!row.available) {
      // Only the probe runs here: a failed read is either "no such capability"
      // (the user must not be told to retry) or "cannot verify right now".
      if (await this.modelSupport(found) === false) throw new WebError(400, '该执行工具不提供模型列表，不能设置默认模型');
      throw new WebError(503, '暂时无法验证模型，请稍后重试');
    }
    if (!isStorableModel(value)) throw new WebError(400, '默认模型格式无效');
    if (!row.options.some(option => option.value === value)) throw new WebError(400, '模型不在可用列表中，请先刷新模型');
    await store.set(found.id, value);
    return { tools: [await this.modelRow(found, false)] };
  }
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
  private setTool(id: string, seq: number, snapshot: Omit<ToolSnapshot, 'seq'>) {
    if ((this.metadata.get(id)?.seq ?? -1) < seq) this.metadata.set(id, { ...snapshot, seq });
  }
  private setGroup(scope: string, seq: number, snapshot: Omit<GroupSnapshot, 'seq'>) {
    if ((this.groups.get(scope)?.seq ?? -1) < seq) this.groups.set(scope, { ...snapshot, seq });
  }
  /** Read one worker's state; a stale failure keeps the rows but never the online claim. */
  private async readTool(tool: AgentTool) {
    const seq = ++this.observations, previous = this.metadata.get(tool.id);
    try {
      if (!(tool.agent instanceof DurableAgentAdapter)) throw new Error('Worker required');
      const health = await tool.agent.client.health();
      const rows = health.capabilities?.sessions.list ? await tool.listSessions() : [];
      this.setTool(tool.id, seq, { label: tool.label, sourceId: tool.sourceId, rows, capabilities: health.capabilities, online: true, listed: health.capabilities?.sessions.list === true });
    } catch { this.setTool(tool.id, seq, { label: tool.label, sourceId: tool.sourceId, rows: previous?.sourceId === tool.sourceId ? previous.rows : [], capabilities: previous?.capabilities, online: false, listed: previous?.sourceId === tool.sourceId && previous.listed === true }); }
  }
  /**
   * Read mode and the actual group title in one request, independently of worker
   * name synchronization and old binding labels. A failure only clears the mode.
   */
  private async readGroup(scope: string, binding: ToolBinding) {
    const seq = ++this.observations, previous = this.groups.get(scope);
    try {
      const result = await this.deps.channel.rawClient.im.v1.chat.get({ path: { chat_id: scope } });
      const data = result.data;
      if (result.code || !data || !['group', 'topic', 'p2p'].includes(data.chat_mode ?? '')) throw new Error('群信息未确认');
      this.setGroup(scope, seq, { mode: data.chat_mode!, name: data.name?.trim() || undefined, bindingName: binding.name });
    } catch { this.setGroup(scope, seq, { ...previous, mode: 'unavailable', bindingName: binding.name }); }
  }
  /** Record what a mutation already knows, so no read started earlier can undo it. */
  private writeThroughGroup(scope: string, mode: string, name?: string, bindingName?: string) {
    const previous = this.groups.get(scope);
    this.setGroup(scope, ++this.observations, { mode, name: name ?? previous?.name, bindingName: bindingName ?? previous?.bindingName });
  }
  private async refresh() {
    if (this.listing) return this.listing;
    if (Date.now() - this.listedAt < 15_000) return;
    this.listedAt = Date.now();
    this.listing = (async () => {
      // Everything read before this sequence number is older than any later write-through.
      const startedAt = ++this.observations;
      const tools = this.deps.controls.toolRegistry?.all() ?? [];
      const present = new Set<string>(tools.map(t => t.id));
      for (const [id, snapshot] of this.metadata) if (!present.has(id) && snapshot.seq < startedAt) snapshot.online = false;
      await Promise.all(tools.map(tool => this.readTool(tool)));
      const bindings = this.bindings();
      const scopes = new Set(bindings.map(([scope]) => scope));
      for (const [scope, snapshot] of this.groups) if (!scopes.has(scope) && snapshot.seq < startedAt) this.groups.delete(scope);
      await Promise.all(bindings.map(([scope, binding]) => this.readGroup(scope, binding)));
    })().finally(() => { this.listing = undefined; });
    return this.listing;
  }
  private async refreshTool(toolId: AgentKind) {
    const tool = this.deps.controls.toolRegistry?.find(toolId);
    if (tool) await this.readTool(tool);
  }
  /** Re-read only one session's tool and group; used where stale facts would be unsafe. */
  private async refreshSession(toolId: AgentKind, scope: string) {
    const tool = this.deps.controls.toolRegistry?.find(toolId);
    const binding = this.bindings().find(([bound]) => bound === scope)?.[1];
    await Promise.all([tool && this.readTool(tool), binding && this.readGroup(scope, binding)]);
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
      const activity = [b.createdAtMs ?? 0, row?.updatedAtMs ?? catalog?.boundAt ?? catalog?.updatedAt ?? 0,
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
    this.owner();
    // Only this session's own facts need to be fresh; a full refresh here made every
    // send and every control wait for unrelated workers and groups.
    if (write) {
      const entry = this.bindings().find(([scope, b]) => this.identity(scope, b) === id);
      if (entry) await this.refreshSession(entry[1].toolId, entry[0]);
    }
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
  private queuedFor(scope: string, requests?: Map<string, string[]>): QueuedMessage[] {
    const byMessage = requests ?? new Map(Object.entries(this.receipts).filter(([, receipt]) => receipt.scope === scope && receipt.messageId)
      .map(([id, receipt]) => [receipt.messageId!, [id]]));
    return (this.deps.controls.messageQueue?.list(scope) ?? []).flatMap(item => {
      const ids = item.messageId ? byMessage.get(item.messageId) : undefined;
      if (ids?.some(id => this.receipts[id]?.queued === false)) return [];
      return [{ ...item, ...(ids?.length ? { requestIds: ids } : {}) }];
    });
  }
  private sendResult(scope: string, requestId: string, receipt: Receipt) {
    return { requestId, status: receipt.queued === false ? 'submitted' : 'queued', queuedMessages: this.queuedFor(scope) };
  }
  async send(id: string, requestId: string, text: string) {
    if (!/^[\w-]{16,120}$/.test(requestId) || !text.trim() || text.length > 16_000) throw new WebError(400, '需要唯一请求 ID 和 1–16000 字文本');
    return this.serial('send:' + requestId, async () => {
      const owner = this.owner(), fingerprint = hash(JSON.stringify([id, owner, text]));
      const old = this.receipts[requestId];
      if (old && old.fingerprint !== fingerprint) throw new WebError(409, '同一请求 ID 的内容或会话已变化');
      if (old?.enqueued) {
        const { session } = await this.resolve(id); this.assertBinding(id, session.scope);
        return this.sendResult(session.scope, requestId, old);
      }
      const { session } = await this.resolve(id, true);
      if (!session.canSend) throw new WebError(503, '此会话不可发送');
      if (await this.deps.channel.getChatMode(session.scope) !== 'group') throw new WebError(409, '群已转为话题模式');
      const receipt = this.receipts[requestId] ??= { fingerprint, sessionId: id, scope: session.scope, owner, createdAt: Date.now(), queued: this.conversations.get(id)?.turns.some(turn => ['running', 'accepted', 'waiting_input', 'submitted'].includes(turn.status)) ?? false };
      if (receipt.enqueued) return this.sendResult(session.scope, requestId, receipt);
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
      const disposition = await this.deps.enqueue({ messageId: receipt.messageId, chatId: session.scope, chatType: 'group', senderId: owner,
        createTime: receipt.createdAt, content: text, resources: [], mentions: [], mentionAll: false, mentionedBot: true, rawContentType: 'text' });
      if (disposition) receipt.queued = disposition.queued;
      receipt.enqueued = true; await this.save();
      return this.sendResult(session.scope, requestId, receipt);
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
    return { removed: true, queuedMessages: this.queuedFor(session.scope) };
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
    this.writeThroughGroup(scope, 'group', name, this.deps.controls.toolBindings?.get(scope)?.name);
    const tool = this.deps.controls.toolRegistry?.find(binding.toolId);
    if (tool?.sourceId === binding.sourceId && binding.nativeId) {
      try { await sessionOperations(tool).rename(binding.nativeId, name); }
      catch (err) { log.warn('web', 'native-name-update-failed', { toolId: binding.toolId, err: err instanceof Error ? err.message : String(err) }); }
    }
    return { name };
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
      const scope = result.scope;
      // This call just created the group, so its mode is a fact rather than a guess.
      this.writeThroughGroup(scope, 'group', undefined, this.deps.controls.toolBindings?.get(scope)?.name);
      const session = (await this.list()).find(row => row.scope === scope);
      return { elements: result.elements, scope, ...(session ? { session } : {}) };
    });
  }
  async control(id: string, action: string, values?: unknown) {
    return this.serial('control:' + id, async () => {
      if (action === 'finish' || action === 'config') {
        const owner = this.owner(), entry = this.bindings().find(([scope, b]) => this.identity(scope, b) === id);
        if (!entry) throw new WebError(404, '会话已归档或绑定已变化');
        this.assertBinding(id, entry[0]);
        if (!this.deps.control) throw new WebError(503, '会话操作尚未就绪');
        return this.deps.control(id, entry[0], owner, action, values);
      }
      const { session } = await this.resolve(id, true);
      this.assertBinding(id, session.scope);
      if (action === 'refresh') {
        return { conversation: await this.read(id), elements: [] };
      }
      if (!this.deps.control) throw new WebError(503, '会话操作尚未就绪');
      const before = new Set(this.bindings().map(([scope]) => scope));
      const result = await this.deps.control(id, session.scope, this.owner(), action, values);
      await this.noteCreatedGroups(before);
      return values ? { ...result, sessions: await this.list() } : result;
    });
  }
  /**
   * A control card can create a group. Record the facts we already know instead of
   * re-reading everything; a native fork additionally needs its tool's session list.
   */
  private async noteCreatedGroups(before: Set<string>) {
    const bindings = this.deps.controls.toolBindings, tools = new Set<AgentKind>();
    for (const bound of this.bindings()) {
      if (before.has(bound[0])) continue;
      const binding = bindings?.get(bound[0]);
      this.writeThroughGroup(bound[0], 'group', undefined, binding?.name);
      if (binding && binding.nativeCreated !== false) tools.add(binding.toolId);
    }
    await Promise.all([...tools].map(toolId => this.refreshTool(toolId)));
  }
  private runStatus(state: RunState, project: string, checkedAt?: number, key?: string) {
    const view: RunState = { ...state, projectName: state.projectName ?? project };
    if (state.runtime) {
      let clock = checkedAt ?? state.runtime.checkedAtMs;
      // Some workers refresh snapshot clocks for completed turns. Freeze unchanged history.
      if (key && state.terminal !== 'running') {
        const signature = JSON.stringify({ ...state, runtime: undefined });
        const previous = this.terminalClocks.get(key);
        if (previous?.signature === signature) clock = previous.checkedAt;
        else {
          if (this.terminalClocks.size >= 2000) this.terminalClocks.delete(this.terminalClocks.keys().next().value!);
          this.terminalClocks.set(key, { signature, checkedAt: clock });
        }
      } else if (key) this.terminalClocks.delete(key);
      view.runtime = { ...state.runtime, checkedAtMs: clock, processRunning: state.terminal === 'running' };
    }
    const context = renderRunStatus(view);
    const label = { running: '运行中', done: '✅ 已完成', interrupted: '⏹ 已中断', error: '⚠️ 运行失败', idle_timeout: '⏱ 已超时' }[state.terminal];
    return { statusText: view.runtime ? context : [label, context].filter(Boolean).join(' · '), statusColor: runStatusColor(view) };
  }
  async read(id: string): Promise<WebConversation> {
    const { session, b, client } = await this.resolve(id);
    const owner = this.owner(), requests = new Map<string, string[]>(), confirmedRequestIds: string[] = [];
    // Messages sent before the first run created the native session were recorded under its pending identity.
    const ids = new Set([id, this.identity(session.scope, { ...b, nativeId: undefined })]);
    for (const [requestId, receipt] of Object.entries(this.receipts)) if ((receipt.scope === session.scope || ids.has(receipt.sessionId)) && receipt.owner === owner && receipt.messageId) {
      const ids = requests.get(receipt.messageId) ?? []; ids.push(requestId); requests.set(receipt.messageId, ids);
      if (receipt.enqueued) confirmedRequestIds.push(requestId);
    }
    const queuedMessages = this.queuedFor(session.scope, requests);
    const runtime = this.deps.controls.workerRuntimes?.get(b.toolId);
    const receipts = this.receiptScopes(session.scope).flatMap(scope => runtime?.inbox.receipts(scope) ?? []);
    const turns: WebTurn[] = receipts.filter(r => r.status === 'pending' || r.status === 'rejected' || r.status === 'cancelled').map(r => ({ id: 'receipt:' + r.message.messageId,
      input: r.message.content, answer: '', requestIds: requests.get(r.message.messageId), status: r.status === 'pending' ? requests.get(r.message.messageId)?.some(id => this.receipts[id]?.queued === false) ? 'submitted' : 'queued' : r.status, createdAtMs: Number(r.message.createTime), origin: 'bridge' }));
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
      const linkedTurns = new Set<string>();
      for (const job of jobs) {
        const cacheKey = b.sourceId + ':' + job.id;
        let view = this.jobs.get(cacheKey);
        if (!view) { view = { cursor: 0, state: structuredClone(startRunRuntime(initialState, job.createdAt)) }; this.jobs.set(cacheKey, view); }
        const snapshot = view.updatedAt !== job.updatedAt || ['running', 'accepted'].includes(job.status) ? await client.snapshot(job.id, view.cursor) : undefined;
        for (const row of snapshot?.events ?? []) {
          if (row.seq <= view.cursor) continue;
          view.cursor = row.seq; view.state = updateRunRuntime(reduce(view.state, row.event), { nowMs: row.at, activity: true });
          if (row.event.type === 'system') { if (row.event.turnId) view.turnId = row.event.turnId; if (row.event.threadId ?? row.event.sessionId) view.nativeId = row.event.threadId ?? row.event.sessionId; }
        }
        view.updatedAt = job.updatedAt;
        if ((job.options.threadId ?? job.options.sessionId ?? view.nativeId) !== b.nativeId) continue;
        if (view.turnId) linkedTurns.add(view.turnId);
        const shared = job.options.delivery!.scope !== session.scope;
        // Delivery ids keep the callback suffix that made the request unique (`om_x:callback:copy-read-…`),
        // while inbox receipts carry the plain Feishu message id.
        const inputs = shared ? (await namedSharedMessages(this.deps.controls, this.deps.channel, job)).map(message => ({ message })) :
          receipts.filter(r => r.scope === session.scope && job.options.delivery?.messageIds?.some(id => id === r.message.messageId || id === messageRequestId(r.message)));
        const ids = new Set(inputs.map(r => 'receipt:' + r.message.messageId));
        for (let i = turns.length - 1; i >= 0; i--) if (ids.has(turns[i]!.id)) turns.splice(i, 1);
        const nativeTurn = native?.turns.find(t => t.bridgeJobId === job.id || t.id === view!.turnId);
        if (nativeTurn) linkedTurns.add(nativeTurn.id);
        // Job prompts contain bridge policy/context. Never return them to Web; messages the bridge
        // sent itself (copy notices, card callbacks) may carry no Feishu receipt yet, so fall back
        // to the native turn text, which is exactly what the group saw.
        const input = inputs.length ? inputs.map(r => r.message.content).join('\n\n') : nativeTurn?.input;
        if (!input) continue;
        const status = job.status === 'running' ? (view.state.footer === 'waiting_input' ? 'waiting_input' : 'running') : job.status;
        let state = shared ? view.state : nativeTurn?.state ?? view.state;
        if (shared && this.deps.controls.auxiliaryApprovals) state = await this.deps.controls.auxiliaryApprovals.review(job.options.delivery!.scope, job.id, job.options.delivery!.replyTo, state);
        if (shared && sharedJobPersonalScope(this.deps.controls, this.deps.catalog, job) !== session.scope) continue;
        const terminal = { accepted: 'running', running: 'running', completed: 'done', failed: 'error', interrupted: 'interrupted', unknown: state.terminal }[job.status] as RunState['terminal'];
        const statusState: RunState = { ...state, terminal, runtime: view.state.runtime,
          execution: state.execution || view.state.execution || job.options.model || job.options.reasoningEffort
            ? { ...(job.options.model ? { model: job.options.model } : {}),
                ...(job.options.reasoningEffort ? { requestedReasoningEffort: job.options.reasoningEffort } : {}),
                ...view.state.execution, ...state.execution } : undefined };
        turns.push({ id: 'job:' + job.id, input, answer: answer(state), status,
          ...(shared ? { inputMessages: inputs.map(r => ({ senderName: r.message.senderName!, text: r.message.content })) } : {}),
          answerSections: this.markdown.sections(state),
          requestIds: inputs.flatMap(r => requests.get(r.message.messageId) ?? []),
          ...this.runStatus(statusState, session.project, ['running', 'accepted'].includes(job.status) ? Date.now() : job.updatedAt),
          progress: runProgress({ ...state, terminal: ['running', 'accepted'].includes(job.status) ? 'running' : 'done' }),
          createdAtMs: job.createdAt, origin: 'bridge' });
      }
      for (const turn of native?.turns ?? []) {
        if (linkedTurns.has(turn.id)) continue;
        // An unlinked turn has no job of its own: it either predates the binding or the bridge only
        // answered a question inside a natively started turn, which some workers still flag as
        // bridge. Its own user text is exactly what the group saw, so show it rather than silently
        // dropping the newest turns of a session.
        if (turn.bridge && !turn.input) continue;
        turns.push({
          id: 'native:' + turn.id, input: turn.input, answer: answer(turn.state), status: turn.state.footer === 'waiting_input' ? 'waiting_input' : turn.state.terminal,
          answerSections: this.markdown.sections(turn.state),
          progress: runProgress(turn.state),
          ...this.runStatus(turn.state, session.project, undefined, id + ':' + turn.id),
          createdAtMs: turn.createdAtMs, origin: turn.bridge ? 'bridge' : 'native',
        });
      }
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
