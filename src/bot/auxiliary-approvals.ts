import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { CardActionEvent, LarkChannel, NormalizedMessage } from '@larksuite/channel';
import type { AuxiliaryGroups } from './auxiliary-groups';
import type { ToolBindingStore } from '../tools/bindings';
import type { RunState } from '../card/run-state';
import { writeFileAtomic } from '../platform/atomic-write';
import { log } from '../core/logger';

interface RequestContext {
  scope: string;
  generation: string;
  actorId: string;
  groupName?: string;
  message: NormalizedMessage;
  text: string;
}
export interface AuxiliaryApproval extends RequestContext {
  id: string;
  runId: string;
  nativeId: string;
  sharedScope: string;
  ownerId: string;
  action: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'approved' | 'resuming' | 'resumed' | 'denied' | 'expired' | 'stale' | 'unknown';
  cardId?: string;
  cardMessageId?: string;
  cardSendingSince?: number;
  sequence: number;
  receiptMessageId?: string;
}
interface Deps {
  path: string;
  channel: LarkChannel;
  auxiliary: AuxiliaryGroups;
  bindings: ToolBindingStore;
  ownerId(): string | undefined;
  resume(approval: AuxiliaryApproval): Promise<void>;
  validateApi?(scope: string): Promise<boolean>;
  now?(): number;
}

