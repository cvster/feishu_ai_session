import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../commands';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { ActiveRuns, RunHandle } from '../bot/active-runs';
import { writeFileAtomic } from '../platform/atomic-write';
import { initialState, reduce, startRunRuntime, updateRunRuntime } from '../card/run-state';
import { renderCard, type RunCardRenderOptions } from '../card/run-renderer';
import { renderText } from '../card/text-renderer';
import { getMessageReplyMode, getShowToolCalls } from '../config/schema';
import { log } from '../core/logger';
import { DurableAgentAdapter } from './adapter';
import { isJobActive, type WorkerJob } from './protocol';

interface ReplyDelivery {
  mode: 'card' | 'markdown' | 'text';
  cardId?: string;
  messageId?: string;
  sequence: number;
  lastEvent: number;
  pushedAt: number;
  sendingSince?: number;
  finished?: boolean;
  skipped?: boolean;
}
export interface WorkerRepliesDeps {
  adapter: DurableAgentAdapter;
  channel: LarkChannel;
  controls: Controls;
  sessions: SessionStore;
  catalog: SessionCatalog;
  activeRuns: ActiveRuns;
  statePath: string;
  intervalMs?: number;
  renderOptions?(job: WorkerJob): RunCardRenderOptions;
  onReady?(jobs: WorkerJob[]): Promise<void>;
}

