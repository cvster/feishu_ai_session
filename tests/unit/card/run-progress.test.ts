import { expect, it } from 'vitest';
import { initialState, reduce } from '../../../src/card/run-state';
import { runProgress } from '../../../src/card/run-progress';
import { renderCard } from '../../../src/card/run-renderer';
import { renderText } from '../../../src/card/text-renderer';

it('shows thinking and parallel tool progress, hides all details, and keeps summaries outside shared answer panels', () => {
  let state = reduce(initialState, { type: 'thinking', delta: 'private reasoning' });
  expect(runProgress(state)).toEqual(['🧠 思考中']);
  state = reduce(state, { type: 'tool_use', id: 'a', name: 'PrivateTool', input: { command: 'secret-command' } });
  state = reduce(state, { type: 'tool_use', id: 'b', name: 'OtherTool', input: {} });
  state = reduce(state, { type: 'tool_result', id: 'a', output: 'private-output', isError: true });
  expect(runProgress(state)).toEqual(['🧠 思考完成', '🧰 2 个工具调用（进行中）']);
  for (const auxiliary of [false, true]) {
    const card = renderCard(state, { auxiliary }) as { body: { elements: { tag: string; content?: string }[] } };
    expect(card.body.elements.filter(e => e.tag === 'markdown').map(e => e.content)).toEqual(expect.arrayContaining(runProgress(state)));
    const json = JSON.stringify(card), text = renderText(state);
    for (const detail of ['private reasoning', 'PrivateTool', 'OtherTool', 'secret-command', 'private-output']) {
      expect(json).not.toContain(detail); expect(text).not.toContain(detail);
    }
    expect(json).not.toContain('collapsible_panel');
  }
  state = reduce(state, { type: 'tool_result', id: 'b', output: 'done', isError: false });
  expect(runProgress(state)).toEqual(['🧠 思考完成', '🧰 2 个工具调用（已完成）']);
  state = reduce(state, { type: 'text', delta: 'answer\n'.repeat(100) });
  state = reduce(state, { type: 'done', terminationReason: 'normal' });
  const finished = renderCard(state, { auxiliary: true }) as { body: { elements: { tag: string; content?: string }[] } };
  expect(finished.body.elements.filter(e => e.tag === 'markdown').map(e => e.content)).toEqual(runProgress(state));
  expect(finished.body.elements.some(e => e.tag === 'collapsible_panel')).toBe(true);
});

it('keeps counts stable on repeated tool ids and closes summaries when the overall turn ends', () => {
  let state = reduce(initialState, { type: 'tool_use', id: 'same', name: 'tool', input: {} });
  state = reduce(state, { type: 'tool_use', id: 'same', name: 'tool', input: {} });
  expect(runProgress(state)).toEqual(['🧰 1 个工具调用（进行中）']);
  for (const terminal of ['done', 'error', 'interrupted', 'idle_timeout'] as const) {
    expect(runProgress({ ...state, terminal })).toEqual(['🧰 1 个工具调用（已完成）']);
  }
  expect(runProgress(reduce(initialState, { type: 'text', delta: 'answer without reasoning' }))).toEqual([]);
});