/** A model may request review; only an authenticated owner callback can grant it. */
export class AuxiliaryApprovals {
  private requests: Record<string, RequestContext> = {};
  private approvals: Record<string, AuxiliaryApproval> = {};
  private writes: Promise<void> = Promise.resolve();
  private chains = new Map<string, Promise<unknown>>();
  constructor(private readonly deps: Deps) {}
  private now(): number { return this.deps.now?.() ?? Date.now(); }
  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.deps.path, 'utf8'));
      if (data.version !== 1 || !data.requests || !data.approvals || Array.isArray(data.requests) || Array.isArray(data.approvals)) throw new Error('Invalid auxiliary approval ledger');
      for (const r of Object.values(data.requests) as RequestContext[]) if (!r?.scope || !r.generation || !r.actorId || !r.message?.messageId || typeof r.text !== 'string') throw new Error('Invalid approval request context');
      for (const [id, r] of Object.entries(data.approvals) as [string, AuxiliaryApproval][]) {
        if (r.id !== id || !r.scope || !r.ownerId || !r.message?.chatId || !r.action || !r.reason || !Number.isFinite(r.expiresAt) ||
          !['pending', 'approved', 'resuming', 'resumed', 'denied', 'expired', 'stale', 'unknown'].includes(r.status)) throw new Error('Invalid auxiliary approval');
        if (r.status === 'resuming' && !r.receiptMessageId) r.status = 'unknown';
      }
      this.requests = data.requests; this.approvals = data.approvals;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private key(scope: string, messageId: string): string { return JSON.stringify([scope, messageId]); }
  private privateDelivery(scope: string): boolean { return !!(this.deps.auxiliary.privateRequest(scope) || this.deps.auxiliary.apiRequest(scope)); }
  apiStatus(scope: string): AuxiliaryApproval['status'] | undefined {
    const r = Object.values(this.approvals).filter(r => r.scope === scope).at(-1);
    if (!r) return;
    if (!this.current(r)) return 'stale';
    return r.status === 'pending' && this.now() > r.expiresAt ? 'expired' : r.status;
  }
  async remember(scope: string, messages: readonly NormalizedMessage[], text: string): Promise<void> {
    const first = messages[0], last = messages.at(-1), group = this.deps.auxiliary.get(scope);
    if (!first || !last || !group || !this.deps.auxiliary.isActive(scope)) return;
    this.requests[this.key(scope, last.messageId)] = { scope, generation: group.generation, actorId: first.senderId, groupName: group.name,
      message: { ...last, senderId: first.senderId }, text };
    this.requests = Object.fromEntries(Object.entries(this.requests).slice(-1000));
    await this.save();
  }
  private current(r: AuxiliaryApproval): boolean {
    const binding = this.deps.bindings.get(r.scope);
    return this.deps.auxiliary.isActive(r.scope) && this.deps.auxiliary.get(r.scope)?.generation === r.generation &&
      !this.deps.auxiliary.privateRequest(r.scope)?.cancelled && this.deps.ownerId() === r.ownerId &&
      binding?.sharedScope === r.sharedScope && binding.nativeId === r.nativeId;
  }
  grant(scope: string, messageIds: readonly string[], actorIds: readonly string[]): AuxiliaryApproval | undefined {
    if (messageIds.length !== 1 || !actorIds.length) return;
    return Object.values(this.approvals).find(r => r.scope === scope && r.receiptMessageId === messageIds[0] &&
      ['approved', 'resuming', 'resumed'].includes(r.status) && this.current(r) && actorIds.every(actor => actor === r.actorId));
  }
  /** Split approved continuations from ordinary coworker batches, even for the same actor. */
  batchKey(scope: string, messageId: string): string {
    return Object.values(this.approvals).find(r => r.scope === scope && r.receiptMessageId === messageId)?.id ?? '';
  }
  async review(scope: string, runId: string, replyTo: string | undefined, state: RunState): Promise<RunState> {
    if (!this.deps.auxiliary.isActive(scope)) return state;
    const text = [...state.blocks].reverse().find(block => block.kind === 'text');
    if (!text || text.kind !== 'text') return state;
    const request = parseApprovalRequest(text.content);
    if (!request) return state;
    if (state.terminal !== 'done') return approvalNotice(state, '需要所有者确认，正在准备确认请求。');
    const context = replyTo ? this.requests[this.key(scope, replyTo)] : undefined;
    const binding = this.deps.bindings.get(scope), owner = this.deps.ownerId();
    if (!context || !binding?.sharedScope || !binding.nativeId || !owner || context.actorId === owner) return state;
    const key = createHash('sha256').update(JSON.stringify([scope, runId])).digest('hex');
    return this.serial(key, async () => {
      let approval = this.approvals[key];
      if (!approval) {
        approval = { ...context, id: key, runId, nativeId: binding.nativeId!, sharedScope: binding.sharedScope!, ownerId: owner,
          ...request, createdAt: this.now(), expiresAt: this.now() + 60 * 60_000, status: 'pending', sequence: 0 };
        this.approvals[key] = approval; await this.save();
      }
      if (approval.status === 'pending' && !approval.cardMessageId) await this.sendCard(approval);
      return approvalNotice(state, approval.status === 'denied' ? '所有者已拒绝，本次受限操作未执行。'
        : ['approved', 'resuming', 'resumed'].includes(approval.status) ? '所有者已同意，本次请求正在继续处理。'
        : ['stale', 'expired'].includes(approval.status) ? '确认请求已失效，本次受限操作未执行。'
        : '需要所有者确认，已发送确认卡片；同意后继续执行。', approval.status === 'pending' ? 'pending' : approval.status === 'denied' ? 'denied' : ['approved', 'resuming', 'resumed'].includes(approval.status) ? 'approved' : approval.status === 'unknown' ? 'unknown' : 'expired');
    });
  }
  private async sendCard(r: AuxiliaryApproval): Promise<void> {
    if (!this.current(r)) { r.status = 'stale'; await this.save(); return; }
    if (!r.cardId) { r.cardId = (await this.deps.channel.createCard(approvalCard(r, this.privateDelivery(r.scope)))).cardId; await this.save(); }
    if (r.cardSendingSince && this.now() - r.cardSendingSince > 55 * 60_000) throw new Error('确认卡片发送结果不明且超过去重窗口，请联系所有者检查。');
    r.cardSendingSince ??= this.now(); await this.save();
    const privateRequest = this.privateDelivery(r.scope);
    const result = await this.deps.channel.rawClient.im.v1.message.create({ params: { receive_id_type: privateRequest ? 'open_id' : 'chat_id' },
      data: { receive_id: privateRequest ? r.ownerId : r.message.chatId, msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: r.cardId } }), uuid: `ff-approval-${r.id.slice(0, 32)}` } });
    if (result.code || !result.data?.message_id) throw new Error(`确认卡片未确认送达（${result.code ?? '缺少消息编号'}）`);
    r.cardMessageId = result.data.message_id; await this.save();
  }
  async action(event: CardActionEvent): Promise<boolean> {
    const value = event.action.value as Record<string, unknown> | undefined;
    if (value?.cmd !== 'auxiliary.approval') return false;
    const id = typeof value.id === 'string' ? value.id : '';
    if (!['approve', 'deny'].includes(String(value.decision))) return true;
    await this.serial(id, async () => {
      const r = this.approvals[id];
      if (!r || event.operator.openId !== r.ownerId || this.deps.ownerId() !== r.ownerId || event.messageId !== r.cardMessageId) return;
      if (this.privateDelivery(r.scope)) { if (await this.deps.channel.getChatMode(event.chatId) !== 'p2p') return; }
      else if (event.chatId !== r.message.chatId) return;
      if (!this.current(r)) { r.status = 'stale'; await this.save(); await this.updateCard(r); return; }
      if (r.status !== 'pending' && !(r.status === 'approved' && value.decision === 'approve')) return;
      if (r.status === 'pending' && this.now() > r.expiresAt) { r.status = 'expired'; await this.save(); await this.updateCard(r); return; }
      r.status = value.decision === 'approve' ? 'approved' : 'denied'; await this.save();
      if (r.status === 'approved') {
        try { await this.continue(r); } catch (error) { await this.updateCard(r); throw error; }
      }
      await this.updateCard(r);
      if (r.status === 'denied' && this.deps.auxiliary.privateRequest(r.scope)) await this.deps.channel.send(r.message.chatId,
        { text: `request_id=${this.deps.auxiliary.privateRequest(r.scope)!.requestId} · denied 所有者已拒绝，本次受限操作未执行。` }, { replyTo: r.message.messageId });
    });
    return true;
  }
  private async continue(r: AuxiliaryApproval): Promise<void> {
    if (!this.current(r)) { r.status = 'stale'; await this.save(); return; }
    const privateRequest = this.deps.auxiliary.privateRequest(r.scope);
    const apiRequest = this.deps.auxiliary.apiRequest(r.scope);
    if (apiRequest && !await this.deps.validateApi?.(r.scope)) { r.status = 'stale'; await this.save(); return; }
    if (privateRequest && !await this.deps.auxiliary.validatePrivate(r.scope, r.actorId, r.message.chatId)) {
      r.status = 'stale'; await this.save(); return;
    }
    r.status = 'resuming'; await this.save();
    if (!r.receiptMessageId) {
      if (apiRequest) {
        // This is an internal continuation identity, never a Feishu message.
        r.receiptMessageId = `a2a_approval_${r.id}`; await this.save();
      } else {
        try {
          const receipt = await this.deps.channel.send(r.message.chatId,
            { text: `${privateRequest ? `request_id=${privateRequest.requestId} ` : ''}所有者已同意，继续执行本次确认的操作。` }, { replyTo: r.message.messageId, ...(r.message.threadId ? { replyInThread: true } : {}) });
          r.receiptMessageId = receipt.messageId; await this.save();
        } catch (error) { r.status = 'unknown'; await this.save(); throw error; }
      }
    }
    try { await this.deps.resume(r); r.status = 'resumed'; await this.save(); }
    catch (error) { r.status = 'approved'; await this.save(); throw error; }
  }
  private async updateCard(r: AuxiliaryApproval): Promise<void> {
    if (!r.cardId) return;
    r.sequence++; await this.save();
    try { await this.deps.channel.updateCardById(r.cardId, approvalCard(r, this.privateDelivery(r.scope)), r.sequence); }
    catch (error) { log.warn('auxiliary-approval', 'card-update-failed', { id: r.id, error: String(error) }); }
  }
  async recover(): Promise<void> {
    for (const r of Object.values(this.approvals)) {
      if (r.status === 'pending') {
        try { await this.serial(r.id, async () => {
          if (!this.current(r) || this.now() > r.expiresAt) { r.status = this.current(r) ? 'expired' : 'stale'; await this.save(); await this.updateCard(r); }
          else if (!r.cardMessageId) await this.sendCard(r);
        }); } catch (error) { log.warn('auxiliary-approval', 'notify-recovery-failed', { id: r.id, error: String(error) }); }
      }
      if (['approved', 'resuming'].includes(r.status) && (r.status !== 'resuming' || r.receiptMessageId)) {
        try { await this.serial(r.id, async () => { await this.continue(r); await this.updateCard(r); }); }
        catch (error) { log.warn('auxiliary-approval', 'resume-failed', { id: r.id, error: String(error) }); }
      }
    }
  }
  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (this.chains.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    this.chains.set(key, next); void next.finally(() => { if (this.chains.get(key) === next) this.chains.delete(key); }).catch(() => {});
    return next;
  }
  private save(): Promise<void> {
    const data = JSON.stringify({ version: 1, requests: this.requests, approvals: this.approvals }, null, 2);
    this.writes = this.writes.catch(() => {}).then(() => writeFileAtomic(this.deps.path, data + '\n', { mode: 0o600 }));
    return this.writes;
  }
  async flush(): Promise<void> { await this.writes; }
}

