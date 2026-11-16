import { expect, it } from 'vitest';
import { expandInteractiveCard, INTERACTIVE_CARD_PLACEHOLDER } from '../../../src/bot/interactive-card';
import { renderCard } from '../../../src/card/run-renderer';
import { initialState, reduce } from '../../../src/card/run-state';

const answer = '**其余29个电机ID均符合表中范围：双腿33–44、腰45–47、双臂48–61。**\n**未发现同一ID在多条总线上应答。**\n**目前ID异常仅见颈部：CAN0应答的是8，约定的62/63未应答。**\n**同一总线重复ID仍不能完全排除。**';
const card = (elements: unknown[]) => ({ schema: '2.0', body: { elements } });
const project = (raw: unknown, flattened = INTERACTIVE_CARD_PLACEHOLDER) => expandInteractiveCard(flattened, JSON.stringify(raw));

it.each(['api', 'webhook', 'serialized-elements'] as const)('projects the real bridge reply to its complete answer without UI metadata (%s)', mode => {
  const state = { ...reduce(reduce(initialState, { type: 'text', delta: answer }), { type: 'done', terminationReason: 'normal' }),
    projectName: 'a1', execution: { model: 'gpt-6.1-sol', reasoningEffort: 'high' as const },
    runtime: { startedAtMs: 0, lastActivityAtMs: 18000, checkedAtMs: 18000, processRunning: false } };
  const source: any = renderCard(state, { auxiliary: true, buttonImageKeys: { stop: 'img_v3_control_stop', refresh: 'img_v3_control_refresh' } });
  if (mode === 'serialized-elements') source.body.elements = source.body.elements.map((element: unknown) => JSON.stringify(element));
  const raw = mode === 'webhook' ? { elements: [{ tag: 'plain_text', content: '请升级至最新版本客户端' }], user_dsl: JSON.stringify(source) } : source;
  const output = project(raw, '请升级至最新版本客户端');
  expect(output).toBe('<interactive_card>\n' + answer + '\n</interactive_card>');
  expect(output).not.toMatch(/element_id|behaviors|callback|img_v3_control|schema|最近更新|停止|刷新|请升级/);
  expect(output.length).toBeLessThan(JSON.stringify(raw).length / 2);
});

it('keeps complete folded auxiliary answers without duplicating the preview or its controls', () => {
  const long = '详细说明。'.repeat(250) + '\n\n最后结论';
  const state = reduce(reduce(initialState, { type: 'text', delta: long }), { type: 'done', terminationReason: 'normal' });
  expect(project(renderCard(state, { auxiliary: true, auxiliaryPreviousReply: true }))).toBe('<interactive_card>\n' + long + '\n</interactive_card>');
});

it('keeps legacy card headings, columns, fields and Markdown literally, without traversing callbacks', () => {
  const literal = '```json\n{"schema":"2.0","body":{"elements":[]}}\n```\n\n[日志](https://example.com/log)';
  const raw = { header: { title: { tag: 'plain_text', content: '检查结果' } }, elements: [
    { tag: 'column_set', columns: [{ tag: 'column', elements: [{ tag: 'div', fields: [{ text: { tag: 'lark_md', content: '电机正常' } }] }] }] },
    { tag: 'markdown', content: literal },
    { tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '重启' }, value: { secret: 'CALLBACK_SECRET' } }] },
    { tag: 'interactive_container', behaviors: [{ type: 'callback', value: { secret: 'CALLBACK_SECRET' } }], elements: [{ tag: 'img', alt: { content: '停止' }, img_key: 'img_control' }] },
  ] };
  const output = project(raw);
  expect(output).toBe('<interactive_card>\n检查结果\n\n电机正常\n\n' + literal + '\n</interactive_card>');
  expect(output).not.toContain('CALLBACK_SECRET'); expect(output).not.toContain('img_control');
});

it('keeps images from the actual content but does not expose button images or form values', () => {
  const output = project(card([{ tag: 'img', img_key: 'img_diagram', alt: { tag: 'plain_text', content: '接线图' } },
    { tag: 'button', text: { tag: 'plain_text', content: '删除' }, img_key: 'img_control' },
    { tag: 'input', value: 'PRIVATE_FORM_VALUE' }]));
  expect(output).toBe('<interactive_card>\n![接线图](img_diagram)\n</interactive_card>');
});

it('keeps data tables as readable contiguous Markdown', () => {
  expect(project(card([{ tag: 'table', columns: [{ name: 'motor', display_name: '电机' }, { name: 'id', display_name: 'ID' }],
    rows: [{ motor: '左臂', id: 48 }, { motor: '右臂', id: 61 }] }]))).toContain('| 电机 | ID |\n| --- | --- |\n| 左臂 | 48 |\n| 右臂 | 61 |');
});

it('does not drop status-like content from unrelated cards or error details from bridge replies', () => {
  const status = "<font color='green'>✅ 已完成 · 用时 18秒 · 最近更新 17:33:51</font>";
  expect(project(card([{ tag: 'markdown', content: status }]))).toContain(status);
  const failed = { ...initialState, terminal: 'error' as const, errorMsg: 'CAN4 通信失败' };
  expect(project(renderCard(failed))).toContain('CAN4 通信失败');
});

it('falls back to readable text or a placeholder without serializing malformed or control-only cards', () => {
  expect(expandInteractiveCard('已有正文', '{broken')).toBe('已有正文');
  expect(expandInteractiveCard('[日志](https://example.com)', '{broken')).toBe('[日志](https://example.com)');
  expect(expandInteractiveCard(JSON.stringify({ schema: '2.0', body: { secret: 'PRIVATE' } }), '{broken')).toBe(INTERACTIVE_CARD_PLACEHOLDER);
  expect(expandInteractiveCard(INTERACTIVE_CARD_PLACEHOLDER, '{broken')).toBe(INTERACTIVE_CARD_PLACEHOLDER);
  expect(project(card([{ tag: 'button', text: { tag: 'plain_text', content: '执行' }, value: { secret: 'PRIVATE' } }]))).toBe(INTERACTIVE_CARD_PLACEHOLDER);
  expect(expandInteractiveCard('ordinary text', undefined)).toBe('ordinary text');
});

it('bounds deeply nested and huge cards without leaking their raw DSL', () => {
  let node: unknown = { tag: 'markdown', content: 'Deep' };
  for (let i = 0; i < 100; i++) node = { tag: 'div', elements: [node] };
  expect(project(card([node]))).not.toContain('"elements"');
  const huge = project(card([{ tag: 'markdown', content: 'x'.repeat(80_000) }]));
  expect(huge.length).toBeLessThan(61_000); expect(huge).toContain('已截断');
});
