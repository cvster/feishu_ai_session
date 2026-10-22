import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { normalize } from 'node:path';
import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { Controls } from '../commands';
import type { SessionCatalog } from '../session/catalog';
import { DurableAgentAdapter } from '../worker/adapter';
import type { WorkerCapabilities } from '../worker/protocol';
import type { ToolSession } from '../tools/types';
import { initialState, reduce, type RunState } from '../card/run-state';
import { writeFileAtomic } from '../platform/atomic-write';
import type { WebControlResult } from './controls';

export class WebError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export interface WebSession {
  id: string; scope: string; toolId: string; tool: string; project: string; cwd: string; name: string;
  online: boolean; canSend: boolean; canRename: boolean; nativeConversation: boolean;
}
export interface WebTurn { id: string; input: string; answer: string; status: string; createdAtMs: number; origin: 'bridge' | 'native' }
export interface WebConversation { session: WebSession; turns: WebTurn[]; notice?: string }
interface Receipt { fingerprint: string; sessionId: string; owner: string; createdAt: number; messageId?: string; enqueued?: boolean }
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const answer = (s: RunState) => s.blocks.flatMap(b => b.kind === 'text' ? [b.content] : []).join('\n\n');

/** Personal bindings, queue and native worker snapshots are the only sources of truth. */
export class PersonalSessionService {
  private receipts: Record<string, Receipt> = {};
  private operations = new Map<string, Promise<unknown>>();
  private metadata = new Map<string, { label: string; sourceId: string; rows: ToolSession[]; capabilities?: WorkerCapabilities; online: boolean }>();
  private listedAt = 0;
  private conversations = new Map<string, WebConversation>();
  private groups = new Map<string, { mode: string; name?: string; bindingName?: string }>();
  private listing?: Promise<void>;
  private jobs = new Map<string, { cursor: number; state: RunState; turnId?: string; nativeId?: string; updatedAt?: number }>();
  constructor(private readonly deps: {
    controls: Controls; catalog?: SessionCatalog; channel: LarkChannel; path: string;
    enqueue(msg: NormalizedMessage): Promise<void>;
    rename(toolId: string, scope: string, id: string, name: string): Promise<void>;
    control?(id: string, scope: string, owner: string, action: string, values?: unknown): Promise<WebControlResult>;
  }) {}
  async load() {
    try { const r = JSON.parse(await readFile(this.deps.path, 'utf8')); if (r.version !== 1 || !r.receipts || Array.isArray(r.receipts)) throw new Error('网页请求账本无效'); this.receipts = r.receipts; }
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
          this.metadata.set(tool.id, { label: tool.label, sourceId: tool.sourceId, rows, capabilities: health.capabilities, online: true });
        } catch { this.metadata.set(tool.id, { label: tool.label, sourceId: tool.sourceId, rows: previous?.sourceId === tool.sourceId ? previous.rows : [], capabilities: previous?.capabilities, online: false }); }
      }));
      const bindings = this.deps.controls.toolBindings?.activePersonalBindings() ?? [];
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
    this.owner(); await this.refresh();
    return (this.deps.controls.toolBindings?.activePersonalBindings() ?? []).flatMap(([scope, b]) => {
      if (this.deps.controls.auxiliary?.isAuxiliary(scope) || ['topic', 'p2p'].includes(this.groups.get(scope)?.mode ?? '')) return [];
      const meta = this.metadata.get(b.toolId), tool = this.deps.controls.toolRegistry?.find(b.toolId);
      const row = meta?.sourceId === b.sourceId ? meta.rows.find(r => r.nativeId === b.nativeId) : undefined;
      if (row?.archived) return [];
      const catalog = this.deps.catalog?.entries().filter(r => r.scopeId === scope && r.status === 'active' && r.agentId === b.toolId &&
        (!r.sourceId || r.sourceId === b.sourceId) && (!r.botAppId || r.botAppId === this.deps.controls.profileConfig.accounts.app.id) &&
        (r.threadId ?? r.sessionId) === b.nativeId).sort((a, z) => z.updatedAt - a.updatedAt)[0];
      const cwd = normalize(row?.cwd ?? catalog?.cwdRealpath ?? '.');
      const online = this.groups.get(scope)?.mode === 'group' && meta?.online === true && !!tool && tool.sourceId === b.sourceId && !!row;
      const group = this.groups.get(scope);
      // A confirmed name sync may be newer than our 15-second group snapshot.
      const name = group?.bindingName !== b.name ? b.name : group?.name ?? b.name;
      return [{ id: this.identity(scope, b), scope, toolId: b.toolId, tool: meta?.label ?? b.toolId,
        cwd, project: cwd.split(/[/\\]/).filter(Boolean).pop() ?? cwd, name: name ?? row?.name ?? b.nativeId!, online,
        canSend: online && meta?.capabilities?.jobs.submit === true,
        canRename: online && meta?.capabilities?.sessions.rename === true && meta?.capabilities?.nativeSessionNames === true,
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
    const b = this.deps.controls.toolBindings?.activePersonalBindings().find(([s, b]) => s === scope && this.identity(s, b) === id);
    if (!b || this.deps.controls.auxiliary?.isAuxiliary(scope)) throw new WebError(409, '会话绑定已变化，未继续提交');
  }
  private serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const task = (this.operations.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    this.operations.set(key, task); void task.finally(() => { if (this.operations.get(key) === task) this.operations.delete(key); }).catch(() => {});
    return task;
  }
  private save() { return this.serial('ledger', () => writeFileAtomic(this.deps.path, JSON.stringify({ version: 1, receipts: this.receipts }) + '\n', { mode: 0o600 })); }
  async send(id: string, requestId: string, text: string) {
    if (!/^[\w-]{16,120}$/.test(requestId) || !text.trim() || text.length > 16_000) throw new WebError(400, '需要唯一请求 ID 和 1–16000 字文本');
    return this.serial('send:' + requestId, async () => {
      const owner = this.owner(), fingerprint = hash(JSON.stringify([id, owner, text]));
      const old = this.receipts[requestId];
      if (old && old.fingerprint !== fingerprint) throw new WebError(409, '同一请求 ID 的内容或会话已变化');
      if (old?.enqueued) {
        const { session } = await this.resolve(id); this.assertBinding(id, session.scope);
        return { requestId, status: 'queued' };
      }
      const { session } = await this.resolve(id, true);
      if (!session.canSend) throw new WebError(503, '此会话不可发送');
      if (await this.deps.channel.getChatMode(session.scope) !== 'group') throw new WebError(409, '群已转为话题模式');
      const receipt = this.receipts[requestId] ??= { fingerprint, sessionId: id, owner, createdAt: Date.now() };
      if (receipt.enqueued) return { requestId, status: 'queued' };
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
      return { requestId, status: 'queued' };
    });
  }
  async rename(id: string, name: string) {
    name = name.trim(); if (!name || name.length > 100 || /[\u0000-\u001f]/.test(name)) throw new WebError(400, '名称需为 1–100 字');
    const { session, b } = await this.resolve(id, true);
    if (!session.canRename) throw new WebError(409, '此 worker 尚未支持名称同步');
    this.assertBinding(id, session.scope);
    await this.deps.rename(b.toolId, session.scope, b.nativeId!, name);
    this.groups.set(session.scope, { mode: 'group', name, bindingName: this.deps.controls.toolBindings?.get(session.scope)?.name });
    this.listedAt = 0; return { name };
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
    const runtime = this.deps.controls.workerRuntimes?.get(b.toolId);
    const receipts = runtime?.inbox.receipts(session.scope) ?? [];
    const turns: WebTurn[] = receipts.filter(r => r.status === 'pending' || r.status === 'rejected').map(r => ({ id: 'receipt:' + r.message.messageId,
      input: r.message.content, answer: '', status: r.status === 'pending' ? 'queued' : 'rejected', createdAtMs: Number(r.message.createTime), origin: 'bridge' }));
    if (!session.online || !client) return { session, turns: this.conversations.get(id)?.turns ?? turns, notice: 'Worker 离线；恢复后会重新读取会话' };
    try {
      const [native, allJobs] = await Promise.all([session.nativeConversation ? client.conversation(b.nativeId!) : undefined, client.list()]);
      this.assertBinding(id, session.scope);
      if ((native?.id !== undefined && native.id !== b.nativeId) || native?.archived) throw new WebError(404, '会话已归档或身份变化');
      const jobs = allJobs.filter(j => j.options.delivery?.scope === session.scope && j.options.delivery.sourceId === b.sourceId &&
        j.options.delivery.botAppId === this.deps.controls.profileConfig.accounts.app.id);
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
        const inputs = receipts.filter(r => job.options.delivery?.messageIds?.includes(r.message.messageId));
        const ids = new Set(inputs.map(r => 'receipt:' + r.message.messageId));
        for (let i = turns.length - 1; i >= 0; i--) if (ids.has(turns[i]!.id)) turns.splice(i, 1);
        // Job prompts contain bridge policy/context. Never return them to Web.
        if (!inputs.length) continue;
        const status = job.status === 'running' ? (view.state.footer === 'waiting_input' ? 'waiting_input' : 'running') : job.status;
        const nativeTurn = native?.turns.find(t => t.bridgeJobId === job.id || t.id === view!.turnId);
        if (nativeTurn) linkedTurns.add(nativeTurn.id);
        turns.push({ id: 'job:' + job.id, input: inputs.map(r => r.message.content).join('\n\n'), answer: answer(nativeTurn?.state ?? view.state), status,
          createdAtMs: job.createdAt, origin: 'bridge' });
      }
      const historyBoundary = Math.min(...matchedJobTimes);
      for (const turn of native?.turns ?? []) if (!linkedTurns.has(turn.id) && (!turn.bridge || turn.createdAtMs < historyBoundary)) turns.push({
        id: 'native:' + turn.id, input: turn.bridge ? '' : turn.input, answer: answer(turn.state), status: turn.state.footer === 'waiting_input' ? 'waiting_input' : turn.state.terminal,
        createdAtMs: turn.createdAtMs, origin: turn.bridge ? 'bridge' : 'native',
      });
      turns.sort((a, z) => a.createdAtMs - z.createdAtMs || a.id.localeCompare(z.id));
      const result = { session, turns, ...(!session.nativeConversation ? { notice: '此 worker 尚未提供原生对话读取；当前显示桥接消息' } : {}) };
      this.conversations.set(id, result); return result;
    } catch (e) {
      if (e instanceof WebError) throw e;
      return { session: { ...session, online: false, canSend: false, canRename: false }, turns: this.conversations.get(id)?.turns ?? turns, notice: '会话读取失败，稍后自动重试' };
    }
  }
}