export function parseApprovalRequest(text: string): { action: string; reason: string } | undefined {
  const clean = text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, '');
  let raw;
  try { raw = JSON.parse(clean); }
  catch {
    // Claude may concatenate an earlier progress sentence with its final JSON.
    const starts = [...clean.matchAll(/\{\s*"type"\s*:\s*"ff_permission_request"/g)];
    const start = starts.at(-1)?.index;
    if (start === undefined) return;
    try { raw = JSON.parse(clean.slice(start)); } catch { return; }
  }
  if (raw?.type !== 'ff_permission_request' || typeof raw.action !== 'string' || typeof raw.reason !== 'string' ||
    !raw.action.trim() || !raw.reason.trim() || raw.action.length > 2400 || raw.reason.length > 800) return;
  return { action: raw.action, reason: raw.reason };
}

function approvalNotice(state: RunState, content: string, permissionApproval: RunState['permissionApproval'] = 'pending'): RunState {
  return { ...state, permissionApproval, blocks: [{ kind: 'text', content, streaming: false }] };
}
export function approvalCard(r: AuxiliaryApproval, privateRequest: boolean): object {
  const pending = r.status === 'pending';
  const status = pending ? '仅本次操作有效，1 小时内确认。' : r.status === 'denied' ? '已拒绝，未执行。'
    : r.status === 'resumed' ? '已同意并提交继续执行。' : r.status === 'approved' ? '已同意，排队未完成，可再次点击同意重试。'
    : r.status === 'unknown' ? '继续请求状态未确认，请检查原会话；不会自动重复执行。' : '确认已失效或正在处理。';
  return { schema: '2.0', config: { width_mode: 'default', update_multi: true },
    header: { title: { tag: 'plain_text', content: '受限操作确认' }, template: pending ? 'yellow' : 'grey' },
    body: { elements: [
      { tag: 'markdown', content: `${privateRequest ? '请确认' : `<at id=${r.ownerId}></at> 请确认`}是否允许执行以下操作。` },
      { tag: 'div', text: { tag: 'plain_text', content: `来源：${r.groupName ?? "辅助会话"} · 提问者：${r.message.senderName || '群成员'}\n拟执行：${r.action}\n原因：${r.reason}` } },
      { tag: 'div', text: { tag: 'plain_text', content: status, text_size: 'notation' } },
      { tag: 'column_set', flex_mode: 'none', columns: ['approve', 'deny'].map((decision, i) => ({
        tag: 'column', width: 'weighted', weight: 1, elements: [{ tag: 'button',
          text: { tag: 'plain_text', content: i === 0 ? '同意执行' : '拒绝' }, type: i === 0 ? 'primary_filled' : 'default',
          disabled: !pending && !(r.status === 'approved' && i === 0),
          behaviors: [{ type: 'callback', value: { cmd: 'auxiliary.approval', id: r.id, decision } }],
        }],
      })) },
    ] },
  };
}
