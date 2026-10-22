import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../commands';
import type { SessionCatalog } from '../session/catalog';
import type { NativeConversationReader, NativeConversationTurn } from '../agent/native-conversation';
import { renderCard } from '../card/run-renderer';
import { renderText } from '../card/text-renderer';
import { getMessageReplyMode, getShowToolCalls } from '../config/schema';
import { writeFileAtomic } from '../platform/atomic-write';
import { log } from '../core/logger';
import { publishCards, type CardPart } from '../card/multipart';
import { notifyCompletion, type CompletionDelivery } from './completion-notification';
import type { SessionNameSync } from './thread-name';

interface Delivery extends CompletionDelivery {
  parts?: CardPart[];
  completionEligible?: boolean;
  createdAtMs: number;
  skipped?: boolean;
  legacyBridge?: boolean;
  replay?: boolean;
  inputMessageId?: string;
  inputSendingAt?: number;
  cardId?: string;
  messageId?: string;
  sendingAt?: number;
  sendingSince?: number;
  sequence: number;
  hash?: string;
  pushedAt?: number;
  lastActivityAt?: number;
}
interface BindingState { baselineAtMs: number; boundAtMs?: number; turns: Record<string, Delivery> }
interface State { version: 1; bindings: Record<string, BindingState> }
export interface NativeTurnSyncDeps {
  toolId: string;
  displayName: string;
  channel: LarkChannel;
  controls: Controls;
  catalog: SessionCatalog;
  sourceId: string;
  reader: NativeConversationReader;
  statePath: string;
  ready?(): Promise<boolean>;
  intervalMs?: number;
  now?(): number;
  nameSync?: Pick<SessionNameSync, 'observe'>;
}
const keyFor = (scope: string, sourceId: string, id: string) => JSON.stringify([scope, sourceId, id]);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Mirrors external native inputs/replies, never submits a prompt or writes to an FF audience.
 * Worker-origin replies retain their existing sole writer and are skipped here.
 */
