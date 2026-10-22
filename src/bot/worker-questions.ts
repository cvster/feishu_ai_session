import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../commands';
import type { SessionCatalog } from '../session/catalog';
import type { AgentTool } from '../tools/types';
import type { WorkerClient } from '../worker/client';
import type { WorkerQuestion } from '../worker/protocol';
import { codexInputCard, codexAnswersFromForm, type InputCardStatus } from '../card/codex-input';
import { writeFileAtomic } from '../platform/atomic-write';
import { log } from '../core/logger';

interface Delivery { scope: string; token: string; cardId: string; messageId: string; sequence: number; sendingAt?: number; lastStatus?: InputCardStatus }
interface QuestionRecord { request: WorkerQuestion['request']; status: InputCardStatus; deliveries: Delivery[] }

/** Generic transport UI. Native protocols, answer claims and question provenance belong to the worker. */
export async function startWorkerQuestions(deps: {
  channel: LarkChannel; controls: Controls; catalog: SessionCatalog; tool: AgentTool; client: WorkerClient;
  profileDir: string; intervalMs?: number;
}) {
  const path = join(deps.profileDir, `${deps.tool.id}-user-input.json`);
  const stored = new Map<string, QuestionRecord>();
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'));
    if (raw.version !== 1 || !Array.isArray(raw.entries)) throw new Error('Invalid question delivery ledger');
    for (const [key, record] of raw.entries) {
      if (typeof key !== 'string' || !record?.request || !Array.isArray(record.deliveries)) throw new Error('Invalid question delivery');
      if (record.status === 'submitting') record.status = 'unconfirmed';
      stored.set(key, record);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let stopped = false, tail = Promise.resolve(), running: Promise<void> | undefined;
  const save = () => writeFileAtomic(path, JSON.stringify({ version: 1, entries: [...stored] }), { mode: 0o600 });
  const serialize = (fn: () => Promise<void>) => { const next = tail.then(fn); tail = next.catch(error => log.warn('worker-input', 'failed', { toolId: deps.tool.id, error: String(error) })); return next; };
  const active = (scope: string, nativeId: string) => {
    const binding = deps.controls.toolBindings?.get(scope);
    return !!binding && binding.toolId === deps.tool.id && binding.sourceId === deps.tool.sourceId && binding.nativeId === nativeId &&
      !deps.catalog.isScopeArchived(scope) && !deps.controls.toolBindings!.isArchived(binding.toolId, binding.sourceId, nativeId) &&
      (!deps.controls.auxiliary?.isAuxiliary(scope) || deps.controls.auxiliary.isActive(scope));
  };
  const card = (record: QuestionRecord, delivery: Delivery) => codexInputCard(record.request, delivery.token, record.status, deps.tool.label, '__worker_input');
  const render = async (record: QuestionRecord) => {
    for (const delivery of record.deliveries) {
      if (!delivery.cardId || !delivery.messageId || delivery.lastStatus === record.status || !active(delivery.scope, record.request.threadId)) continue;
      delivery.sequence++; await save();
      await deps.channel.updateCardById(delivery.cardId, card(record, delivery), delivery.sequence);
      delivery.lastStatus = record.status; await save();
    }
  };
  const scopesFor = (nativeId: string, question: WorkerQuestion) => {
    if (question.origin === 'worker') {
      const delivery = question.delivery;
      return delivery && delivery.botAppId === deps.controls.profileConfig.accounts.app.id && delivery.sourceId === deps.tool.sourceId && active(delivery.scope, nativeId) ? [delivery.scope] : [];
    }
    if (question.origin !== 'native') return [];
    return [...deps.controls.toolBindings?.entries() ?? []].filter(([scope, binding]) => /^oc_[A-Za-z0-9]+$/.test(scope) &&
      active(scope, nativeId) && !binding.linkedSource && !binding.auxiliaryWorkgroup && !deps.controls.auxiliary?.isAuxiliary(scope)).map(([scope]) => scope);
  };
  const tick = () => running ??= serialize(async () => {
    if (stopped) return;
    const ids = new Set([...deps.controls.toolBindings?.entries() ?? []].filter(([scope, binding]) => binding.nativeId && active(scope, binding.nativeId)).map(([, binding]) => binding.nativeId!));
    for (const id of ids) {
      let questions: WorkerQuestion[];
      try { questions = await deps.client.questions(id); } catch { continue; }
      const live = new Map(questions.map(question => [question.id, question]));
      for (const [key, record] of stored) if (record.request.threadId === id && !live.has(key) && ['waiting', 'unavailable', 'disconnected'].includes(record.status)) {
        record.status = 'resolved'; await save(); await render(record);
      }
      for (const question of questions) {
        if (stopped || question.request.threadId !== id) continue;
        let record = stored.get(question.id);
        if (!record) { record = { request: question.request, status: question.available ? 'waiting' : 'unavailable', deliveries: [] }; stored.set(question.id, record); }
        record.request = question.request;
        if (record.status === 'submitted' && question.request.kind === 'async' && question.available && question.request.answeredQuestionIds?.length && question.request.answeredQuestionIds.length < question.request.questions.length) record.status = 'waiting';
        if (['waiting', 'unavailable', 'disconnected'].includes(record.status)) record.status = question.available ? 'waiting' : 'unavailable';
        for (const scope of scopesFor(id, question)) {
          let delivery = record.deliveries.find(item => item.scope === scope);
          if (!delivery) { delivery = { scope, token: randomBytes(24).toString('hex'), cardId: '', messageId: '', sequence: 0 }; record.deliveries.push(delivery); await save(); }
          if (!delivery.messageId) {
            if (delivery.sendingAt && Date.now() - delivery.sendingAt > 55 * 60_000) continue;
            if (!delivery.cardId) { delivery.cardId = (await deps.channel.createCard(card(record, delivery))).cardId; await save(); }
            delivery.sendingAt ??= Date.now(); await save();
            if (!active(scope, id) || stopped) continue;
            const uuid = createHash('sha256').update(JSON.stringify([deps.tool.id, deps.tool.sourceId, question.id, scope])).digest('hex').slice(0, 48);
            const response = await deps.channel.rawClient.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: {
              receive_id: scope.split(':')[0]!, msg_type: 'interactive', uuid, content: JSON.stringify({ type: 'card', data: { card_id: delivery.cardId } }),
            } });
            if (response.code || !response.data?.message_id) throw new Error('Question delivery not acknowledged');
            delivery.messageId = response.data.message_id; delivery.lastStatus = record.status; await save();
          }
        }
        await render(record);
      }
    }
  }).finally(() => { running = undefined; });
  const timer = setInterval(() => void tick().catch(() => {}), deps.intervalMs ?? 2000); timer.unref();
  void tick().catch(() => {});
  return {
    runNow: tick,
    ownsToken(token: string) { return [...stored.values()].some(record => record.deliveries.some(delivery => delivery.token === token)); },
    handleAction(scope: string, messageId: string, token: string, form?: Record<string, unknown>) { return serialize(async () => {
      const pair = [...stored].find(([, record]) => record.deliveries.some(delivery => delivery.scope === scope && delivery.messageId === messageId && delivery.token === token));
      if (!pair || stopped) throw new Error('问题已失效');
      const [id, record] = pair;
      if (!active(scope, record.request.threadId) || !['waiting', 'unavailable', 'disconnected'].includes(record.status)) throw new Error('问题已结束或回答已提交');
      const current = (await deps.client.questions(record.request.threadId)).find(question => question.id === id);
      if (!current?.available || !scopesFor(record.request.threadId, current).includes(scope)) throw new Error('当前问题不可回答，请在工具界面查看');
      const answers = codexAnswersFromForm(current.request, form ?? {});
      record.status = 'submitting'; await save(); await render(record);
      try {
        const accepted = await deps.client.answer(record.request.threadId, id, answers);
        record.status = accepted ? 'submitted' : 'resolved';
      } catch (error) { record.status = 'unconfirmed'; await save(); await render(record); throw error; }
      await save(); await render(record);
    }); },
    async stop() { if (stopped) return; stopped = true; clearInterval(timer); await running; await tail; await save(); },
  };
}
