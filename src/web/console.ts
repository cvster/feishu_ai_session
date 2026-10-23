import { createHash } from 'node:crypto';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../commands';
import type { SessionCatalog } from '../session/catalog';
import type { AgentKind } from '../config/profile-schema';
import type { ToolSession } from '../tools/types';
import { isPersonalWorkgroup } from '../tools/bindings';
import { DurableAgentAdapter } from '../worker/adapter';
import type { WorkerJob } from '../worker/protocol';
import type { HealthDetails } from '../worker/client';
import { log, readRecentLogs, redactDiagnosticText } from '../core/logger';
import { PersonalSessionService, WebError } from './service';

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
    syncNames?(toolId?: string): Promise<void>; logs?(): Promise<string> }) {}
  private owner() { return this.deps.personal.ownerIdentity(); }
  async snapshot(force = false) {
    this.owner();
    if (this.running) return this.running;
    if (!force && this.cached && Date.now() - this.cached.at < 10_000) return this.cached.value;
    this.running = this.collect().then(value => { this.cached = { at: Date.now(), value }; return value; }).finally(() => { this.running = undefined; });
    return this.running;
  }
  private async collect() {
    const owner = this.owner(), c = this.deps.controls, entries = c.toolBindings?.entries() ?? [];
    const ids = new Set([...c.toolRegistry?.all().map(t => t.id) ?? [], ...entries.map(([, b]) => b.toolId), ...c.workerRuntimes?.keys() ?? []]);
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
    const chats = new Map<string, { name?: string; mode?: string; error?: string }>();
    const chatIds = [...new Set(entries.map(([scope]) => scope.split(':')[0]!).filter(id => id.startsWith('oc_')))];
    // Limit Feishu fan-out while inspecting many bindings.
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(6, chatIds.length) }, async () => {
      while (index < chatIds.length) {
        const id = chatIds[index++]!;
        try {
          const r = await this.deps.channel.rawClient.im.v1.chat.get({ path: { chat_id: id } });
          if (r.code || !r.data) throw new Error(r.msg || '群信息未确认');
          chats.set(id, { name: r.data.name, mode: r.data.chat_mode });
        } catch (e) { chats.set(id, { error: clean(e instanceof Error ? e.message : e) }); }
      }
    }));
    const personalRows = await this.deps.personal.list();
    const bindings = entries.filter(([scope]) => scope.startsWith('oc_')).map(([scope, b]) => {
      const ref = b.linkedSource ?? b, o = this.observations.get(b.toolId), group = chats.get(scope.split(':')[0]!);
      const native = o?.sourceId === b.sourceId ? o.native.find(r => r.nativeId === ref.nativeId) : undefined;
      const catalog = this.deps.catalog?.entries().find(r => r.scopeId === scope && r.status === 'active' && r.agentId === b.toolId &&
        (!r.sourceId || r.sourceId === b.sourceId) && (r.threadId ?? r.sessionId) === ref.nativeId);
      const personal = isPersonalWorkgroup(scope, b), archived = this.deps.catalog?.isScopeArchived(scope) ||
        (ref.nativeId && c.toolBindings?.isArchived(ref.toolId, ref.sourceId, ref.nativeId)) || native?.archived;
      const issues = [group?.error ? '群状态未确认' : '', o?.sourceId && o.sourceId !== b.sourceId ? 'Worker 身份不匹配' : '',
        !o?.online ? 'Worker 离线' : '', archived ? '会话已归档' : '',
        o?.online && !o.nativeKnown ? '原生会话状态未确认' : '',
        personal && native?.name && group?.name && native.name !== group.name ? '群名与会话名不一致' : '',
        o?.online && o.nativeKnown && o.health?.capabilities?.sessionListAuthoritative && !native && b.nativeCreated !== false ? '原生会话不存在' : ''].filter(Boolean);
      return { id: hash([scope, b]), scope, chatId: scope.split(':')[0]!, toolId: b.toolId, tool: o?.label ?? b.toolId,
        kind: personal ? '个人 AI 群' : scope.includes(':') ? '话题会话' : '共享群', nativeId: ref.nativeId,
        groupName: group?.name ?? b.name ?? scope, sessionName: native?.name ?? b.name ?? ref.nativeId ?? '尚未创建',
        cwd: native?.cwd ?? catalog?.cwdRealpath ?? '', issues,
        sessionId: personalRows.find(s => s.scope === scope)?.id,
        canSync: !!this.deps.syncNames && personal && !archived && o?.online === true && o.nativeKnown && !!native && o.sourceId === b.sourceId && group?.mode === 'group' && o.health?.capabilities?.nativeSessionNames === true };
    });
    const items = this.items();
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
        failed: allJobs.filter(j => ['failed', 'unknown'].includes(j.status)).length }, workers, bindings,
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
  async logs(q = '', level = '') {
    this.owner();
    if (q.length > 1000 || !['', 'info', 'warn', 'error'].includes(level)) throw new WebError(400, '日志筛选无效');
    const raw = await (this.deps.logs?.() ?? readRecentLogs({ maxBytes: 512_000 }));
    return raw.split('\n').flatMap(line => {
      try {
        const r = JSON.parse(line), fields: Record<string, string> = {};
        for (const k of ['scope', 'chatId', 'msgId', 'messageId', 'jobId', 'toolId', 'threadId', 'sessionId', 'code', 'reason', 'error', 'err', 'step', 'traceId'])
          if (typeof r[k] === 'string') fields[k] = clean(r[k]);
        const row = { at: String(r.ts ?? ''), level: String(r.level ?? ''), phase: clean(r.phase), event: clean(r.event), fields };
        return (!level || row.level === level) && (!q || JSON.stringify(row).toLowerCase().includes(q.toLowerCase())) ? [row] : [];
      } catch { return []; }
    }).slice(-300).reverse();
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
    return { item, timeline: timeline.slice(-100), logs: await this.logs(item.scope) };
  }
  async action(action: string, id?: string) {
    this.owner(); const key = action + ':' + (id ?? '');
    if (this.actions.has(key)) return this.actions.get(key);
    const task = this.perform(action, id).finally(() => { this.actions.delete(key); this.cached = undefined; });
    this.actions.set(key, task); return task;
  }
  private async perform(action: string, id?: string) {
    const c = this.deps.controls;
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
}
