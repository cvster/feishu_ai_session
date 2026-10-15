import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { BotAddedEvent, CardActionEvent, LarkChannel } from '@larksuite/channel';
import type { AgentKind } from '../config/profile-schema';
import type { ToolRegistry } from '../tools/types';
import { sessionRefKey, type ToolBindingStore, type LinkedSession } from '../tools/bindings';
import type { SessionCatalog, SessionCatalogIdentity } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { writeFileAtomic } from '../platform/atomic-write';
import { resolveWorkingDirectory } from '../policy/workspace';
import { sendManagedCard } from '../card/managed';
import { waitForBridgeGroupCreation } from './group';
import { auxiliaryBotIsMember } from './auxiliary-membership';

export interface AuxiliaryGroup {
  chatId: string;
  name: string;
  generation: string;
  ownerId: string;
  status: 'pending' | 'active' | 'leaving' | 'archived';
  notified?: boolean;
  source?: LinkedSession;
  cwd?: string;
  requesters?: Record<string, string>;
  running?: { id: string; actorId: string };
  archivedNative?: boolean;
}

interface Deps {
  path: string;
  appId: string;
  channel: LarkChannel;
  ownerId(): string | undefined;
  refreshOwner(): Promise<void>;
  tools: ToolRegistry;
  bindings: ToolBindingStore;
  sessions: SessionStore;
  catalog?: SessionCatalog;
  workspaces: WorkspaceStore;
  cancelPending(chatId: string): Promise<void>;
}
interface Choice {
  chatId: string; generation: string; ownerId: string; expires: number;
  toolId?: AgentKind; nativeId?: string; page: number;
}

