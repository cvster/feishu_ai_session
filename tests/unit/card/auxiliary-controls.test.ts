import { expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer';
import { initialState, markInterrupted, reduce } from '../../../src/card/run-state';
function callbacks(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  const row = value as Record<string, unknown>;
  return [...(row.type === 'callback' && row.value ? [row.value as Record<string, unknown>] : []), ...Object.values(row).flatMap(callbacks)];
}
it('keeps exactly stop and refresh in every auxiliary state, including after completion', () => {
  for (const state of [initialState, reduce(initialState, { type: 'done', terminationReason: 'normal' }),
    reduce(initialState, { type: 'error', message: 'failed', terminationReason: 'failed' }), markInterrupted(initialState)]) {
    const values = callbacks(renderCard(state, { auxiliary: true, auxiliaryRunId: 'run-a', showStopButton: false }));
    expect(values.map(v => v.cmd)).toEqual(['stop', 'refresh']);
    expect(values[0]).toMatchObject({ auxiliaryRunId: 'run-a' });
  }
});
it('preserves the normal personal group management controls', () => {
  expect(callbacks(renderCard(initialState)).map(v => v.cmd)).toEqual(['stop', 'config', 'refresh', 'fork', 'finish']);
});

interface Element {
  tag: string;
  content?: string;
  text?: { content: string; lines?: number };
  expanded?: boolean;
  elements?: Element[];
}
function body(state: typeof initialState, auxiliary = true): Element[] {
  return (renderCard(state, { auxiliary }) as { body: { elements: Element[] } }).body.elements;
}
it('keeps a short final answer visible and folds earlier commentary and running tool output', () => {
  let state = reduce(initialState, { type: 'thinking', delta: 'private source history path' });
  state = reduce(state, { type: 'text', delta: 'Earlier progress update' });
  state = reduce(state, { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } });
  state = reduce(state, { type: 'text', delta: '**已完成。**' });
  const elements = body(state);
  expect(elements[0]).toMatchObject({ tag: 'markdown', content: '**已完成。**' });
  const panel = elements.find(e => e.tag === 'collapsible_panel')!;
  expect(panel.expanded).toBe(false);
  expect(JSON.stringify(panel)).toContain('Earlier progress update');
  expect(panel.elements?.find(e => e.tag === 'collapsible_panel')?.expanded).toBe(false);
  expect(JSON.stringify(elements)).not.toContain('private source history path');
  expect(body(state, false)[0]).toMatchObject({ tag: 'collapsible_panel', expanded: false });
});
it('shows a bounded Unicode-safe preview while retaining a long Markdown answer verbatim in details', () => {
  const full = '**结论：**' + '😀'.repeat(240) + '\n\n详细说明\n```ts\nconst value = 1;\n```';
  const state = reduce(initialState, { type: 'text', delta: full });
  const elements = body(state);
  expect(elements[0]).toMatchObject({ tag: 'div', text: { lines: 5 } });
  const preview = elements[0]!.text!.content;
  expect(Array.from(preview).length).toBeLessThanOrEqual(200);
  expect(preview).not.toMatch(/[\uD800-\uDBFF]$/);
  expect(elements.find(e => e.tag === 'collapsible_panel')).toMatchObject({
    expanded: false, elements: [{ tag: 'markdown', content: full }],
  });
  expect(body(state, false)[0]).toMatchObject({ tag: 'markdown', content: full });
});
it('folds code and multiline answers without truncating their full content', () => {
  for (const content of ['```ts\nconst ok = true;\n```', '一\n二\n三\n四\n五\n六']) {
    const elements = body(reduce(initialState, { type: 'text', delta: content }));
    expect(elements[0]!.text?.content.split('\n').length).toBeLessThanOrEqual(5);
    expect(elements.find(e => e.tag === 'collapsible_panel')).toMatchObject({ expanded: false,
      elements: [{ tag: 'markdown', content }] });
  }
});
it('does not add an empty details panel to a concise answer or a thinking-only update', () => {
  expect(body(reduce(initialState, { type: 'text', delta: '已完成。' })).some(e => e.tag === 'collapsible_panel')).toBe(false);
  expect(body(reduce(initialState, { type: 'thinking', delta: 'internal reasoning' })).some(e => e.tag === 'collapsible_panel')).toBe(false);
});
