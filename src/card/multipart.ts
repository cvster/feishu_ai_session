import { createHash } from 'node:crypto';
import type { LarkChannel } from '@larksuite/channel';

// Feishu recommends <=30 KB, including style expansion. Reserve 4 KB and
// measure both the card JSON and its escaped API envelope (not JS characters).
export const CARD_BUDGET_BYTES = 26_000;
export function cardBytes(card: object): number {
  const json = JSON.stringify(card);
  return Math.max(Buffer.byteLength(json), Buffer.byteLength(JSON.stringify({ data: json })));
}
type Element = { tag?: string; content?: string; elements?: Element[]; [key: string]: unknown };
type Card = { body: { elements: Element[]; [key: string]: unknown }; [key: string]: unknown };

/** Split rendered cards, including Markdown inside collapsed detail panels. */
export function splitCard(input: object): object[] {
  if (cardBytes(input) <= CARD_BUDGET_BYTES) return [input];
  const card = input as Card;
  if (!card.body?.elements) throw new Error('超长卡片缺少可拆分的正文');
  const withElements = (elements: Element[]): Card => ({ ...card, body: { ...card.body, elements } });
  const fits = (element: Element) => cardBytes(withElements([element])) <= CARD_BUDGET_BYTES;
  function splitElement(element: Element, wrap: (value: Element) => Element): Element[] {
    if (fits(wrap(element))) return [element];
    if (element.tag === 'markdown' && typeof element.content === 'string') {
      const chars = Array.from(element.content);
      const fragments: Element[] = [];
      let offset = 0;
      let fence = '';
      while (offset < chars.length) {
        const prefix = fence ? `${fence}\n` : '';
        const build = (count: number) => {
          const raw = chars.slice(offset, offset + count).join('');
          let nextFence = fence;
          for (const line of raw.split('\n')) {
            const match = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
            if (match) {
              if (!nextFence) nextFence = `${match[1]}${match[2]}`;
              else if (match[1]![0] === nextFence[0] && !match[2]!.trim()) nextFence = '';
            }
          }
          const suffix = nextFence ? `\n${nextFence.match(/^(`+|~+)/)![0]}` : '';
          return { raw, nextFence, value: { ...element, content: prefix + raw + suffix } };
        };
        let low = 0, high = chars.length - offset;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (fits(wrap(build(mid).value))) low = mid; else high = mid - 1;
        }
        if (!low) throw new Error('卡片元数据过大，无法容纳正文');
        // Prefer line boundaries. Very long individual lines still split safely
        // at Unicode code points, without dropping any input characters.
        if (offset + low < chars.length) {
          const newline = chars.slice(offset, offset + low).lastIndexOf('\n');
          if (newline > low / 2) low = newline + 1;
        }
        const part = build(low);
        fragments.push(part.value); offset += low; fence = part.nextFence;
      }
      return fragments;
    }
    if (element.elements?.length) {
      const pieces: Element[] = [];
      for (const child of element.elements) {
        const parent = (value: Element) => wrap({ ...element, elements: [value] });
        for (const piece of splitElement(child, parent)) pieces.push({ ...element, elements: [piece] });
      }
      return pieces;
    }
    throw new Error('卡片单个非文本组件超过大小限制');
  }
  const cards: object[] = [];
  let elements: Element[] = [];
  for (const element of card.body.elements) {
    for (const piece of splitElement(element, value => value)) {
      if (elements.length && cardBytes(withElements([...elements, piece])) > CARD_BUDGET_BYTES) {
        cards.push(withElements(elements)); elements = [];
      }
      elements.push(piece);
    }
  }
  if (elements.length) cards.push(withElements(elements));
  return cards;
}

export interface CardPart {
  cardId?: string;
  messageId?: string;
  sequence: number;
  sendingSince?: number;
  hash?: string;
}
export interface MultipartDelivery {
  // Keep the first part in these legacy fields for existing refresh/stop APIs.
  cardId?: string;
  messageId?: string;
  sequence: number;
  sendingSince?: number;
  parts?: CardPart[];
}
export interface CardTarget { chatId: string; replyTo?: string; replyInThread?: boolean }
export const deliveryUuid = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 48);
export function checkSendWindow(since: number | undefined, now: number): void {
  if (since !== undefined && now - since >= 55 * 60_000) throw new Error('消息发送结果未确认且已超过去重窗口，暂停自动重发');
}
export async function sendDeliveryMessage(channel: LarkChannel, target: CardTarget, type: string, content: string, uuid: string): Promise<string> {
  const data = { msg_type: type, content, uuid };
  const response = target.replyTo
    ? await channel.rawClient.im.v1.message.reply({ path: { message_id: target.replyTo }, data: { ...data, ...(target.replyInThread ? { reply_in_thread: true } : {}) } })
    : await channel.rawClient.im.v1.message.create({ params: { receive_id_type: 'chat_id' }, data: { ...data, receive_id: target.chatId } });
  if (response.code || !response.data?.message_id) throw new Error(`消息发送未确认：${response.code ?? 'missing-message-id'} ${response.msg ?? ''}`);
  return response.data.message_id;
}

/** Journal-backed multipart publisher: every part keeps its own id, sequence
 * and ambiguous-send window across retries and bridge restarts. */
export async function publishCards(input: {
  channel: LarkChannel; target: CardTarget; card: object; delivery: MultipartDelivery;
  key: string; save(): Promise<void>; active(): boolean; now?: number;
  cards?: object[];
  force?: boolean;
}): Promise<void> {
  const { channel, target, delivery, save } = input;
  const check = () => { if (!input.active()) throw new Error('会话已归档或已重新绑定'); };
  check();
  const cards = input.cards ?? splitCard(input.card);
  delivery.parts ??= delivery.cardId ? [{ cardId: delivery.cardId, messageId: delivery.messageId, sequence: delivery.sequence, sendingSince: delivery.sendingSince }] : [];
  const now = input.now ?? Date.now();
  for (let index = 0; index < Math.max(cards.length, delivery.parts.length); index++) {
    check();
    // Clear stale trailing parts when an answer is replaced with a shorter one.
    const card = cards[index] ?? { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '内容已更新，请查看前面的卡片。' }] } };
    const hash = deliveryUuid(JSON.stringify(card));
    const part = delivery.parts[index] ??= { sequence: 0 };
    const persist = async () => {
      if (index === 0) Object.assign(delivery, { cardId: part.cardId, messageId: part.messageId, sequence: part.sequence, sendingSince: part.sendingSince });
      await save();
    };
    if (!input.force && part.hash === hash && part.messageId) continue;
    if (!part.cardId) { part.cardId = (await channel.createCard(card)).cardId; await persist(); }
    check();
    if (!part.messageId) {
      if (index === 0 && delivery.sendingSince !== undefined) part.sendingSince = delivery.sendingSince;
      checkSendWindow(part.sendingSince, now);
      part.sendingSince ??= now;
      if (index === 0) delivery.sendingSince = part.sendingSince;
      await persist(); check();
      part.messageId = await sendDeliveryMessage(channel, target, 'interactive', JSON.stringify({ type: 'card', data: { card_id: part.cardId } }),
        // Preserve the old first-message uuid on migration/retry.
        deliveryUuid(index === 0 ? input.key : `${input.key}:part:${index}`));
      await persist();
    }
    part.sequence++; await persist(); check();
    await channel.updateCardById(part.cardId, card, part.sequence);
    part.hash = hash;
    await persist();
  }
}

/** Keep the SDK's first streaming card and allocate continuation messages only
 * when its body grows beyond the budget. Worker paths use the persisted form. */
export function multipartStreamUpdater(input: {
  channel: LarkChannel; target: CardTarget; key: string;
  updatePrimary(card: object): Promise<void>; active(): boolean;
}): (card: object) => Promise<void> {
  const delivery: MultipartDelivery = { sequence: 0 };
  let pending = Promise.resolve();
  return card => {
    const result = pending.then(async () => {
      const cards = splitCard(card);
      await input.updatePrimary(cards[0]!);
      const continuations = cards.slice(1).map(part => ({ ...part, config: {
        ...(part as { config?: object }).config, streaming_mode: false,
      } }));
      if (cards.length > 1 || delivery.parts?.length) await publishCards({ ...input, card, cards: continuations,
        key: `${input.key}:continuation`, delivery, save: async () => {} });
    });
    pending = result.catch(() => {});
    return result;
  };
}
