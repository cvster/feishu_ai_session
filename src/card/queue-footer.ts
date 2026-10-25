import type { QueuedMessage } from '../bot/message-queue';

export function queuePreview(text: string, limit = 80): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.slice(0, limit).join('') + (chars.length > limit ? '…' : '');
}

/** Appended after the normal reply controls, with plain one-line previews. */
export function queueFooter(items: QueuedMessage[]): object[] {
  if (!items.length) return [];
  return [{ tag: 'markdown', content: `**排队消息（${items.length}）**`, text_size: 'notation' }, ...items.map(item => {
    return { tag: 'column_set', flex_mode: 'none', columns: [
      { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [
        { tag: 'div', text: { tag: 'plain_text', content: queuePreview(item.text), lines: 1 } },
      ] },
      { tag: 'column', width: 'auto', vertical_align: 'center', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '删除' }, type: 'danger',
        behaviors: [{ type: 'callback', value: { cmd: 'queue.remove', arg: item.id } }] }] },
    ] };
  })];
}