/** Sole worker IM reply writer; reconstructs output from the worker journal. */
export async function startWorkerReplies(deps: WorkerRepliesDeps) {
  let deliveries: Record<string, ReplyDelivery> = {};
  try {
    const raw = JSON.parse(await readFile(deps.statePath, 'utf8'));
    if (raw.version !== 1 || !raw.deliveries || Array.isArray(raw.deliveries)) throw new Error('Invalid worker reply ledger');
    deliveries = raw.deliveries;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const save = () => writeFileAtomic(deps.statePath, `${JSON.stringify({ version: 1, deliveries })}\n`, { mode: 0o600 });
  const recovered = new Map<string, { handle: RunHandle; scope: string }>();
  let stopped = false;
  let running: Promise<void> | undefined;
  let lastWarning = 0;
  async function sync(): Promise<void> {
    const jobs = await deps.adapter.client.list();
    for (const job of jobs) {
      if (stopped || !job.options.delivery) continue;
      try { await publish(job); } catch (error) { log.warn('worker-replies', 'publish-failed', { toolId: deps.adapter.id, jobId: job.id, error: error instanceof Error ? error.message : String(error) }); }
    }
    if (!stopped) await deps.onReady?.(jobs);
  }
  async function publish(job: WorkerJob): Promise<void> {
    const target = job.options.delivery!;
    if (deps.controls.auxiliary?.isAuxiliary(target.scope) && !deps.controls.auxiliary.isActive(target.scope)) return;
    const observer = recovered.get(job.id);
    if (!isJobActive(job) && observer) {
      deps.activeRuns.unregister(target.scope, observer.handle.run); recovered.delete(job.id);
    }
    if (target.botAppId !== deps.controls.profileConfig.accounts.app.id || target.sourceId !== deps.adapter.client.sourceId) return;
    const binding = deps.controls.toolBindings?.get(target.scope);
    const originalNative = job.options.sessionId ?? job.options.initialSessionId;
    if (!binding || binding.toolId !== deps.adapter.id || binding.sourceId !== target.sourceId ||
      (originalNative && binding.nativeId && originalNative !== binding.nativeId) || deps.catalog.isScopeArchived(target.scope)) {
      if (deliveries[job.id] && !deliveries[job.id]!.skipped) { deliveries[job.id]!.skipped = true; await save(); }
      return;
    }
    if (isJobActive(job) && !deps.activeRuns.get(target.scope)) {
      const run = deps.adapter.observe(job.id);
      recovered.set(job.id, { handle: deps.activeRuns.register(target.scope, run), scope: target.scope });
    }
    if (deliveries[job.id]?.finished || deliveries[job.id]?.skipped) return;
    const snapshot = await deps.adapter.client.snapshot(job.id);
    const init = snapshot.events.find(row => row.event.type === 'system' && row.event.sessionId)?.event;
    if (init?.type === 'system' && init.sessionId && (binding.nativeId !== init.sessionId || !binding.nativeCreated)) {
      const sessionId = init.sessionId;
      deps.controls.toolBindings!.set(target.scope, { ...binding, nativeId: sessionId, nativeCreated: true });
      deps.sessions.set(target.scope, sessionId, job.options.cwd ?? '');
      deps.catalog.upsertActive({ scopeId: target.scope, agentId: binding.toolId, cwdRealpath: job.options.cwd!,
        policyFingerprint: target.policyFingerprint, sessionId, sourceId: target.sourceId, botAppId: target.botAppId });
      await Promise.all([deps.controls.toolBindings!.flush(), deps.sessions.flush(), deps.catalog.flush()]);
    }
    let state = startRunRuntime(initialState, job.createdAt);
    for (const row of snapshot.events) state = reduce(state, row.event);
    state = updateRunRuntime(state, { nowMs: Date.now(), processRunning: isJobActive(snapshot.job) });
    if (!getShowToolCalls(deps.controls.cfg)) state = { ...state, blocks: state.blocks.filter(block => block.kind !== 'tool') };
    if (deps.controls.auxiliaryApprovals) state = await deps.controls.auxiliaryApprovals.review(target.scope, job.id, target.replyTo, state);
    const lastEvent = snapshot.events.at(-1)?.seq ?? 0;
    const finished = !isJobActive(snapshot.job);
    let delivery = deliveries[job.id];
    if (!delivery) {
      delivery = { mode: deps.controls.auxiliary?.isAuxiliary(target.scope) ? 'card' : getMessageReplyMode(deps.controls.cfg), sequence: 0, lastEvent: -1, pushedAt: 0 };
      deliveries[job.id] = delivery;
    }
    if (delivery.mode === 'text' && !finished) return;
    if (delivery.lastEvent === lastEvent && !finished && Date.now() - delivery.pushedAt < 15_000) return;
    if (deps.controls.auxiliary?.isAuxiliary(target.scope)) await deps.controls.auxiliary.trackRun(target.scope, job.id, target.replyTo, !finished, target.operatorOpenId);
    const options = deps.renderOptions?.(job) ?? {};
    const card = renderCard(state, { ...options, showStopButton: !finished });
    // CardKit updates own the stream window across reconnects; avoid its 10-minute streaming timeout.
    (card as { config: { streaming_mode: boolean } }).config.streaming_mode = false;
    const text = renderText(state);
    const content = delivery.mode === 'card' ? undefined : JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'md', text: text || '正在执行…' }]] } });
    if (delivery.mode === 'card' && !delivery.cardId) {
      const result = await deps.channel.createCard(card); delivery.cardId = result.cardId; await save();
    }
    if (!delivery.messageId) {
      // Feishu uuid deduplicates for one hour. Do not blindly retry an ambiguous
      // send after that window: it might already be present in the chat.
      if (delivery.sendingSince && Date.now() - delivery.sendingSince >= 55 * 60_000) throw new Error('消息发送结果未确认且已超过去重窗口，暂停自动重发；任务仍保留在执行服务中');
      if (!delivery.sendingSince) { delivery.sendingSince = Date.now(); await save(); }
      const uuid = createHash('sha256').update(`worker-reply:${job.id}`).digest('hex').slice(0, 48);
      const response = await deps.channel.rawClient.im.v1.message.reply({ path: { message_id: target.replyTo },
        data: { msg_type: delivery.mode === 'card' ? 'interactive' : 'post',
          content: content ?? JSON.stringify({ type: 'card', data: { card_id: delivery.cardId } }),
          ...(target.replyInThread ? { reply_in_thread: true } : {}), uuid } });
      if (response.code || !response.data?.message_id) throw new Error(`回复未确认：${response.code ?? 'missing-message-id'} ${response.msg ?? ''}`);
      delivery.messageId = response.data.message_id; await save();
    }
    if (delivery.mode === 'card') {
      delivery.sequence++; await save();
      await deps.channel.updateCardById(delivery.cardId!, card, delivery.sequence);
    } else if (delivery.mode === 'markdown') {
      const response = await deps.channel.rawClient.im.v1.message.patch({ path: { message_id: delivery.messageId }, data: { content: content! } });
      if (response.code) throw new Error(`更新回复失败：${response.code} ${response.msg ?? ''}`);
    }
    delivery.lastEvent = lastEvent; delivery.pushedAt = Date.now(); delivery.finished = finished; await save();
  }
  const runNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    return running ??= sync().catch(error => {
      if (Date.now() - lastWarning > 30_000) { lastWarning = Date.now(); log.warn('worker-replies', 'sync-unavailable', { toolId: deps.adapter.id, error: error instanceof Error ? error.message : String(error) }); }
    }).finally(() => { running = undefined; });
  };
  const timer = setInterval(() => { void runNow(); }, deps.intervalMs ?? 1000); timer.unref?.();
  void runNow();
  return {
    runNow,
    async stopScope(scope: string): Promise<boolean> {
      const jobs = (await deps.adapter.client.list()).filter(job => isJobActive(job) && job.options.delivery?.scope === scope);
      await Promise.all(jobs.map(job => deps.adapter.client.stop(job.id))); return jobs.length > 0;
    },
    async stop(): Promise<void> {
      stopped = true; clearInterval(timer); await running;
      for (const { handle, scope } of recovered.values()) {
        handle.detached = true; await handle.run.detach?.();
        deps.activeRuns.unregister(scope, handle.run);
      }
    },
  };
}
