import { expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { CARD_BUDGET_BYTES, cardBytes, publishCards, splitCard, type MultipartDelivery } from '../../../src/card/multipart';
import { renderCard, type RunCardRenderOptions } from '../../../src/card/run-renderer';
import { initialState, reduce } from '../../../src/card/run-state';

function card(content: string): object { return { schema: '2.0', body: { elements: [{ tag: 'markdown', content }] } }; }
function markdowns(value: any): string[] {
  if (!value || typeof value !== 'object') return [];
  return [...(value.tag === 'markdown' ? [value.content] : []), ...Object.values(value).flatMap(markdowns)];
}
it('never serializes reasoning or tool details, including an obsolete opt-in, while retaining the answer', () => {
  let state = reduce(initialState, { type: 'thinking', delta: 'private thoughts' });
  state = reduce(state, { type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'secret command' } });
  state = reduce(state, { type: 'tool_result', id: 'tool', output: 'private tool output', isError: false });
  state = reduce(state, { type: 'text', delta: 'visible answer' });
  for (const terminal of ['running', 'done'] as const) for (const auxiliary of [false, true]) {
    const json = JSON.stringify(renderCard({ ...state, terminal }, { auxiliary, showDetails: true } as RunCardRenderOptions));
    expect(json).toContain('visible answer');
    expect(json).not.toContain('private thoughts'); expect(json).not.toContain('secret command');
    expect(json).not.toContain('private tool output'); expect(json).not.toContain('Bash');
  }
});
it.each(['中文😀', '"\\\n<font color="red">x</font>'])('splits %s by serialized bytes without losing characters', unit => {
  const full = unit.repeat(18_000);
  const cards = splitCard(card(full));
  expect(cards.length).toBeGreaterThan(1);
  for (const part of cards) expect(cardBytes(part)).toBeLessThanOrEqual(CARD_BUDGET_BYTES);
  expect(cards.flatMap(markdowns).join('')).toBe(full);
  expect(cards.flatMap(markdowns).every(text => !/[\uD800-\uDBFF]$/.test(text))).toBe(true);
});
it('keeps fenced code readable across cards and splits nested auxiliary details with the controls retained once', () => {
  const lines = Array.from({ length: 4000 }, (_, i) => `const item${i} = "中文😀";\n`);
  const full = '```ts\n' + lines.join('') + '```';
  const state = reduce(initialState, { type: 'text', delta: full });
  const cards = splitCard(renderCard(state, { auxiliary: true }));
  expect(cards.length).toBeGreaterThan(2);
  for (const part of cards) expect(cardBytes(part)).toBeLessThanOrEqual(CARD_BUDGET_BYTES);
  const code = cards.flatMap(markdowns).filter(text => text.includes('const item'));
  expect(code.every(text => text.startsWith('```ts\n') && text.endsWith('```'))).toBe(true);
  expect(code.join('').match(/const item\d+ =/g)).toHaveLength(4000);
  const json = JSON.stringify(cards);
  expect(json.match(/"cmd":"stop"/g)).toHaveLength(1);
  expect(json.match(/"cmd":"refresh"/g)).toHaveLength(1);
});
it('recovers a lost continuation acknowledgement with the same uuid and card, updates growing output, and clears stale parts', async () => {
  const reply = vi.fn(async () => ({ code: 0, data: { message_id: `om_${reply.mock.calls.length}` } }));
  const createCard = vi.fn(async () => ({ cardId: `card_${createCard.mock.calls.length}` }));
  const updateCardById = vi.fn(async () => {});
  const channel = { createCard, updateCardById, rawClient: { im: { v1: { message: { reply } } } } } as unknown as LarkChannel;
  let delivery: MultipartDelivery = { sequence: 0 };
  let persisted = '';
  const save = async () => { persisted = JSON.stringify(delivery); };
  const publish = (content: string) => publishCards({ channel, target: { chatId: 'oc_group', replyTo: 'om_origin', replyInThread: true },
    delivery, card: card(content), save, key: 'turn', active: () => true });
  const full = '中文😀\n'.repeat(9000);
  reply.mockImplementationOnce(async () => ({ code: 0, data: { message_id: 'om_first' } }))
    .mockRejectedValueOnce(new Error('lost ack'));
  await expect(publish(full)).rejects.toThrow('lost ack');
  delivery = JSON.parse(persisted);
  const firstCards = createCard.mock.calls.length;
  await publish(full);
  const requests = reply.mock.calls as unknown as { data: { uuid: string; reply_in_thread?: boolean } }[][];
  expect(requests[1]![0]!.data.uuid).toBe(requests[2]![0]!.data.uuid);
  expect(requests.every(([request]) => request!.data.reply_in_thread)).toBe(true);
  expect(createCard.mock.calls.length).toBe(splitCard(card(full)).length);
  expect(firstCards).toBe(2);
  const sends = reply.mock.calls.length;
  await publish(full); expect(reply).toHaveBeenCalledTimes(sends);
  await publish(full + 'more\n'.repeat(2000));
  await publish('short answer');
  expect(JSON.stringify(updateCardById.mock.calls)).toContain('内容已更新');
  expect(delivery.messageId).toBe('om_first');
});
