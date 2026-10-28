import { expect, it } from 'vitest';
import { renderCard } from '../../../src/card/run-renderer';
import { initialState, markInterrupted, markIdleTimeout, reduce, startRunRuntime, updateRunRuntime } from '../../../src/card/run-state';
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
function body(state: typeof initialState, auxiliary = true, auxiliaryPreviousReply = false): Element[] {
  return (renderCard(state, { auxiliary, auxiliaryPreviousReply }) as { body: { elements: Element[] } }).body.elements;
}
it('keeps short commentary and final output inline while excluding thinking and tool details', () => {
  let state = reduce(initialState, { type: 'thinking', delta: 'private source history path' });
  state = reduce(state, { type: 'text', delta: 'Earlier progress update' });
  state = reduce(state, { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } });
  state = reduce(state, { type: 'text', delta: '**已完成。**' });
  const elements = body(state);
  expect(elements.slice(0, 2)).toMatchObject([{ tag: 'markdown', content: 'Earlier progress update' }, { tag: 'markdown', content: '**已完成。**' }]);
  expect(elements.some(e => e.tag === 'collapsible_panel')).toBe(false);
  expect(JSON.stringify(elements)).not.toContain('pwd');
  expect(JSON.stringify(elements)).not.toContain('private source history path');
  expect(body(state, false)[0]).toMatchObject({ tag: 'markdown', content: 'Earlier progress update' });
});
it('shows a bounded Unicode-safe preview while retaining a long Markdown answer verbatim in details', () => {
  const full = '**结论：**' + '😀'.repeat(1100) + '\n\n详细说明\n```ts\nconst value = 1;\n```';
  const state = reduce(initialState, { type: 'text', delta: full });
  const elements = body(state, true, true);
  expect(body(state).some(e => e.tag === 'collapsible_panel')).toBe(false);
  expect(elements[0]).toMatchObject({ tag: 'div', text: { lines: 5 } });
  const preview = elements[0]!.text!.content;
  expect(Array.from(preview).length).toBeLessThanOrEqual(200);
  expect(preview).not.toMatch(/[\uD800-\uDBFF]$/);
  expect(elements.find(e => e.tag === 'collapsible_panel')).toMatchObject({
    expanded: false, elements: [{ tag: 'markdown', content: full }],
  });
  expect(body(state, false)[0]).toMatchObject({ tag: 'markdown', content: full });
});
it('keeps the latest answer complete and older output of at most 1000 Unicode characters inline regardless of lines or code', () => {
  for (const content of ['```ts\n' + 'const ok = true;\n'.repeat(20) + '```', '一\n二\n三\n四\n五\n六', '😀'.repeat(1000)]) {
    const state = reduce(initialState, { type: 'text', delta: content });
    for (const previous of [true, false]) {
      const elements = body(state, true, previous);
      expect(elements[0]).toMatchObject({ tag: 'markdown', content });
      expect(elements.some(e => e.tag === 'collapsible_panel')).toBe(false);
    }
  }
  const state = reduce(initialState, { type: 'text', delta: '😀'.repeat(1001) });
  expect(body(state).some(e => e.tag === 'collapsible_panel')).toBe(false);
  expect(body(state, true, true).some(e => e.tag === 'collapsible_panel')).toBe(true);
});
it('does not add an empty details panel to a concise answer or a thinking-only update', () => {
  expect(body(reduce(initialState, { type: 'text', delta: '已完成。' })).some(e => e.tag === 'collapsible_panel')).toBe(false);
  expect(body(reduce(initialState, { type: 'thinking', delta: 'internal reasoning' })).some(e => e.tag === 'collapsible_panel')).toBe(false);
});
it.each(['done', 'error', 'interrupted', 'idle_timeout'] as const)('folds status and controls only for long output after %s', terminal => {
  for (const detailed of [false, true]) {
    let running = startRunRuntime(initialState, 1_000);
    running = reduce(running, { type: 'text', delta: detailed ? '详细回答。'.repeat(300) : '简短回答。' });
    running = updateRunRuntime(running, { nowMs: 2_000 });
    const visible = body(running);
    expect(visible.some(e => e.tag === 'column_set')).toBe(true);
    expect(visible.some(e => e.content?.includes('运行中'))).toBe(true);
    const finished = terminal === 'interrupted' ? markInterrupted(running)
      : terminal === 'idle_timeout' ? markIdleTimeout(running, 5)
      : reduce(running, terminal === 'done' ? { type: 'done', terminationReason: 'normal' }
        : { type: 'error', message: 'visible failure', terminationReason: 'failed' });
    const elements = body(finished, true, true);
    expect(body(finished).some(e => e.tag === 'collapsible_panel')).toBe(false);
    const panels = elements.filter(e => e.tag === 'collapsible_panel');
    if (!detailed) {
      expect(panels).toHaveLength(0);
      expect(elements.some(e => e.tag === 'column_set')).toBe(true);
      expect(JSON.stringify(elements)).toContain('最近更新');
      expect(callbacks(elements).map(v => v.cmd)).toEqual(['stop', 'refresh']);
      continue;
    }
    expect(panels).toHaveLength(1);
    expect(panels[0]!.expanded).toBe(false);
    expect(elements.some(e => e.tag === 'column_set')).toBe(false);
    expect(elements.some(e => e.content?.includes('最近更新'))).toBe(false);
    expect(JSON.stringify(panels[0])).toContain('最近更新');
    expect(callbacks(panels[0]).map(v => v.cmd)).toEqual(['stop', 'refresh']);
    expect(body(finished, false).some(e => e.tag === 'column_set')).toBe(true);
  }
});
