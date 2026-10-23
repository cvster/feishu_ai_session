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
import { publishCards, checkSendWindow, deliveryUuid, sendDeliveryMessage, type CardPart } from '../card/multipart';
import { notifyCompletion, type CompletionDelivery } from '../bot/completion-notification';
import { DurableAgentAdapter } from './adapter';
import { isJobActive, type WorkerJob } from './protocol';
import { nativeSessionFields } from '../tools/definitions';
import { sharedJobPersonalScope, namedSharedMessages } from './shared-history';

interface ReplyDelivery extends CompletionDelivery {
  parts?: CardPart[];
  mode: 'card' | 'markdown' | 'text';
  cardId?: string;
  messageId?: string;
  sequence: number;
  lastEvent: number;
  pushedAt: number;
  sendingSince?: number;
  finished?: boolean;
  controlsVersion?: number;
  skipped?: boolean;
  inputMessageId?: string;
  inputSendingSince?: number;
  completionEligible?: boolean;
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
  // One bounded repair window on upgrade; subsequent restarts retain the same cutoff.
  let sharedMirrorSince = Date.now() - 2 * 60 * 60_000;
  try {
    const raw = JSON.parse(await readFile(deps.statePath, 'utf8'));
    if (raw.version !== 1 || !raw.deliveries || Array.isArray(raw.deliveries)) throw new Error('Invalid worker reply ledger');
    deliveries = raw.deliveries;
    if (Number.isFinite(raw.sharedMirrorSince)) sharedMirrorSince = raw.sharedMirrorSince;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const save = () => writeFileAtomic(deps.statePath, `${JSON.stringify({ version: 1, deliveries, sharedMirrorSince })}\n`, { mode: 0o600 });
  await save();
  const recovered = new Map<string, { handle: RunHandle; scope: string }>();
  let stopped = false;
  let running: Promise<void> | undefined;
  let lastWarning = 0;
  async function sync(): Promise<void> {
    const jobs = await deps.adapter.client.list();
    for (const job of jobs) {
      if (stopped || !job.options.delivery) continue;
      try { await publish(job); } catch (error) { log.warn('worker-replies', 'publish-failed', { toolId: deps.adapter.id, jobId: job.id, error: error instanceof Error ? error.message : String(error) }); }
      try {
        const scope = sharedJobPersonalScope(deps.controls, deps.catalog, job);
        if (!scope || (!isJobActive(job) && job.createdAt < sharedMirrorSince)) continue;
        const binding = deps.controls.toolBindings!.get(scope)!;
        const boundAt = deps.catalog.entries().find(r => r.scopeId === scope && r.status === 'active' &&
          (r.threadId ?? r.sessionId) === binding.nativeId)?.boundAt;
        if (boundAt && job.createdAt < boundAt) continue;
        const key = `shared-reply:${job.id}:${deliveryUuid(JSON.stringify([scope, binding.toolId, binding.sourceId, binding.nativeId]))}`;
        if (deliveries[key]?.finished && deliveries[key]?.controlsVersion === 1) continue;
        const messages = await namedSharedMessages(deps.controls, deps.channel, job);
        if (!messages.length) continue;
        const input = messages.map(m => `${m.senderName}：\n${m.content}`).join('\n\n');
        await publish(job, { scope, key, input });
      } catch (error) { log.warn('worker-replies', 'shared-mirror-failed', { toolId: deps.adapter.id, jobId: job.id, error: error instanceof Error ? error.message : String(error) }); }
    }
    if (!stopped) await deps.onReady?.(jobs);
  }
  async function publish(job: WorkerJob, mirror?: { scope: string; key: string; input: string }): Promise<void> {
    const source = job.options.delivery!;
    const target = mirror ? { ...source, scope: mirror.scope, chatId: mirror.scope, replyTo: '', replyInThread: false,
      operatorOpenId: deps.controls.botOwnerId! } : source;
    const ledgerKey = mirror?.key ?? job.id, messageKey = mirror?.key ?? `worker-reply:${job.id}`;
    if (mirror && sharedJobPersonalScope(deps.controls, deps.catalog, job) !== mirror.scope) return;
    if (deps.controls.auxiliary?.isAuxiliary(target.scope) && !deps.controls.auxiliary.isActive(target.scope)) return;
    const observer = recovered.get(job.id);
    if (!mirror && !isJobActive(job) && observer) {
      deps.activeRuns.unregister(target.scope, observer.handle.run); recovered.delete(job.id);
    }
    if (target.botAppId !== deps.controls.profileConfig.accounts.app.id || target.sourceId !== deps.adapter.client.sourceId) return;
    const binding = deps.controls.toolBindings?.get(target.scope);
    const originalNative = job.options.threadId ?? job.options.sessionId ?? job.options.initialSessionId;
    if (!binding || binding.toolId !== deps.adapter.id || binding.sourceId !== target.sourceId ||
      (originalNative && binding.nativeId && originalNative !== binding.nativeId) || deps.catalog.isScopeArchived(target.scope)) {
      if (deliveries[ledgerKey] && !deliveries[ledgerKey]!.skipped) { deliveries[ledgerKey]!.skipped = true; await save(); }
      return;
    }
    if (!mirror && isJobActive(job) && !deps.activeRuns.get(target.scope)) {
      const run = deps.adapter.observe(job.id);
      recovered.set(job.id, { handle: deps.activeRuns.register(target.scope, run), scope: target.scope });
    }
    const previousDelivery = deliveries[ledgerKey];
    const repairControls = previousDelivery?.mode === 'card' && previousDelivery.controlsVersion !== 1;
    if (previousDelivery?.skipped || (previousDelivery?.finished && !repairControls)) return;
    const snapshot = await deps.adapter.client.snapshot(job.id);
    const init = snapshot.events.find(row => row.event.type === 'system' && (row.event.sessionId || row.event.threadId))?.event;
    if (mirror && init?.type === 'system' && (init.sessionId ?? init.threadId) !== binding.nativeId) return;
    if (init?.type === 'system' && (init.sessionId || init.threadId) && (binding.nativeId !== (init.sessionId ?? init.threadId) || !binding.nativeCreated)) {
      const sessionId = (init.sessionId ?? init.threadId)!;
      deps.controls.toolBindings!.set(target.scope, { ...binding, nativeId: sessionId, nativeCreated: true });
      deps.sessions.set(target.scope, sessionId, job.options.cwd ?? '');
      deps.catalog.upsertActive({ preserveBinding: true, scopeId: target.scope, agentId: binding.toolId, cwdRealpath: job.options.cwd!,
        policyFingerprint: target.policyFingerprint, ...nativeSessionFields(binding.toolId, sessionId), sourceId: target.sourceId, botAppId: target.botAppId });
      await Promise.all([deps.controls.toolBindings!.flush(), deps.sessions.flush(), deps.catalog.flush()]);
    }
    let state = startRunRuntime(initialState, job.createdAt);
    for (const row of snapshot.events) state = reduce(state, row.event);
    state = updateRunRuntime(state, { nowMs: Date.now(), processRunning: isJobActive(snapshot.job) });
    if (!getShowToolCalls(deps.controls.cfg)) state = { ...state, blocks: state.blocks.filter(block => block.kind !== 'tool') };
    if (deps.controls.auxiliaryApprovals) state = await deps.controls.auxiliaryApprovals.review(source.scope, job.id, source.replyTo, state);
    const lastEvent = snapshot.events.at(-1)?.seq ?? 0;
    const finished = !isJobActive(snapshot.job);
    let delivery = deliveries[ledgerKey];
    if (!delivery) {
      delivery = { mode: deps.controls.auxiliary?.isAuxiliary(target.scope) ? 'card' : getMessageReplyMode(deps.controls.cfg), sequence: 0, lastEvent: -1, pushedAt: 0 };
      deliveries[ledgerKey] = delivery;
    }
    const active = () => !stopped && !deps.catalog.isScopeArchived(target.scope) &&
      (!mirror || sharedJobPersonalScope(deps.controls, deps.catalog, job) === mirror.scope) &&
      (!deps.controls.auxiliary?.isAuxiliary(target.scope) || deps.controls.auxiliary.isActive(target.scope)) &&
      deps.controls.toolBindings?.get(target.scope)?.nativeId === (init?.type === 'system' ? init.sessionId ?? init.threadId ?? binding.nativeId : binding.nativeId) &&
      deps.controls.toolBindings?.get(target.scope)?.sourceId === target.sourceId &&
      deps.controls.toolBindings?.get(target.scope)?.toolId === deps.adapter.id;
    if (mirror) {
      delivery.completionEligible ??= !finished;
      if (!delivery.inputMessageId) {
        checkSendWindow(delivery.inputSendingSince, Date.now());
        delivery.inputSendingSince ??= Date.now(); await save();
        if (!active()) return;
        delivery.inputMessageId = await sendDeliveryMessage(deps.channel, { chatId: target.chatId }, 'text',
          JSON.stringify({ text: `来自共享群\n${mirror.input}` }), deliveryUuid(`${messageKey}:input`));
        await save();
      }
      target.replyTo = delivery.inputMessageId;
    }
    if (delivery.mode === 'text' && !finished) return;
    if (delivery.lastEvent === lastEvent && !finished && Date.now() - delivery.pushedAt < 15_000) return;
    if (deps.controls.auxiliary?.isAuxiliary(target.scope)) await deps.controls.auxiliary.trackRun(target.scope, job.id, target.replyTo, !finished, target.operatorOpenId);
    const options = deps.renderOptions?.(mirror ? { ...job, options: { ...job.options, delivery: target } } : job);
    // Completed personal cards retain the same group controls as Codex. Active stops stay bound to their job token.
    const card = renderCard(state, { ...options, showStopButton: true, ...(finished || mirror ? { signCallback: undefined } : {}) });
    // CardKit updates own the stream window across reconnects; avoid its 10-minute streaming timeout.
    (card as { config: { streaming_mode: boolean } }).config.streaming_mode = false;
    const text = renderText(state);
    const content = delivery.mode === 'card' ? undefined : JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'md', text: text || '正在执行…' }]] } });
    if (delivery.mode === 'card') {
      await publishCards({ channel: deps.channel, target, card, delivery, key: messageKey, save, active, force: repairControls });
    } else {
      if (!active()) return;
      if (!delivery.messageId) {
        // Feishu uuid deduplicates for one hour. Pause ambiguous sends after it.
        if (delivery.sendingSince && Date.now() - delivery.sendingSince >= 55 * 60_000) throw new Error('消息发送结果未确认且已超过去重窗口，暂停自动重发；任务仍保留在执行服务中');
        if (!delivery.sendingSince) { delivery.sendingSince = Date.now(); await save(); }
        const uuid = deliveryUuid(messageKey);
        const response = await deps.channel.rawClient.im.v1.message.reply({ path: { message_id: target.replyTo },
          data: { msg_type: 'post', content: content!, ...(target.replyInThread ? { reply_in_thread: true } : {}), uuid } });
        if (response.code || !response.data?.message_id) throw new Error(`回复未确认：${response.code ?? 'missing-message-id'} ${response.msg ?? ''}`);
        delivery.messageId = response.data.message_id; await save();
      }
      if (delivery.mode === 'markdown') {
        if (!active()) return;
        const response = await deps.channel.rawClient.im.v1.message.patch({ path: { message_id: delivery.messageId }, data: { content: content! } });
        if (response.code) throw new Error(`更新回复失败：${response.code} ${response.msg ?? ''}`);
      }
    }
    // Finished ledgers from earlier versions are not retroactively notified.
    if (finished && !previousDelivery?.finished && (!mirror || delivery.completionEligible)) await notifyCompletion({ channel: deps.channel,
      target: { ...target, replyTo: delivery.parts?.filter(part => part.messageId).at(-1)?.messageId ?? delivery.messageId },
      ownerId: deps.controls.botOwnerId, key: messageKey, delivery, save, active });
    delivery.lastEvent = lastEvent; delivery.pushedAt = Date.now(); delivery.finished = finished; delivery.controlsVersion = 1; await save();
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
      const jobs = (await deps.adapter.client.list()).filter(job => isJobActive(job) &&
        (job.options.delivery?.scope === scope || sharedJobPersonalScope(deps.controls, deps.catalog, job) === scope));
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
