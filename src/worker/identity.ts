import type { NormalizedMessage } from '@larksuite/channel';

export function messageRequestId(message: NormalizedMessage): string {
  const callback = message.rawContentType === 'card_action'
    ? (message.raw as { bridgeCallbackId?: string } | undefined)?.bridgeCallbackId : undefined;
  return callback ? `${message.messageId}:callback:${callback}` : message.messageId;
}