export async function startNativeTurnSync(deps: NativeTurnSyncDeps) {
  const { toolId, displayName } = deps;
  const phase = `${toolId}-turn-sync`;
  let state: State = { version: 1, bindings: {} };
  try {
    state = JSON.parse(await readFile(deps.statePath, 'utf8'));
    if (state.version !== 1 || !state.bindings || Array.isArray(state.bindings)) throw new Error('Invalid native mirror ledger');
    for (const binding of Object.values(state.bindings)) if (!Number.isFinite(binding.baselineAtMs) || !binding.turns || Array.isArray(binding.turns)) throw new Error('Invalid native mirror binding');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const now = deps.now ?? Date.now;
  const save = () => writeFileAtomic(deps.statePath, JSON.stringify(state), { mode: 0o600 });
  let stopped = false, running: Promise<void> | undefined, lastWarning = 0;
  const active = (scope: string, id: string): boolean => {
    const binding = deps.controls.toolBindings?.get(scope);
    if (!/^oc_[A-Za-z0-9]+$/.test(scope) || !binding || binding.toolId !== toolId || binding.sourceId !== deps.sourceId || binding.nativeId !== id ||
      binding.linkedSource || binding.auxiliaryWorkgroup || deps.controls.auxiliary?.isAuxiliary(scope) || deps.catalog.isScopeArchived(scope) ||
      deps.controls.toolBindings!.isArchived(toolId, deps.sourceId, id)) return false;
    return deps.catalog.entries().some(row => row.scopeId === scope && row.agentId === toolId && row.status === 'active' &&
      (row.sessionId ?? row.threadId) === id && (!row.sourceId || row.sourceId === deps.sourceId) &&
      (!row.botAppId || row.botAppId === deps.controls.profileConfig.accounts.app.id));
  };
  function targets() {
    const groups = new Map<string, string[]>();
    for (const [scope, binding] of deps.controls.toolBindings?.entries() ?? []) if (binding.nativeId && active(scope, binding.nativeId)) {
      groups.set(binding.nativeId, [...(groups.get(binding.nativeId) ?? []), scope]);
    }
    return groups;
  }
  async function send(scope: string, id: string, turn: NativeConversationTurn, delivery: Delivery, input: boolean, type: string, content: string): Promise<string> {
    const field = input ? 'inputSendingAt' : 'sendingAt';
    if (delivery[field] !== undefined && now() - delivery[field]! >= 55 * 60_000) throw new Error(`${displayName} 同步消息发送结果未确认，已超过去重窗口，暂停自动重发。`);
    delivery[field] ??= now(); await save();
    if (!active(scope, id) || stopped) throw new Error(`${displayName} 同步群已归档或重新绑定`);
    const uuid = digest(`${toolId}-native:${deps.sourceId}:${scope}:${id}:${turn.id}:${input ? 'input' : 'answer'}`).slice(0, 48);
    const response = await deps.channel.rawClient.im.v1.message.create({ params: { receive_id_type: 'chat_id' },
      data: { receive_id: scope, msg_type: type, content, uuid } });
    if (response.code || !response.data?.message_id) throw new Error(`${displayName} 同步消息发送未确认：${response.code ?? 'missing-message-id'}`);
    return response.data.message_id;
  }
  async function publish(scope: string, id: string, turn: NativeConversationTurn, delivery: Delivery, force = false): Promise<boolean> {
    if (!active(scope, id) || stopped || delivery.skipped || (turn.bridge && !delivery.legacyBridge && !delivery.replay)) return false;
    const input = turn.bridge ? '' : turn.input.trim();
    if (input && !delivery.inputMessageId) {
      const markdown = `💻 **来自 ${displayName} 界面**\n\n${input.slice(0, 8000)}${input.length > 8000 ? '…' : ''}`;
      delivery.inputMessageId = await send(scope, id, turn, delivery, true, 'post', JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'md', text: markdown }]] } }));
      await save();
    }
    let view = getShowToolCalls(deps.controls.cfg) ? turn.state : { ...turn.state, blocks: turn.state.blocks.filter(block => block.kind !== 'tool') };
    // Worker snapshots refresh observation clocks even for completed turns.
    // Those clocks are replaced below; hashing them would rewrite every old
    // card each poll and delay delivery of new native messages.
    const { runtime: _observedRuntime, ...content } = view;
    const hash = digest(JSON.stringify(content));
    const first = !delivery.hash;
    // Existing completed ledgers/replayed history must not produce a burst of
    // mentions when a render preference or bridge version changes.
    delivery.completionEligible ??= !delivery.replay && (first || view.terminal === 'running');
    const completion = () => notifyCompletion({ channel: deps.channel, target: { chatId: scope },
      ownerId: deps.controls.botOwnerId, key: `${toolId}-native:${deps.sourceId}:${scope}:${id}:${turn.id}`,
      delivery, save, active: () => active(scope, id) && !stopped, now: now() });
    if (view.terminal !== 'running' && delivery.completionSendingSince !== undefined) await completion();
    if (!force && delivery.hash === hash && (view.terminal !== 'running' || now() - (delivery.pushedAt ?? 0) < 15_000)) return false;
    if (delivery.hash !== hash) delivery.lastActivityAt = now();
    view = { ...view, runtime: { startedAtMs: turn.createdAtMs, lastActivityAtMs: delivery.lastActivityAt ?? turn.createdAtMs,
      checkedAtMs: now(), processRunning: view.terminal === 'running' } };
    const mode = getMessageReplyMode(deps.controls.cfg);
    if (mode === 'text' && view.terminal === 'running') return false;
    if (mode === 'card' || delivery.cardId) {
      const card = renderCard(view, { ...deps.controls.runControlIcons, supportsFork: true, nativeMirror: true, showStopButton: !!deps.reader.stopTurn });
      (card as { config: { streaming_mode: boolean } }).config.streaming_mode = false;
      delivery.sendingSince ??= delivery.sendingAt; // Preserve the legacy ambiguous-send window.
      await publishCards({ channel: deps.channel, target: { chatId: scope }, card, delivery,
        key: `${toolId}-native:${deps.sourceId}:${scope}:${id}:${turn.id}:answer`, save,
        active: () => active(scope, id) && !stopped, now: now(), force });
    } else {
      const content = JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'md', text: renderText(view) || '正在执行…' }]] } });
      if (!delivery.messageId) delivery.messageId = await send(scope, id, turn, delivery, false, 'post', content);
      else if (mode === 'markdown' && active(scope, id) && !stopped) {
        const result = await deps.channel.rawClient.im.v1.message.patch({ path: { message_id: delivery.messageId }, data: { content } });
        if (result.code) throw new Error(`${displayName} 同步消息更新失败`);
      }
    }
    if (view.terminal !== 'running' && delivery.completionEligible) await completion();
    delivery.hash = hash; delivery.pushedAt = now(); await save();
    if (first || view.terminal !== 'running') log.info(phase, 'native-turn-mirrored', {
      scope, sessionId: id, turnId: turn.id, messageId: delivery.messageId, terminal: view.terminal,
    });
    return true;
  }
  async function sync(refresh?: { scope: string; messageId: string }): Promise<boolean> {
    let refreshed = false;
    const groups = targets();
    if (!groups.size) return false;
    if (deps.ready && !await deps.ready()) return false;
    for (const [id, scopes] of groups) {
      if (stopped) break;
      try {
        const snapshot = await deps.reader.read(id);
        if (snapshot.id !== id) continue;
        if (snapshot.archived) {
          if (!deps.catalog.entries().some(row => scopes.includes(row.scopeId) && active(row.scopeId, id) &&
            row.agentId === toolId && (row.sessionId ?? row.threadId) === id && resolve(row.cwdRealpath) === resolve(snapshot.cwd))) continue;
          deps.catalog.archiveNativeSession(toolId, id, deps.sourceId, true);
          deps.controls.toolBindings?.archive(toolId, deps.sourceId, id);
          await Promise.all([deps.catalog.flush(), deps.controls.toolBindings?.flush()]);
          await deps.controls.sessionArchiveNotifications?.flush();
          continue;
        }
        // Only a unique personal group owns the native title. Shared FF
        // audiences and ambiguous legacy bindings must never fight over it.
        const nameEntries = deps.catalog.entries().filter(row => scopes.includes(row.scopeId) && active(row.scopeId, id) &&
          row.agentId === toolId && row.status === 'active' && (row.sessionId ?? row.threadId) === id &&
          row.sourceId === deps.sourceId && row.botAppId === deps.controls.profileConfig.accounts.app.id &&
          resolve(row.cwdRealpath) === resolve(snapshot.cwd));
        if (new Set(nameEntries.map(row => row.scopeId)).size === 1) {
          try { await deps.nameSync?.observe(snapshot, nameEntries, scope => !stopped && active(scope, id)); }
          catch (error) { log.warn(phase, 'name-sync-failed', { sessionId: id, error: String(error) }); }
        }
        for (const scope of scopes) {
          if (!active(scope, id)) continue;
          const entry = deps.catalog.entries().find(row => row.scopeId === scope && row.agentId === toolId && row.status === 'active' && (row.sessionId ?? row.threadId) === id);
          if (!entry || resolve(entry.cwdRealpath) !== resolve(snapshot.cwd)) continue;
          const key = keyFor(scope, deps.sourceId, id);
          const previous = state.bindings[key], boundAtMs = entry.boundAt ?? entry.updatedAt;
          const initial = !previous || previous.boundAtMs !== boundAtMs;
          const binding = initial ? state.bindings[key] = { baselineAtMs: now(), boundAtMs, turns: {} } : previous;
          if (initial) log.info(phase, 'baseline-created', { scope, sessionId: id, turns: snapshot.turns.length });
          const replay = new Set(initial && entry.recentTurnReplayCount ? snapshot.turns.slice(-entry.recentTurnReplayCount).map(turn => turn.id) : []);
          for (const turn of snapshot.turns) {
            if (!Number.isFinite(turn.createdAtMs)) continue;
            let delivery = binding.turns[turn.id];
            if (!delivery) {
              delivery = binding.turns[turn.id] = { createdAtMs: turn.createdAtMs, sequence: 0,
                replay: replay.has(turn.id), skipped: !replay.has(turn.id) && (turn.bridge || (turn.createdAtMs <= binding.baselineAtMs && (initial || turn.state.terminal !== 'running'))) };
              // A first snapshot establishes a baseline, including currently
              // running turns: never expose work that predates the binding.
              await save();
            }
            if (refresh && (refresh.scope !== scope || delivery.messageId !== refresh.messageId && !delivery.parts?.some(part => part.messageId === refresh.messageId))) continue;
            if (await publish(scope, id, turn, delivery, !!refresh)) refreshed ||= !!refresh;
          }
          const old = Object.entries(binding.turns).sort((a, b) => a[1].createdAtMs - b[1].createdAtMs);
          for (const [turnId, delivery] of old.slice(0, -300)) {
            binding.baselineAtMs = Math.max(binding.baselineAtMs, delivery.createdAtMs); delete binding.turns[turnId];
          }
        }
      } catch (error) {
        if (now() - lastWarning >= 30_000) {
          lastWarning = now(); log.warn(phase, 'sync-unavailable', { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    await save(); return refreshed;
  }
  const runNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    return running ??= sync().then(() => {}).catch(error => log.fail(phase, error)).finally(() => { running = undefined; });
  };
  const timer = setInterval(() => void runNow(), deps.intervalMs ?? 2000); timer.unref?.();
  await runNow();
  return {
    runNow,
    async refreshMessage(scope: string, messageId: string): Promise<boolean> {
      while (running) await running;
      if (stopped) return false;
      let refreshed = false;
      running = sync({ scope, messageId }).then(result => { refreshed = result; }).finally(() => { running = undefined; });
      await running; return refreshed;
    },
    ownsMessage(scope: string, messageId: string): boolean {
      return Object.entries(state.bindings).some(([key, binding]) => JSON.parse(key)[0] === scope &&
        Object.values(binding.turns).some(delivery => delivery.messageId === messageId || delivery.parts?.some(part => part.messageId === messageId)));
    },
    async stopScope(scope: string, messageId?: string): Promise<boolean> {
      while (running) await running;
      const id = deps.controls.toolBindings?.get(scope)?.nativeId;
      if (!deps.reader.stopTurn || !id || stopped || !active(scope, id)) return false;
      const snapshot = await deps.reader.read(id), turn = snapshot.turns.at(-1);
      if (!turn || turn.bridge || !active(scope, id) || snapshot.archived || turn.state.terminal !== 'running') return false;
      const delivery = state.bindings[keyFor(scope, deps.sourceId, id)]?.turns[turn.id];
      if (!delivery || delivery.skipped || !delivery.messageId || (messageId && delivery.messageId !== messageId && !delivery.parts?.some(part => part.messageId === messageId))) return false;
      const stoppedTurn = await deps.reader.stopTurn(id, turn.id); await runNow(); return stoppedTurn;
    },
    async stop() { if (stopped) return; stopped = true; clearInterval(timer); await running; await save(); await deps.reader.close(); },
  };
}
