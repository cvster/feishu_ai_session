import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../commands';
import type { SessionCatalog } from '../session/catalog';
import type { KiloConversationReader, KiloConversationTurn } from '../agent/kilo/conversation';
import { renderCard } from '../card/run-renderer';
import { renderText } from '../card/text-renderer';
import { getMessageReplyMode, getShowToolCalls } from '../config/schema';
import { writeFileAtomic } from '../platform/atomic-write';
import { log } from '../core/logger';
import type { SessionNameSync } from './thread-name';

interface Delivery {
  createdAtMs: number;
  skipped?: boolean;
  inputMessageId?: string;
  inputSendingAt?: number;
  cardId?: string;
  messageId?: string;
  sendingAt?: number;
  sequence: number;
  hash?: string;
  pushedAt?: number;
  lastActivityAt?: number;
}
interface BindingState { baselineAtMs: number; boundAtMs?: number; turns: Record<string, Delivery> }
interface State { version: 1; bindings: Record<string, BindingState> }
export interface KiloTurnSyncDeps {
  channel: LarkChannel;
  controls: Controls;
  catalog: SessionCatalog;
  sourceId: string;
  reader: KiloConversationReader;
  statePath: string;
  ready?(): Promise<boolean>;
  intervalMs?: number;
  now?(): number;
  nameSync?: Pick<SessionNameSync, 'observe'>;
}
const keyFor = (scope: string, sourceId: string, id: string) => JSON.stringify([scope, sourceId, id]);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Mirrors external Kilo inputs/replies, never submits a prompt or writes to an FF audience.
 * Worker-origin replies retain their existing sole writer and are skipped here.
 */
