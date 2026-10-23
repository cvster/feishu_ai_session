import { createHash } from 'node:crypto';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../commands';
import type { SessionCatalog } from '../session/catalog';
import type { AgentKind } from '../config/profile-schema';
import type { ToolSession } from '../tools/types';
import { isPersonalWorkgroup } from '../tools/bindings';
import { DurableAgentAdapter } from '../worker/adapter';
import { isJobActive, type WorkerJob } from '../worker/protocol';
import type { HealthDetails } from '../worker/client';
import { log, redactDiagnosticText } from '../core/logger';
import { PersonalSessionService, WebError } from './service';
import { describeChatDeletionError, dissolveChat } from '../bot/group';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const clean = (v: unknown) => redactDiagnosticText(String(v ?? '')).replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]').slice(0, 2000);
const jobScope = (j: WorkerJob) => j.options.delivery?.scope ?? '';
interface Observation { id: AgentKind; label: string; sourceId?: string; online: boolean; checkedAt: number; error?: string; health?: HealthDetails; jobsKnown: boolean; nativeKnown: boolean; jobs: WorkerJob[]; native: ToolSession[] }
export interface ConsoleItem {
  id: string; toolId: string; tool: string; scope: string; name: string; sender: string; text: string;
  status: string; createdAt: number; updatedAt: number; retryAt?: number; reason?: string; canRetry: boolean; jobId?: string;
}