/** Private owner selection; no source conversation is resumed or mutated. */
export class AuxiliaryGroups {
  private records: Record<string, AuxiliaryGroup> = {};
  private renamed = new Set<string>();
  private choices = new Map<string, Choice>();
  private saving: Promise<void> = Promise.resolve();
  private chains = new Map<string, Promise<unknown>>();
  constructor(private readonly deps: Deps) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.deps.path, 'utf8'));
      if (raw.version !== 1 || raw.appId !== this.deps.appId || !raw.groups || Array.isArray(raw.groups)) throw new Error('Invalid auxiliary ledger');
      for (const [chatId, row] of Object.entries(raw.groups)) {
        const r = row as AuxiliaryGroup;
        if (!r || r.chatId !== chatId || typeof r.generation !== 'string' || typeof r.ownerId !== 'string' ||
          !['pending', 'active', 'leaving', 'archived'].includes(r.status) ||
          (r.status === 'active' && (!r.source || !r.cwd))) throw new Error('Invalid auxiliary group');
      }
      this.records = raw.groups;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await this.migrateSharedBindings();
  }
  get(chatId: string): AuxiliaryGroup | undefined { return this.records[chatId]; }
  isActive(chatId: string): boolean { return this.get(chatId)?.status === 'active'; }
  isAuxiliary(chatId: string): boolean { return !!this.get(chatId); }
  private sourceKey(source: LinkedSession): string { return sessionRefKey(source.toolId, source.sourceId, source.nativeId); }
  private references(row: AuxiliaryGroup): AuxiliaryGroup[] {
    return Object.values(this.records).filter(r => r.source && row.source && r.ownerId === row.ownerId &&
      this.sourceKey(r.source) === this.sourceKey(row.source) &&
      (r.status === 'active' || (r.status === 'leaving' && !r.archivedNative)));
  }
  /** Upgrade old per-chat FF bindings without deleting or merging native transcripts. */
  private async migrateSharedBindings(): Promise<void> {
    const buckets = new Map<string, AuxiliaryGroup[]>();
    for (const row of Object.values(this.records)) if (row.source &&
      (row.status === 'active' || (row.status === 'leaving' && !row.archivedNative))) {
      const key = this.sourceKey(row.source);
      buckets.set(key, [...(buckets.get(key) ?? []), row]);
    }
    for (const rows of buckets.values()) {
      if (rows.every(r => this.deps.bindings.get(r.chatId)?.sharedScope)) {
        const binding = this.deps.bindings.get(rows[0]!.chatId)!;
        if (!binding.nativeCreated) {
          const ids = [...new Set(this.deps.catalog?.entries().filter(e => e.status === 'active' && e.agentId === binding.toolId &&
            rows.some(r => r.chatId === e.scopeId)).map(e => e.threadId ?? e.sessionId).filter((id): id is string => !!id))];
          if (ids.length > 1) throw new Error('共享 FF 的原生会话记录冲突');
          if (ids[0]) {
            if (ids[0] === rows[0]!.source!.nativeId) throw new Error('共享 FF 记录不能指向原会话');
            this.deps.bindings.set(rows[0]!.chatId, { ...binding, nativeId: ids[0], nativeCreated: true });
          }
        }
        continue;
      }
      const existing = rows.find(r => this.deps.bindings.get(r.chatId)?.sharedScope);
      const candidates = rows.map(row => {
        const binding = this.deps.bindings.get(row.chatId);
        const catalog = this.deps.catalog?.entries().filter(e => e.scopeId === row.chatId && e.status === 'active')
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        return { row, binding, id: catalog?.threadId ?? catalog?.sessionId ?? (binding?.nativeCreated ? binding.nativeId : undefined) };
      });
      const chosen = candidates.find(c => c.row === existing) ?? candidates.find(c => c.id) ?? candidates[0]!;
      if (!chosen.binding || !chosen.row.source) throw new Error('辅助群缺少工具绑定');
      let name = chosen.row.source.nativeId;
      try { name = (await this.deps.tools.get(chosen.row.source.toolId).listSessions()).find(s => s.nativeId === chosen.row.source!.nativeId)?.name || name; }
      catch { /* An unavailable source title must not prevent history recovery. */ }
      const sharedScope = chosen.binding.sharedScope ?? `aux_${randomUUID()}`;
      if (!chosen.binding.sharedScope) this.deps.bindings.set(sharedScope, { ...chosen.binding, sharedScope: undefined,
        name: `FF-${name}`, nativeId: chosen.id ?? chosen.binding.nativeId, nativeCreated: !!chosen.id });
      const canonical = this.deps.bindings.get(sharedScope)!;
      if (canonical.nativeId === chosen.row.source.nativeId) throw new Error('辅助会话不能指向原会话');
      for (const row of rows) {
        for (const entry of this.deps.catalog?.entries().filter(e => e.scopeId === row.chatId && e.status === 'active') ?? []) {
          if ((entry.threadId ?? entry.sessionId) !== canonical.nativeId) this.deps.catalog!.archiveActive(entry);
        }
        this.deps.bindings.linkAuxiliary(row.chatId, sharedScope);
        this.deps.sessions.remove(row.chatId);
        row.cwd = chosen.row.cwd;
        if (row.cwd) this.deps.workspaces.setCwd(row.chatId, row.cwd);
      }
    }
    await Promise.all([this.deps.bindings.flush(), this.deps.sessions.flush(), this.deps.catalog?.flush(), this.deps.workspaces.flush()]);
    if (buckets.size) await this.save();
  }
  async withRun<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    const generation = this.get(chatId)?.generation;
    const key = this.deps.bindings.get(chatId)?.sharedScope ?? chatId;
    return this.serial(`run:${key}`, async () => {
      if (!this.isActive(chatId) || generation !== this.get(chatId)?.generation) throw new Error('辅助群关联已变更');
      await this.renameSharedSession(chatId);
      return work();
    });
  }
  private async renameSharedSession(chatId: string): Promise<void> {
    const b = this.deps.bindings.get(chatId);
    if (!b?.sharedScope || !b.nativeCreated || !b.nativeId || !b.name) return;
    const key = JSON.stringify([b.sourceId, b.toolId, b.nativeId, b.name]);
    if (this.renamed.has(key)) return;
    if (b.nativeId === b.linkedSource?.nativeId) throw new Error('拒绝修改原会话名称');
    if (b.toolId === 'codex') {
      const agent = this.deps.tools.get('codex').agent;
      if (!agent.setThreadName) throw new Error('Codex 未提供会话改名能力');
      await agent.setThreadName(b.nativeId, b.name);
    } else {
      const path = await findSessionHistory('claude', b.sourceId, b.nativeId);
      if (!path) throw new Error('辅助 Claude 会话记录不可读');
      const file = await open(path, constants.O_WRONLY | constants.O_APPEND);
      try { await file.writeFile(JSON.stringify({ type: 'custom-title', sessionId: b.nativeId, customTitle: b.name }) + '\n'); }
      finally { await file.close(); }
    }
    this.renamed.add(key);
  }
  /** Materialize a chat-local routing catalog entry for the shared native conversation. */
  async prepareScope(chatId: string, identity: SessionCatalogIdentity | undefined): Promise<void> {
    const b = this.deps.bindings.get(chatId);
    if (!identity || !b?.sharedScope || !b.nativeCreated || !b.nativeId || !this.isActive(chatId)) return;
    if (b.nativeId === b.linkedSource?.nativeId) throw new Error('辅助会话不能恢复原会话');
    if (this.deps.catalog?.isScopeArchived(chatId)) throw new Error('辅助群已归档');
    this.deps.catalog?.upsertActive({ ...identity, sourceId: b.sourceId, botAppId: this.deps.appId,
      ...(b.toolId === 'codex' ? { threadId: b.nativeId } : { sessionId: b.nativeId }) });
    this.deps.sessions.set(chatId, b.nativeId, this.get(chatId)!.cwd!);
    await Promise.all([this.deps.catalog?.flush(), this.deps.sessions.flush()]);
  }
  private serial<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(chatId) ?? Promise.resolve()).catch(() => {}).then(work);
    this.chains.set(chatId, next);
    void next.finally(() => { if (this.chains.get(chatId) === next) this.chains.delete(chatId); }).catch(() => {});
    return next;
  }
  private save(): Promise<void> {
    const text = JSON.stringify({ version: 1, appId: this.deps.appId, groups: this.records }, null, 2);
    this.saving = this.saving.catch(() => {}).then(() => writeFileAtomic(this.deps.path, text + '\n', { mode: 0o600 }));
    return this.saving;
  }
  async flush(): Promise<void> { await this.saving; }

  async joined(event: BotAddedEvent): Promise<void> {
    if (await waitForBridgeGroupCreation(event.chatId)) return;
    if (!this.deps.ownerId()) await this.deps.refreshOwner();
    const owner = this.deps.ownerId();
    if (!owner || event.operator.openId !== owner) return;
    await this.serial(event.chatId, async () => {
      const old = this.get(event.chatId);
      if (old && old.status !== 'archived') { if (old.status === 'pending' && !old.notified) await this.notify(old); return; }
      if (!old && (this.deps.bindings.get(event.chatId) || this.deps.catalog?.entries().some(e => e.scopeId === event.chatId))) return;
      if (old?.status === 'archived' && this.deps.bindings.get(event.chatId)?.linkedSource) {
        this.deps.bindings.releaseAuxiliary(event.chatId); await this.deps.bindings.flush();
      }
      const info = await this.deps.channel.rawClient.im.v1.chat.get({ path: { chat_id: event.chatId } });
      if (info.code) throw new Error(`群信息查询失败：${info.code}`);
      const row: AuxiliaryGroup = { chatId: event.chatId, name: info.data?.name || '未命名群',
        generation: randomUUID(), ownerId: owner, status: 'pending' };
      this.records[event.chatId] = row;
      await this.save();
      await this.notify(row);
    });
  }

  async recover(): Promise<void> {
    for (const row of Object.values(this.records)) {
      if (row.ownerId !== this.deps.ownerId()) continue;
      // Tokens are process-local. /aux issues a fresh card after a restart or expiry.
      if (row.status === 'pending' && !row.notified) await this.notify(row);
      if (row.status === 'leaving') await this.deps.channel.send(row.ownerId, {
        text: `「${row.name}」退出尚未完成，请在群内再次 @我发送“退出”重试。`,
      });
    }
  }
  async pendingFor(owner: string): Promise<void> {
    if (owner !== this.deps.ownerId()) return;
    const rows = Object.values(this.records).filter(r => r.ownerId === owner && r.status === 'pending');
    if (!rows.length) { await this.deps.channel.send(owner, { text: '没有待关联的辅助群。' }); return; }
    for (const row of rows) await this.notify(row);
  }
  isAuxiliaryNative(toolId: AgentKind, sourceId: string, nativeId: string): boolean {
    return this.deps.bindings.entries().some(([, b]) => b.linkedSource && b.toolId === toolId && b.sourceId === sourceId && b.nativeId === nativeId) ||
      !!this.deps.catalog?.entries().some(e => this.isAuxiliary(e.scopeId) && e.agentId === toolId && (!e.sourceId || e.sourceId === sourceId) && (e.threadId ?? e.sessionId) === nativeId);
  }
  private button(label: string, choice: Choice): object {
    for (const [key, value] of this.choices) if (value.expires < Date.now()) this.choices.delete(key);
    const token = randomUUID(); this.choices.set(token, choice);
    return { tag: 'button', text: { tag: 'plain_text', content: label.slice(0, 100) }, type: 'default',
      behaviors: [{ type: 'callback', value: { cmd: 'auxiliary.select', token } }] };
  }
  private async notify(row: AuxiliaryGroup, toolId?: AgentKind, page = 0): Promise<void> {
    const base: Choice = { chatId: row.chatId, generation: row.generation, ownerId: row.ownerId,
      expires: Date.now() + 15 * 60_000, page, toolId };
    const buttons: object[] = [];
    let description = '选择执行工具，再选择已有会话。原会话保持独立，关联同一来源的群共用 FF 辅助会话。';
    if (toolId) {
      const tool = this.deps.tools.get(toolId);
      const sessions = (await tool.listSessions()).filter(s => !s.archived && !s.name?.startsWith('FF-') && !this.isAuxiliaryNative(toolId, tool.sourceId, s.nativeId) &&
        !this.deps.bindings.isArchived(toolId, tool.sourceId, s.nativeId)).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      for (const s of sessions.slice(page * 6, page * 6 + 6)) buttons.push(this.button(`${s.name || s.nativeId.slice(0, 12)} · ${s.cwd}`, { ...base, nativeId: s.nativeId }));
      if (page > 0) buttons.push(this.button('上一页', { ...base, page: page - 1 }));
      if ((page + 1) * 6 < sessions.length) buttons.push(this.button('下一页', { ...base, page: page + 1 }));
      buttons.push(this.button('返回工具选择', { ...base, toolId: undefined, page: 0 }));
      description = `${tool.label}：选择要共享给本群的原会话。将继承项目目录，并在每次 @ 时读取其最新内容。`;
    } else for (const tool of this.deps.tools.all()) buttons.push(this.button(tool.label, { ...base, toolId: tool.id }));
    await sendManagedCard(this.deps.channel, row.ownerId, { schema: '2.0',
      header: { title: { tag: 'plain_text', content: `关联辅助群：${row.name}` } },
      body: { elements: [{ tag: 'markdown', content: description }, ...buttons] } });
    row.notified = true; await this.save();
  }
  async action(event: CardActionEvent): Promise<boolean> {
    const payload = event.action.value as Record<string, unknown> | undefined;
    if (payload?.cmd !== 'auxiliary.select') return false;
    const token = typeof payload.token === 'string' ? payload.token : '';
    const choice = this.choices.get(token);
    if (!choice || choice.expires < Date.now() || choice.ownerId !== event.operator.openId || choice.ownerId !== this.deps.ownerId()) return true;
    // A forwarded owner card must not activate from another group's context.
    if (await this.deps.channel.getChatMode(event.chatId) !== 'p2p') return true;
    await this.serial(choice.chatId, async () => {
      const row = this.get(choice.chatId);
      if (!row || row.status !== 'pending' || row.generation !== choice.generation) return;
      if (!choice.nativeId || !choice.toolId) { await this.notify(row, choice.toolId, choice.page); return; }
      const tool = this.deps.tools.get(choice.toolId);
      const source = (await tool.listSessions()).find(s => s.nativeId === choice.nativeId && !s.archived && !s.name?.startsWith('FF-') && !this.isAuxiliaryNative(tool.id, tool.sourceId, s.nativeId));
      if (!source || this.deps.bindings.isArchived(tool.id, tool.sourceId, source.nativeId)) throw new Error('原会话已不可用，请重新选择。');
      const workspace = await resolveWorkingDirectory(source.cwd);
      if (!workspace.ok) throw new Error(workspace.userVisible);
      const historyPath = await findSessionHistory(tool.id, tool.sourceId, source.nativeId);
      if (!historyPath) throw new Error('未找到原会话的可读取记录，请重新选择。');
      if (!await auxiliaryBotIsMember(this.deps.channel, row.chatId)) throw new Error('机器人已不在目标群内，无法关联。');
      const linkedSource: LinkedSession = { toolId: tool.id, sourceId: tool.sourceId, nativeId: source.nativeId, historyPath };
      const original = this.deps.bindings.entries().find(([, b]) => b.toolId === tool.id && b.sourceId === tool.sourceId && b.nativeId === source.nativeId)?.[1];
      const activated = await this.serial(`source:${this.sourceKey(linkedSource)}`, async () => {
        if (row.status !== 'pending' || row.generation !== choice.generation) return false;
        const peer = Object.values(this.records).find(r => r.chatId !== row.chatId && r.ownerId === row.ownerId && r.source &&
          this.sourceKey(r.source) === this.sourceKey(linkedSource) && (r.status === 'active' || (r.status === 'leaving' && !r.archivedNative)));
        const peerBinding = peer ? this.deps.bindings.get(peer.chatId) : undefined;
        const sharedScope = peerBinding?.sharedScope ?? `aux_${randomUUID()}`;
        const name = `FF-${source.name || source.nativeId}`;
        const shared = peerBinding ? { ...peerBinding, sharedScope: undefined, name } : { toolId: tool.id, sourceId: tool.sourceId, name,
          nativeId: tool.reserveSessionId?.(), nativeCreated: false, linkedSource,
          model: original?.model, reasoningEffort: original?.reasoningEffort };
        if (shared.nativeId === source.nativeId) throw new Error('辅助会话不能指向原会话');
        this.deps.bindings.set(sharedScope, shared);
        this.deps.bindings.linkAuxiliary(row.chatId, sharedScope);
        this.deps.sessions.remove(row.chatId);
        const cwd = peer?.cwd ?? workspace.cwdRealpath;
        this.deps.workspaces.setCwd(row.chatId, cwd);
        await Promise.all([this.deps.bindings.flush(), this.deps.sessions.flush(), this.deps.workspaces.flush()]);
        row.source = linkedSource; row.cwd = cwd; row.status = 'active';
        await this.save(); this.choices.delete(token); return true;
      });
      if (!activated) return;
      await this.deps.channel.send(row.ownerId, { text: `已关联「${row.name}」到 ${tool.label} 会话「${source.name || source.nativeId}」。` });
      await this.deps.channel.send(row.chatId, { text: '辅助已启用，请 @我提问。每次提问会先读取关联会话的最新进展。' });
    });
    return true;
  }
  async noteRequest(chatId: string, messageId: string, actorId: string): Promise<void> {
    const row = this.get(chatId); if (!row || row.status !== 'active') return;
    row.requesters = Object.fromEntries([...Object.entries(row.requesters ?? {}).filter(([k]) => k !== messageId), [messageId, actorId]].slice(-200));
    await this.save();
  }
  async trackRun(chatId: string, id: string, replyTo: string | undefined, active: boolean, actorId?: string): Promise<void> {
    const row = this.get(chatId); if (!row || row.status !== 'active') return;
    const actor = actorId ?? (replyTo ? row.requesters?.[replyTo] : undefined) ?? row.ownerId;
    if (active) {
      if (row.running?.id === id && row.running.actorId === actor) return;
      row.running = { id, actorId: actor };
    } else { if (row.running?.id !== id) return; delete row.running; }
    await this.save();
  }
  canStop(chatId: string, actor: string, runId?: unknown): boolean {
    const row = this.get(chatId);
    return !!row?.running && runId === row.running.id && (actor === row.ownerId || actor === row.running.actorId);
  }
  private isOwnerRequest(chatId: string, senderIds: readonly string[]): boolean {
    const ownerId = this.deps.ownerId();
    return !!ownerId && ownerId === this.get(chatId)?.ownerId && senderIds.length > 0 && senderIds.every(id => id === ownerId);
  }
  splitRequests<T extends { senderId: string }>(chatId: string, messages: readonly T[]): T[][] {
    const batches: T[][] = [];
    for (const message of messages) {
      const last = batches.at(-1);
      if (last && this.isOwnerRequest(chatId, [last[0]!.senderId]) === this.isOwnerRequest(chatId, [message.senderId])) last.push(message);
      else batches.push([message]);
    }
    return batches;
  }
  async wrapPrompt(chatId: string, message: string, senderIds: readonly string[] = []): Promise<string> {
    const row = this.get(chatId);
    if (!row || row.status !== 'active' || !row.source) throw new Error('辅助群尚未关联或已退出。');
    const source = row.source;
    let location = source.historyPath;
    try { await access(location); } catch { location = await findSessionHistory(source.toolId, source.sourceId, source.nativeId) ?? '当前记录不可读'; }
    // Recheck trusted metadata even though normal intake already splits permission classes.
    return wrapAuxiliaryPrompt(source, location, message, this.isOwnerRequest(chatId, senderIds));
  }
  async leave(chatId: string, actor: string, stop: () => Promise<void>): Promise<void> {
    await this.serial(`source:${this.get(chatId)?.source ? this.sourceKey(this.get(chatId)!.source!) : chatId}`, async () => {
      const row = this.get(chatId);
      if (!row || actor !== row.ownerId || row.status === 'archived') return;
      row.status = 'leaving'; await this.save();
      await this.deps.cancelPending(chatId); await stop();
      const binding = this.deps.bindings.get(chatId);
      if (!row.archivedNative && binding) {
        const sharedElsewhere = this.references(row).some(peer => peer.chatId !== chatId);
        const ids = new Set(this.deps.catalog?.entries().filter(e => e.scopeId === chatId && e.status === 'active')
          .map(e => e.threadId ?? e.sessionId).filter((x): x is string => !!x));
        if (binding.nativeCreated && binding.nativeId) ids.add(binding.nativeId);
        for (const id of ids) {
          if (id === row.source?.nativeId) throw new Error('拒绝归档关联原会话。');
          if (sharedElsewhere) continue;
          if (binding.toolId === 'codex') {
            const agent = this.deps.tools.get('codex').agent;
            if (!agent.archiveThread) throw new Error('当前 Codex 未提供原生归档能力。');
            await agent.archiveThread(id);
          }
          this.deps.bindings.archive(binding.toolId, binding.sourceId, id);
        }
        for (const entry of this.deps.catalog?.entries().filter(e => e.scopeId === chatId && e.status === 'active') ?? []) this.deps.catalog!.archiveActive(entry);
        await Promise.all([this.deps.bindings.flush(), this.deps.catalog?.flush()]);
        row.archivedNative = true; await this.save();
      }
      if (await auxiliaryBotIsMember(this.deps.channel, chatId)) {
        const result = await this.deps.channel.rawClient.im.v1.chatMembers.delete({
          path: { chat_id: chatId }, params: { member_id_type: 'app_id' },
          data: { id_list: [this.deps.appId] },
        });
        if (result.code || result.data?.invalid_id_list?.length) throw new Error('退群未确认，请稍后重试退出。');
      }
      this.deps.sessions.remove(chatId); this.deps.workspaces.removeCwd(chatId);
      await Promise.all([this.deps.sessions.flush(), this.deps.workspaces.flush()]);
      row.status = 'archived'; delete row.running; await this.save();
      await this.deps.channel.send(row.ownerId, { text: `已退出「${row.name}」。${this.references(row).length ? '其他关联群继续共用 FF 辅助会话。' : 'FF 辅助会话已归档。'}原会话保留。` });
    });
  }
}