export async function startKiloTurnSync(deps: KiloTurnSyncDeps) {
  let state: State = { version: 1, bindings: {} };
  try {
    state = JSON.parse(await readFile(deps.statePath, 'utf8'));
    if (state.version !== 1 || !state.bindings || Array.isArray(state.bindings)) throw new Error('Invalid Kilo mirror ledger');
    for (const binding of Object.values(state.bindings)) if (!Number.isFinite(binding.baselineAtMs) || !binding.turns || Array.isArray(binding.turns)) throw new Error('Invalid Kilo mirror binding');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const now = deps.now ?? Date.now;
  const save = () => writeFileAtomic(deps.statePath, JSON.stringify(state), { mode: 0o600 });
  let stopped = false, running: Promise<void> | undefined, lastWarning = 0;
  const active = (scope: string, id: string): boolean => {
    const binding = deps.controls.toolBindings?.get(scope);
    if (!/^oc_[A-Za-z0-9]+$/.test(scope) || !binding || binding.toolId !== 'kilo' || binding.sourceId !== deps.sourceId || binding.nativeId !== id ||
      binding.linkedSource || binding.auxiliaryWorkgroup || deps.controls.auxiliary?.isAuxiliary(scope) || deps.catalog.isScopeArchived(scope) ||
      deps.controls.toolBindings!.isArchived('kilo', deps.sourceId, id)) return false;
    return deps.catalog.entries().some(row => row.scopeId === scope && row.agentId === 'kilo' && row.status === 'active' &&
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
  async function send(scope: string, id: string, turn: KiloConversationTurn, delivery: Delivery, input: boolean, type: string, content: string): Promise<string> {
    const field = input ? 'inputSendingAt' : 'sendingAt';
    if (delivery[field] !== undefined && now() - delivery[field]! >= 55 * 60_000) throw new Error('Kilo 同步消息发送结果未确认，已超过去重窗口，暂停自动重发。');
    delivery[field] ??= now(); await save();
    if (!active(scope, id) || stopped) throw new Error('Kilo 同步群已归档或重新绑定');
    const uuid = digest(`kilo-native:${deps.sourceId}:${scope}:${id}:${turn.id}:${input ? 'input' : 'answer'}`).slice(0, 48);
    const response = await deps.channel.rawClient.im.v1.message.create({ params: { receive_id_type: 'chat_id' },
      data: { receive_id: scope, msg_type: type, content, uuid } });
    if (response.code || !response.data?.message_id) throw new Error(`Kilo 同步消息发送未确认：${response.code ?? 'missing-message-id'}`);
    return response.data.message_id;
  }
  async function publish(scope: string, id: string, turn: KiloConversationTurn, delivery: Delivery, force = false): Promise<boolean> {
    if (!active(scope, id) || stopped || delivery.skipped || turn.bridge) return false;
    const input = turn.input.trim();
    if (input && !delivery.inputMessageId) {
      const markdown = `💻 **来自 Kilo 界面**\n\n${input.slice(0, 8000)}${input.length > 8000 ? '…' : ''}`;
      delivery.inputMessageId = await send(scope, id, turn, delivery, true, 'post', JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'md', text: markdown }]] } }));
      await save();
    }
    let view = getShowToolCalls(deps.controls.cfg) ? turn.state : { ...turn.state, blocks: turn.state.blocks.filter(block => block.kind !== 'tool') };
    const hash = digest(JSON.stringify(view));
    const first = !delivery.hash;
    if (!force && delivery.hash === hash && (view.terminal !== 'running' || now() - (delivery.pushedAt ?? 0) < 15_000)) return false;
    if (delivery.hash !== hash) delivery.lastActivityAt = now();
    view = { ...view, runtime: { startedAtMs: turn.createdAtMs, lastActivityAtMs: delivery.lastActivityAt ?? turn.createdAtMs,
      checkedAtMs: now(), processRunning: view.terminal === 'running' } };
    const mode = getMessageReplyMode(deps.controls.cfg);
    if (mode === 'text' && view.terminal === 'running') return false;
    if (mode === 'card' || delivery.cardId) {
      const card = renderCard(view, { ...deps.controls.runControlIcons, supportsFork: true, showStopButton: true });
      (card as { config: { streaming_mode: boolean } }).config.streaming_mode = false;
      if (!delivery.cardId) { delivery.cardId = (await deps.channel.createCard(card)).cardId; await save(); }
      if (!active(scope, id) || stopped) return false;
      if (!delivery.messageId) {
        delivery.messageId = await send(scope, id, turn, delivery, false, 'interactive', JSON.stringify({ type: 'card', data: { card_id: delivery.cardId } }));
        await save();
      }
      delivery.sequence++; await save();
      if (!active(scope, id) || stopped) return false;
      await deps.channel.updateCardById(delivery.cardId!, card, delivery.sequence);
    } else {
      const content = JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'md', text: renderText(view) || '正在执行…' }]] } });
      if (!delivery.messageId) delivery.messageId = await send(scope, id, turn, delivery, false, 'post', content);
      else if (mode === 'markdown' && active(scope, id) && !stopped) {
        const result = await deps.channel.rawClient.im.v1.message.patch({ path: { message_id: delivery.messageId }, data: { content } });
        if (result.code) throw new Error('Kilo 同步消息更新失败');
      }
    }
    delivery.hash = hash; delivery.pushedAt = now(); await save();
    if (first || view.terminal !== 'running') log.info('kilo-turn-sync', 'native-turn-mirrored', {
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
        if (snapshot.id !== id || snapshot.archived) continue;
        // Only a unique personal group owns the native title. Shared FF
        // audiences and ambiguous legacy bindings must never fight over it.
        const nameEntries = deps.catalog.entries().filter(row => scopes.includes(row.scopeId) && active(row.scopeId, id) &&
          row.agentId === 'kilo' && row.status === 'active' && (row.sessionId ?? row.threadId) === id &&
          row.sourceId === deps.sourceId && row.botAppId === deps.controls.profileConfig.accounts.app.id &&
          resolve(row.cwdRealpath) === resolve(snapshot.cwd));
        if (new Set(nameEntries.map(row => row.scopeId)).size === 1) {
          try { await deps.nameSync?.observe(snapshot, nameEntries, scope => !stopped && active(scope, id)); }
          catch (error) { log.warn('kilo-turn-sync', 'name-sync-failed', { sessionId: id, error: String(error) }); }
        }
        for (const scope of scopes) {
          if (!active(scope, id)) continue;
          const entry = deps.catalog.entries().find(row => row.scopeId === scope && row.agentId === 'kilo' && row.status === 'active' && (row.sessionId ?? row.threadId) === id);
          if (!entry || resolve(entry.cwdRealpath) !== resolve(snapshot.cwd)) continue;
          const key = keyFor(scope, deps.sourceId, id);
          const previous = state.bindings[key], boundAtMs = entry.boundAt ?? entry.updatedAt;
          const initial = !previous || previous.boundAtMs !== boundAtMs;
          const binding = initial ? state.bindings[key] = { baselineAtMs: now(), boundAtMs, turns: {} } : previous;
          if (initial) log.info('kilo-turn-sync', 'baseline-created', { scope, sessionId: id, turns: snapshot.turns.length });
          for (const turn of snapshot.turns) {
            if (!Number.isFinite(turn.createdAtMs)) continue;
            let delivery = binding.turns[turn.id];
            if (!delivery) {
              delivery = binding.turns[turn.id] = { createdAtMs: turn.createdAtMs, sequence: 0,
                skipped: turn.bridge || (turn.createdAtMs <= binding.baselineAtMs && (initial || turn.state.terminal !== 'running')) };
              // A first snapshot establishes a baseline, including currently
              // running turns: never expose work that predates the binding.
              await save();
            }
            if (refresh && (refresh.scope !== scope || delivery.messageId !== refresh.messageId)) continue;
            if (await publish(scope, id, turn, delivery, !!refresh)) refreshed ||= !!refresh;
          }
          const old = Object.entries(binding.turns).sort((a, b) => a[1].createdAtMs - b[1].createdAtMs);
          for (const [turnId, delivery] of old.slice(0, -300)) {
            binding.baselineAtMs = Math.max(binding.baselineAtMs, delivery.createdAtMs); delete binding.turns[turnId];
          }
        }
      } catch (error) {
        if (now() - lastWarning >= 30_000) {
          lastWarning = now(); log.warn('kilo-turn-sync', 'sync-unavailable', { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    await save(); return refreshed;
  }
  const runNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    return running ??= sync().then(() => {}).catch(error => log.fail('kilo-turn-sync', error)).finally(() => { running = undefined; });
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
    async stopScope(scope: string): Promise<boolean> {
      while (running) await running;
      const id = deps.controls.toolBindings?.get(scope)?.nativeId;
      if (!id || stopped || !active(scope, id)) return false;
      const snapshot = await deps.reader.read(id), turn = snapshot.turns.at(-1);
      if (!turn || turn.bridge || !active(scope, id) || snapshot.archived || turn.state.terminal !== 'running') return false;
      const delivery = state.bindings[keyFor(scope, deps.sourceId, id)]?.turns[turn.id];
      if (!delivery || delivery.skipped || !delivery.messageId) return false;
      const stoppedTurn = await deps.reader.stopTurn(id, turn.id); await runNow(); return stoppedTurn;
    },
    async stop() { if (stopped) return; stopped = true; clearInterval(timer); await running; await save(); await deps.reader.close(); },
  };
}