/** Read-only observations and existing maintenance paths; no provider protocols or new job writer. */
export class BridgeConsoleService {
  private observations = new Map<string, Observation>();
  private cached?: { at: number; value: Awaited<ReturnType<BridgeConsoleService['collect']>> };
  private running?: Promise<Awaited<ReturnType<BridgeConsoleService['collect']>>>;
  private actions = new Map<string, Promise<unknown>>();
  constructor(private deps: { controls: Controls; catalog?: SessionCatalog; channel: LarkChannel; personal: PersonalSessionService;
    syncNames?(toolId?: string): Promise<void>; cleanDissolvedGroup?(chatId: string): Promise<void> }) {}
  private owner() { return this.deps.personal.ownerIdentity(); }
  private groupId(row: { chatId: string; generation: string; ownerId: string }) {
    return hash([this.deps.controls.profile, this.deps.controls.profileConfig.accounts.app.id, row.chatId, row.generation, row.ownerId]);
  }
  private targetId(toolId: string, sourceId: string, nativeId: string) {
    return hash([this.deps.controls.profile, this.deps.controls.profileConfig.accounts.app.id, toolId, sourceId, nativeId]);
  }
  async snapshot(force = false) {
    this.owner();
    if (this.running) return this.running;
    if (!force && this.cached && Date.now() - this.cached.at < 10_000) return this.cached.value;
    this.running = this.collect().then(value => { this.cached = { at: Date.now(), value }; return value; }).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async collect() {
    const owner = this.owner(), c = this.deps.controls, entries = c.toolBindings?.entries() ?? [], sharedRows = c.auxiliary?.groups?.() ?? [];
    const dissolved = (this.deps.catalog?.dissolvedPersonalGroups() ?? []).filter(r => !c.auxiliary?.isAuxiliary(r.chatId) &&
      (!r.botAppId || r.botAppId === c.profileConfig.accounts.app.id));
    const ids = new Set([...dissolved.map(r => r.agentId), ...c.toolRegistry?.all().map(t => t.id) ?? [], ...entries.map(([, b]) => b.toolId), ...c.workerRuntimes?.keys() ?? []]);
    for (const id of this.observations.keys()) if (!ids.has(id as AgentKind)) this.observations.delete(id);
    await Promise.all([...ids].map(async id => {
      const tool = c.toolRegistry?.find(id), previous = this.observations.get(id);
      const o: Observation = { id, label: tool?.label ?? previous?.label ?? id, sourceId: tool?.sourceId ?? previous?.sourceId,
        online: false, checkedAt: Date.now(), jobsKnown: false, nativeKnown: false, jobs: [], native: [] };
      try {
        if (!(tool?.agent instanceof DurableAgentAdapter)) throw new Error('Worker 未发现或离线');
        o.health = await tool.agent.client.health();
        o.online = true;
        const [jobs, native] = await Promise.allSettled([tool.agent.client.list(), o.health.capabilities?.sessions.list ? tool.listSessions() : []]);
        const errors: string[] = [];
        if (jobs.status === 'fulfilled') { o.jobs = jobs.value.filter(j => j.options.delivery?.sourceId === tool.sourceId && j.options.delivery.botAppId === c.profileConfig.accounts.app.id); o.jobsKnown = true; }
        else errors.push('任务读取失败：' + clean(jobs.reason));
        if (native.status === 'fulfilled') { o.native = native.value; o.nativeKnown = o.health.capabilities?.sessions.list === true; }
        else errors.push('会话读取失败：' + clean(native.reason));
        o.error = errors.join('；') || undefined;
      } catch (e) { o.error = clean(e instanceof Error ? e.message : e); }
      this.observations.set(id, o);
    }));
    const chats = new Map<string, { name?: string; mode?: string; status?: string; error?: string }>();
    const chatIds = [...new Set([...entries.map(([scope]) => scope.split(':')[0]!), ...sharedRows.map(row => row.chatId), ...dissolved.map(r => r.chatId)].filter(id => id.startsWith('oc_')))];
    // Limit Feishu fan-out while inspecting many bindings.
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(6, chatIds.length) }, async () => {
      while (index < chatIds.length) {
        const id = chatIds[index++]!;
        if (this.deps.catalog?.isChatDissolved(id)) { chats.set(id, { status: 'dissolved' }); continue; }
        try {
          const r = await this.deps.channel.rawClient.im.v1.chat.get({ path: { chat_id: id } });
          if (r.code === 232009) { chats.set(id, { status: 'dissolved' }); continue; }
          if (r.code || !r.data) throw new Error(r.msg || '群信息未确认');
          chats.set(id, { name: r.data.name, mode: r.data.chat_mode, status: r.data.chat_status });
        } catch (e) {
          const failure = e as { code?: number; response?: { data?: { code?: number } } };
          chats.set(id, (failure?.response?.data?.code ?? failure?.code) === 232009 ? { status: 'dissolved' } : { error: clean(e instanceof Error ? e.message : e) });
        }
      }
    }));
    const personalRows = await this.deps.personal.list();
    const personalBindings = entries.filter(([scope, b]) => isPersonalWorkgroup(scope, b) && !c.auxiliary?.isAuxiliary(scope));
    const refs = personalBindings.map(([scope, b]) => {
      const catalog = this.deps.catalog?.entries().filter(r => r.scopeId === scope && r.agentId === b.toolId &&
        (!r.botAppId || r.botAppId === c.profileConfig.accounts.app.id) && (!r.sourceId || r.sourceId === b.sourceId) &&
        (r.threadId ?? r.sessionId) === b.nativeId).sort((a, z) => (z.boundAt ?? z.updatedAt) - (a.boundAt ?? a.updatedAt))[0];
      return { scope, toolId: b.toolId, sourceId: b.sourceId, nativeId: b.nativeId, name: b.name,
        cwd: catalog?.cwdRealpath, revision: hash([scope, b, catalog?.boundAt]) };
    });
    for (const r of dissolved) if (!refs.some(b => b.scope === r.chatId)) refs.push({ scope: r.chatId, toolId: r.agentId, sourceId: r.sourceId,
      nativeId: r.nativeId, name: r.name, cwd: r.cwd, revision: hash(r) });
    const bindings = refs.map(b => {
      const o = this.observations.get(b.toolId), group = chats.get(b.scope);
      const native = o?.sourceId === b.sourceId && o.nativeKnown ? o.native.find(r => r.nativeId === b.nativeId) : undefined;
      // Route archival includes dissolution. It cannot establish native archival.
      const archived = native ? native.archived === true : b.nativeId && c.toolBindings?.isArchived(b.toolId, b.sourceId, b.nativeId) ? true : undefined;
      const groupState = ['dissolved', 'dissolved_save'].includes(group?.status ?? '') ? 'dissolved' :
        group && !group.error && group.mode === 'group' && (!group.status || group.status === 'normal') ? 'active' : 'unknown';
      const sessionState = archived === true ? 'archived' : native ? 'active' : 'unknown';
      const issues = [groupState === 'unknown' ? '群状态未确认' : '', o?.sourceId && o.sourceId !== b.sourceId ? 'Worker 身份不匹配' : '',
        !o?.online ? 'Worker 离线' : '', sessionState === 'unknown' ? '原生会话状态未确认' : '',
        groupState === 'active' && sessionState === 'active' && native?.name && group?.name && native.name !== group.name ? '群名与会话名不一致' : '',
        o?.online && o.nativeKnown && o.health?.capabilities?.sessionListAuthoritative && !native ? '原生会话不存在或已移出列表' : ''].filter(Boolean);
      return { id: hash([c.profile, c.profileConfig.accounts.app.id, b.revision]), scope: b.scope, chatId: b.scope, toolId: b.toolId, sourceId: b.sourceId, tool: o?.label ?? b.toolId,
        kind: '个人 AI 群', nativeId: b.nativeId, groupName: group?.name ?? b.name ?? native?.name ?? b.scope,
        sessionName: native?.name ?? b.name ?? b.nativeId ?? '尚未创建', cwd: native?.cwd ?? b.cwd ?? '', issues, groupState, sessionState,
        sessionId: groupState === 'active' && sessionState === 'active' ? personalRows.find(s => s.scope === b.scope)?.id : undefined,
        canDissolve: !!this.deps.cleanDissolvedGroup && groupState === 'active' && sessionState === 'archived' &&
          o?.online === true && o.nativeKnown && o.sourceId === b.sourceId,
        canArchive: !!this.deps.cleanDissolvedGroup && groupState === 'dissolved' && sessionState === 'active' && o?.online === true && o.sourceId === b.sourceId &&
          o.health?.capabilities?.sessions.archive === true && c.toolRegistry?.find(b.toolId)?.sessions?.nativeArchive === true,
        canSync: !!this.deps.syncNames && groupState === 'active' && sessionState === 'active' && o?.online === true && o.nativeKnown && !!native &&
          o.sourceId === b.sourceId && o.health?.capabilities?.nativeSessionNames === true };
    });
    const items = this.items();
    const sharedTargets = [...this.observations.values()].flatMap(o => o.online && o.nativeKnown && o.sourceId ?
      o.native.filter(s => c.auxiliary?.shareable?.(o.id, o.sourceId!, s)).map(s => ({ id: this.targetId(o.id, o.sourceId!, s.nativeId),
        toolId: o.id, tool: o.label, name: s.name || s.nativeId, cwd: s.cwd, updatedAt: s.updatedAtMs })) : [])
      .sort((a, b) => Number(b.name.trimStart().startsWith('AA')) - Number(a.name.trimStart().startsWith('AA')) || b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
    const sharedGroups = sharedRows.map(row => {
      const group = chats.get(row.chatId), ref = row.source, o = ref && this.observations.get(ref.toolId);
      const native = o?.sourceId === ref?.sourceId ? o?.native.find(s => s.nativeId === ref?.nativeId) : undefined;
      const binding = c.toolBindings?.get(row.chatId), connected = ['group', 'topic'].includes(group?.mode ?? '') && (!group?.status || group.status === 'normal');
      const routeWorker = binding ? this.observations.get(binding.toolId) : undefined;
      const busy = items.some(i => i.scope === row.chatId && ['pending', 'queued', 'accepted', 'running'].includes(i.status));
      const issues = [group?.error && row.status !== 'archived' ? '群状态未确认' : '',
        row.status === 'active' && this.deps.catalog?.isScopeArchived(row.chatId) ? '本群入口已归档' : '',
        !connected && !group?.error && row.status !== 'archived' ? '机器人不在群内或群已关闭' : '',
        ref && row.status !== 'archived' && !o?.online ? 'Worker 离线' : '',
        ref && o?.online && o.sourceId !== ref.sourceId ? 'Worker 身份不匹配' : '',
        ref && o?.online && !o.nativeKnown ? '原生会话状态未确认' : '',
        native?.archived || ref && c.toolBindings?.isArchived(ref.toolId, ref.sourceId, ref.nativeId) ? '会话已归档' : '',
        ref && o?.nativeKnown && o.health?.capabilities?.sessionListAuthoritative && !native ? '原生会话不存在' : ''].filter(Boolean);
      return { id: this.groupId(row), chatId: row.chatId, name: group?.name ?? row.name, status: row.status,
        active: c.auxiliary!.isActive(row.chatId), kind: row.privateGroup ? '私聊群' : '共享群',
        toolId: ref?.toolId, tool: o?.label ?? ref?.toolId ?? '未选择', sessionName: native?.name ?? (binding?.nativeId === ref?.nativeId ? binding?.name : undefined) ?? ref?.nativeId ?? '尚未关联',
        associationId: ref ? this.targetId(ref.toolId, ref.sourceId, ref.nativeId) : undefined,
        targetId: row.status === 'active' && ref ? this.targetId(ref.toolId, ref.sourceId, ref.nativeId) : undefined, cwd: native?.cwd ?? row.cwd ?? '',
        parentChatId: row.privateGroup?.parentChatId, issues, busy,
        sessionId: ref ? personalRows.find(s => { const b = c.toolBindings?.get(s.scope); return b?.toolId === ref.toolId && b.sourceId === ref.sourceId && b.nativeId === ref.nativeId; })?.id : undefined,
        canBind: row.ownerId === owner && !row.privateGroup && ['pending', 'active'].includes(row.status) && connected && !this.deps.catalog?.isChatDissolved(row.chatId) &&
          !busy && (!binding || routeWorker?.online === true && routeWorker.jobsKnown && binding.sourceId === routeWorker.sourceId),
        canLeave: row.ownerId === owner && row.status !== 'archived' };
    });
    const allJobs = [...this.observations.values()].flatMap(o => o.jobs);
    const workers = [...ids].map(id => {
      const o = this.observations.get(id)!;
      return { id, label: o.label, online: o.online, checkedAt: o.checkedAt, error: o.error,
        capabilities: o.health?.capabilities, sessions: o.native.length, active: o.jobs.filter(j => ['accepted', 'running'].includes(j.status)).length,
        pending: items.filter(i => i.toolId === id && ['queued', 'pending'].includes(i.status)).length };
    });
    if (this.owner() !== owner) throw new WebError(409, '所有者已变化，请刷新');
    return { at: Date.now(), bridge: { profile: c.profile, uptimeSeconds: Math.floor(process.uptime()),
      connection: this.deps.channel.getConnectionStatus?.()?.state ?? 'unknown' },
      summary: { workers: workers.length, online: workers.filter(w => w.online).length, bindings: bindings.length,
        pending: items.filter(i => ['pending', 'queued'].includes(i.status)).length, active: allJobs.filter(j => ['accepted', 'running'].includes(j.status)).length,
        failed: allJobs.filter(j => ['failed', 'unknown'].includes(j.status)).length, sharedGroups: sharedGroups.length }, workers, bindings, sharedGroups, sharedTargets,
      items: items.sort((a, b) => Number(['pending', 'queued', 'accepted', 'running'].includes(b.status)) - Number(['pending', 'queued', 'accepted', 'running'].includes(a.status)) || b.createdAt - a.createdAt).slice(0, 300),
      canDiscover: !!c.refreshWorkerDiscovery, canSync: !!this.deps.syncNames };
  }
  private items(): ConsoleItem[] {
    const c = this.deps.controls, result: ConsoleItem[] = [];
    for (const [id, runtime] of c.workerRuntimes ?? []) {
      const o = this.observations.get(id), receipts = runtime.inbox.diagnostics();
      for (const r of receipts) {
        const b = c.toolBindings?.get(r.scope), jobs = o?.jobs ?? [];
        const job = jobs.find(j => jobScope(j) === r.scope && j.options.delivery?.messageIds?.includes(r.requestId));
        const status = job?.status ?? (r.status === 'pending' ? r.queued ? 'queued' : 'pending' : r.status === 'accepted' ? 'accepted_unconfirmed' : 'rejected');
        result.push({ id: hash([c.profile, id, r.scope, r.requestId]), toolId: id, tool: o?.label ?? id, scope: r.scope,
          name: b?.name ?? r.scope, sender: r.message.senderName ?? r.message.senderId ?? '', text: r.message.content.slice(0, 2000),
          status, createdAt: Number(r.message.createTime) || 0, updatedAt: job?.updatedAt ?? r.diagnostic?.at ?? (Number(r.message.createTime) || 0),
          retryAt: r.retryAt, jobId: job?.id, reason: clean(job ? job.error : r.diagnostic?.message),
          canRetry: r.status === 'pending' && !r.queued && !job && !!runtime.replies && o?.online === true && o.jobsKnown && b?.sourceId === o.sourceId &&
            !this.deps.catalog?.isScopeArchived(r.scope) && (!c.auxiliary?.isAuxiliary(r.scope) || c.auxiliary.isActive(r.scope)) });
      }
      for (const job of o?.jobs ?? []) if (!receipts.some(r => r.scope === jobScope(job) && job.options.delivery?.messageIds?.includes(r.requestId))) {
        result.push({ id: hash([c.profile, id, job.id]), toolId: id, tool: o!.label, scope: jobScope(job), name: c.toolBindings?.get(jobScope(job))?.name ?? jobScope(job),
          sender: '', text: '原始消息记录不可用', status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt, jobId: job.id, reason: clean(job.error), canRetry: false });
      }
    }
    return result;
  }
  async detail(id: string) {
    await this.snapshot(true); const item = this.items().find(i => i.id === id);
    if (!item) throw new WebError(404, '消息记录不存在');
    const timeline = [{ at: item.createdAt, title: '桥接收到消息', detail: item.sender }];
    const o = this.observations.get(item.toolId), job = o?.jobs.find(j => j.id === item.jobId);
    if (job) {
      timeline.push({ at: job.createdAt, title: '提交 worker，已取得持久回执', detail: job.id });
      const tool = this.deps.controls.toolRegistry?.find(o!.id);
      if (tool?.agent instanceof DurableAgentAdapter) {
        const snap = await tool.agent.client.snapshot(job.id);
        for (const row of snap.events) if (row.event.type === 'system' || row.event.type === 'done' || row.event.type === 'error')
          timeline.push({ at: row.at, title: row.event.type === 'system' ? '工具状态确认' : row.event.type === 'done' ? '工具响应结束' : '执行异常',
            detail: row.event.type === 'error' ? clean(row.event.message) : row.event.type === 'done' ? row.event.terminationReason ?? '' : row.event.turnId ?? row.event.threadId ?? row.event.sessionId ?? '' });
      }
    }
    if (item.reason) timeline.push({ at: item.updatedAt, title: '最近处理原因', detail: item.reason });
    return { item, timeline: timeline.slice(-100) };
  }
  async action(action: string, id?: string, target?: string) {
    this.owner(); const key = action + ':' + (id ?? '') + ':' + (target ?? '');
    if (this.actions.has(key)) return this.actions.get(key);
    const task = this.perform(action, id, target).finally(() => { this.actions.delete(key); this.cached = undefined; });
    this.actions.set(key, task); return task;
  }
  private async perform(action: string, id?: string, target?: string) {
    const c = this.deps.controls;
    if (['personal-dissolve', 'personal-archive'].includes(action) && id && c.toolBindings) {
      const owner = this.owner(), row = (await this.snapshot(true)).bindings.find(b => b.id === id);
      if (!row?.nativeId) throw new WebError(409, 'AI会话群关联已变化，请刷新');
      const run = () => c.toolBindings!.withPersonalBinding({ toolId: row.toolId, sourceId: row.sourceId, nativeId: row.nativeId! }, async () => {
        const current = (await this.snapshot(true)).bindings.find(b => b.id === id);
        if (this.owner() !== owner || !current || !(action === 'personal-dissolve' ? current.canDissolve : current.canArchive))
          throw new WebError(409, '会话或群状态已变化，当前不可执行，请刷新');
        try {
          if (action === 'personal-dissolve') {
            await dissolveChat(this.deps.channel, current.chatId);
            await this.deps.cleanDissolvedGroup!(current.chatId);
          } else {
            const tool = c.toolRegistry?.find(current.toolId);
            if (!tool?.sessions?.nativeArchive || tool.sourceId !== current.sourceId) throw new WebError(409, 'Worker 身份或归档能力已变化');
            // Close the proven-dead route first; never queue an archive notice to a dissolved chat.
            if (c.toolBindings!.get(current.chatId)) await this.deps.cleanDissolvedGroup!(current.chatId);
            await tool.sessions.archive(current.nativeId!);
            c.toolBindings!.archive(current.toolId, current.sourceId, current.nativeId!);
            this.deps.catalog?.archiveNativeSession(current.toolId, current.nativeId!, current.sourceId, true);
            await Promise.all([c.toolBindings!.flush(), this.deps.catalog?.flush()]);
          }
        } catch (e) {
          if (e instanceof WebError) throw e;
          throw new WebError(409, clean(action === 'personal-dissolve' ? describeChatDeletionError(e) : e instanceof Error ? e.message : e));
        }
        log.info('console', action, { scope: current.chatId }); return { ok: true };
      });
      return c.withAaSessionGroupSyncPaused?.(run) ?? run();
    }
    if (['shared-bind', 'shared-leave'].includes(action) && id && c.auxiliary) {
      const owner = this.owner(), snapshot = await this.snapshot(true), row = c.auxiliary.groups().find(r => this.groupId(r) === id);
      if (!row || row.ownerId !== owner || this.owner() !== owner) throw new WebError(409, '共享群关联或所有者已变化，请刷新');
      try {
        if (action === 'shared-leave') {
          if (row.status === 'archived') return { ok: true };
          await c.auxiliary.leave(row.chatId, owner, async () => {
            const b = c.toolBindings?.get(row.chatId);
            if (b) {
              const replies = c.workerRuntimes?.get(b.toolId)?.replies;
              if (!replies) throw new WebError(503, 'Worker 暂不可用，退出尚未完成，请稍后重试');
              await replies.stopScope(row.chatId);
            }
          }, row.generation);
        } else {
          if (!target || !snapshot.sharedTargets.some(s => s.id === target) || !snapshot.sharedGroups.find(g => g.id === id)?.canBind)
            throw new WebError(409, '此共享群或目标会话当前不可切换，请刷新');
          const o = [...this.observations.values()].find(o => o.sourceId && o.native.some(s => this.targetId(o.id, o.sourceId!, s.nativeId) === target))!;
          const native = o.native.find(s => this.targetId(o.id, o.sourceId!, s.nativeId) === target)!;
          await c.auxiliary.bindSession(row.chatId, owner, row.generation, { toolId: o.id, sourceId: o.sourceId!, nativeId: native.nativeId }, async () => {
            if (this.owner() !== owner) throw new WebError(409, '所有者已变化，请刷新');
            await this.assertSharedIdle(row.chatId);
          });
        }
      } catch (e) { if (e instanceof WebError) throw e; throw new WebError(409, clean(e instanceof Error ? e.message : e)); }
      log.info('console', action, { scope: row.chatId }); return { ok: true };
    }
    if (action === 'discover' && c.refreshWorkerDiscovery) { await c.refreshWorkerDiscovery(); log.info('console', 'workers-refreshed'); return { ok: true }; }
    if (action === 'sync-names' && this.deps.syncNames) {
      const snapshot = await this.snapshot(true), b = id ? snapshot.bindings.find(b => b.id === id && b.canSync) : undefined;
      if (id && !b) throw new WebError(409, '此关联当前不可同步');
      await this.deps.syncNames(b?.toolId); log.info('console', 'names-sync-requested', { scope: b?.scope }); return { ok: true };
    }
    if (action === 'retry' && id) {
      await this.snapshot(true); const item = this.items().find(i => i.id === id);
      if (!item?.canRetry) throw new WebError(409, '只能重试尚未提交且未进入处理队列的消息');
      const runtime = c.workerRuntimes!.get(item.toolId as AgentKind)!, o = this.observations.get(item.toolId)!;
      await runtime.inbox.reconcile(o.jobs);
      const receipt = runtime.inbox.diagnostics().find(r => hash([c.profile, item.toolId, r.scope, r.requestId]) === id);
      if (!receipt || !runtime.inbox.retryPending(receipt.scope, receipt.requestId)) throw new WebError(409, '消息已接收或正在处理，未重复提交');
      log.info('console', 'retry-requested', { scope: item.scope, msgId: receipt.message.messageId });
      await runtime.replies!.runNow(); return { ok: true };
    }
    throw new WebError(400, '操作不支持');
  }
  private async assertSharedIdle(scope: string) {
    const c = this.deps.controls, b = c.toolBindings?.get(scope);
    for (const runtime of c.workerRuntimes?.values() ?? []) if (runtime.inbox.diagnostics().some(r => r.scope === scope && r.status === 'pending'))
      throw new WebError(409, '本群还有未处理消息，请处理完成后再切换');
    if (!b) return;
    const tool = c.toolRegistry?.find(b.toolId);
    if (!(tool?.agent instanceof DurableAgentAdapter) || tool.sourceId !== b.sourceId) throw new WebError(409, '无法确认本群任务状态，请稍后重试');
    const jobs = (await tool.agent.client.list()).filter(j => jobScope(j) === scope && j.options.delivery?.sourceId === b.sourceId && j.options.delivery.botAppId === c.profileConfig.accounts.app.id);
    for (const runtime of c.workerRuntimes?.values() ?? []) if (runtime.inbox.diagnostics().some(r => r.scope === scope && r.status === 'pending'))
      throw new WebError(409, '本群还有未处理消息，请处理完成后再切换');
    if (jobs.some(isJobActive)) throw new WebError(409, '本群任务尚未完成，请处理后再切换');
  }
}