export function wrapAuxiliaryPrompt(source: Pick<LinkedSession, 'toolId' | 'nativeId'>, location: string, message: string, ownerRequest = false): string {
  const permissions = ownerRequest
    ? '本次为所有者本人请求，按正常权限执行，不受辅助群只读、执行及源码外传限制；授权仅限本次请求。'
    : '本次按辅助群限制处理，历史放权不适用。本机只读，不执行项目脚本或构建；可在外部机器执行，脚本和产物可部署，其他源码及源码包不得外传。允许云端分析和回复必要代码片段。';
  return `先读取原会话 ${source.toolId}:${source.nativeId}（${JSON.stringify(location)}）的最新进展，再处理本次请求。历史仅作参考，不续跑旧任务、不修改原会话。\n` +
    permissions + '\n群内默认回复不超过200字、最多5行，先给结论和必要下一步；仅明确要求时详细展开，先写简短结论，空行后补充详情；不罗列思考过程、工具调用或日志。' +
    '\n回复不提及原会话、关联、同步或读取过程，不暴露会话ID和历史路径；记录不可读时仅说明“暂时无法获取相关背景”，勿假称已获取。\n\n本次请求：\n' + message;
}

export async function findSessionHistory(toolId: AgentKind, sourceId: string, nativeId: string): Promise<string | undefined> {
  if (!/^[\da-f-]{36}$/i.test(nativeId)) return undefined;
  const roots = toolId === 'claude' ? [join(sourceId, 'projects')] : [join(sourceId, 'sessions'), join(sourceId, 'archived_sessions')];
  async function walk(dir: string, depth: number): Promise<string | undefined> {
    let files; try { files = await readdir(dir, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    for (const f of files) {
      if (f.isFile() && (f.name === `${nativeId}.jsonl` || f.name.endsWith(`-${nativeId}.jsonl`))) return join(dir, f.name);
      if (f.isDirectory() && depth < 4) { const found = await walk(join(dir, f.name), depth + 1); if (found) return found; }
    }
  }
  for (const root of roots) { const found = await walk(root, 0); if (found) return found; }
}
