import { randomUUID } from 'node:crypto';
import { createLarkChannel } from '@larksuite/channel';
import { expect, it } from 'vitest';
import { configFormCard, type ConfigFormOpts } from '../../../src/card/config-card';

it('accepts successive model refreshes on one updated card while deduplicating redelivery', async () => {
  const channel = createLarkChannel({ appId: 'test', appSecret: 'test', safety: { chatQueue: { enabled: false } },
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
  // Exercise the installed SDK's real callback normalization and dedup path,
  // without connecting to Feishu or sending messages.
  const sdk = channel as unknown as {
    registerDispatcherHandlers(): void;
    dispatcher: { invoke(event: unknown, options: { needCheck: boolean }): Promise<unknown> };
    safety: { dispose(): Promise<void> };
  };
  const options: ConfigFormOpts = { agentKind: 'zcode', model: 'default', modelOptions: [{ value: 'default', label: '默认' }],
    reasoningEffort: 'high', messageReply: 'card', cotMessages: 'off', maxConcurrentRuns: 10,
    runIdleTimeoutMinutes: 0, requireMentionInGroup: true, larkCliIdentity: 'bot-only',
    allowedUsers: [], allowedChats: [], admins: [], knownChats: [] };
  const refreshValue = () => {
    const card = configFormCard(options) as any;
    return card.body.elements.find((e: any) => e.tag === 'column_set').columns[0].elements[0].behaviors[0].value;
  };
  const messageId = randomUUID();
  let reads = 0;
  channel.on('cardAction', () => { reads++; });
  sdk.registerDispatcherHandlers();
  const click = (value: unknown) => sdk.dispatcher.invoke({ schema: '2.0',
    header: { event_type: 'card.action.trigger', event_id: randomUUID() },
    event: { context: { open_message_id: messageId, open_chat_id: 'oc_group' }, operator: { open_id: 'ou_owner' },
      action: { tag: 'button', name: 'models_refresh', value } },
  }, { needCheck: false });
  try {
    const first = refreshValue();
    await click(first); expect(reads).toBe(1);
    await click(first); expect(reads).toBe(1);
    options.modelOptions!.push({ value: 'new-provider-3/glm-5.3', label: 'tars-point / glm-5.3' });
    const updated = refreshValue();
    await click(updated); expect(reads).toBe(2);
    await click(updated); expect(reads).toBe(2);
  } finally { await sdk.safety.dispose(); }
});
