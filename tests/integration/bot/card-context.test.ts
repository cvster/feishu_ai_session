import { expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { fetchQuotedContext, fetchTopicContext } from '../../../src/bot/quote';
import { wrapAuxiliaryPrompt } from '../../../src/bot/auxiliary-groups';
import { buildDirectUserPrompt } from '../../../src/agent/prompt';

const answer = '其余29个电机ID符合范围。\n颈部62/63未应答。\n\n```json\n{"motor_id":8}\n```';
const source = { schema: '2.0', config: { summary: { content: '已完成' } }, body: { elements: [
  { tag: 'markdown', content: answer, element_id: '_16' },
  { tag: 'markdown', content: "<font color='green'>✅ 已完成 · 用时 18秒 · 最近更新 17:33:51 · 项目 a1</font>", element_id: '_15' },
  { tag: 'column_set', columns: [{ tag: 'column', elements: [{ tag: 'interactive_container', behaviors: [{ type: 'callback', value: { cmd: 'stop', bridge_token: 'PRIVATE_CALLBACK' } }],
    elements: [{ tag: 'img', img_key: 'img_control', alt: { tag: 'plain_text', content: '停止当前回复' } }] }] }] },
] } };
const item = (raw: unknown = source) => ({ message_id: 'om_reply', msg_type: 'interactive', body: { content: JSON.stringify(raw) },
  sender: { id: 'app', sender_type: 'app' }, create_time: '1794821614755' });

it.each(['api', 'webhook'] as const)('projects %s reply quotes before auxiliary JSON wrapping, preserving only the answer', async mode => {
  const raw = mode === 'api' ? source : { elements: [{ tag: 'plain_text', content: '请升级至最新版本客户端' }], user_dsl: JSON.stringify(source) };
  const fetchRawMessage = vi.fn(async () => [item(raw)]);
  const quote = await fetchQuotedContext({ fetchRawMessage } as unknown as LarkChannel, 'om_reply');
  expect(quote?.content).toBe('<interactive_card>\n' + answer + '\n</interactive_card>');
  expect(fetchRawMessage).toHaveBeenCalledWith('om_reply', { cardContentType: 'user_card_content' });
  const prompt = wrapAuxiliaryPrompt(buildDirectUserPrompt({ userInput: '本次检查帮我做个简单的表格吧', quotedMessages: [quote!] }), false, { chatId: 'oc_aux' });
  const request = JSON.parse(prompt);
  expect(request.type).toBe('group_request'); expect(request.rules.permissions).toContain('修改源码');
  const context = JSON.parse(request.user_input.match(/<lark_context>\n([\s\S]*?)\n<\/lark_context>/)[1]);
  expect(context.quotes[0].content).toBe('<interactive_card>\n' + answer + '\n</interactive_card>');
  expect(request.user_input).toContain('本次检查帮我做个简单的表格吧');
  expect(prompt).not.toMatch(/PRIVATE_CALLBACK|img_control|element_id|streaming_mode|最近更新|请升级/);
});

it('uses the same readable projection for topic history and cards nested in merged forwards', async () => {
  const card = item(), text = { message_id: 'om_text', msg_type: 'text', body: { content: JSON.stringify({ text: '现场补充' }) }, create_time: '1794821615755' };
  const parent = { message_id: 'om_forward', msg_type: 'merge_forward', body: { content: '{}' } };
  const controls = { ...item({ elements: [{ tag: 'button', text: { tag: 'plain_text', content: 'DELETE_CONTROL' }, value: { secret: 'PRIVATE' } }] }), message_id: 'om_controls' };
  const channel = { rawClient: { im: { v1: { message: { list: vi.fn(async () => ({ data: { items: [card], has_more: false } })) } } } },
    fetchRawMessage: vi.fn(async () => [parent, card, text, controls]) } as unknown as LarkChannel;
  const topic = await fetchTopicContext(channel, 'omt_topic', { maxMessages: 5 });
  expect(topic[0]?.content).toBe('<interactive_card>\n' + answer + '\n</interactive_card>');
  const forward = await fetchQuotedContext(channel, 'om_forward');
  expect(forward?.content).toContain('<forwarded_messages>'); expect(forward?.content).toContain('其余29个电机ID符合范围');
  expect(forward?.content).toContain('现场补充');
  expect(forward?.content).not.toMatch(/PRIVATE|DELETE_CONTROL|img_control|element_id|最近更新/);
});

it('keeps ordinary quoted JSON text literal instead of interpreting it as a card', async () => {
  const content = JSON.stringify(source);
  const channel = { fetchRawMessage: async () => [{ message_id: 'om_json', msg_type: 'text', body: { content: JSON.stringify({ text: content }) } }] } as unknown as LarkChannel;
  expect((await fetchQuotedContext(channel, 'om_json'))?.content).toBe(content);
});
