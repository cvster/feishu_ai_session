import type { LarkChannel } from '@larksuite/channel';
import { checkSendWindow, deliveryUuid, sendDeliveryMessage, type CardTarget } from '../card/multipart';

export interface CompletionDelivery { completionMessageId?: string; completionSendingSince?: number }

/** Send a new @ message: editing a previously delivered card cannot be relied
 * on to notify users. The persisted uuid also deduplicates ambiguous retries. */
export async function notifyCompletion(input: {
  channel: LarkChannel; target: CardTarget; ownerId?: string; key: string;
  delivery: CompletionDelivery; save(): Promise<void>; active(): boolean; now?: number;
}): Promise<void> {
  if (!input.ownerId || input.delivery.completionMessageId || !input.target.chatId.startsWith('oc_') || !input.active()) return;
  const now = input.now ?? Date.now();
  checkSendWindow(input.delivery.completionSendingSince, now);
  input.delivery.completionSendingSince ??= now;
  await input.save();
  if (!input.active()) return;
  input.delivery.completionMessageId = await sendDeliveryMessage(input.channel, input.target, 'post', JSON.stringify({ zh_cn: {
    title: '', content: [[{ tag: 'at', user_id: input.ownerId }, { tag: 'text', text: ' 本次回复已结束。' }]],
  } }), deliveryUuid(`${input.key}:completion`));
  await input.save();
}
