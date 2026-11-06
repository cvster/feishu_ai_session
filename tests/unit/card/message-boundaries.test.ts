import { expect, it } from 'vitest';
import { restoreMessageBoundaries } from '../../../src/card/message-boundaries';
import { initialState, reduce, type RunState } from '../../../src/card/run-state';
import { renderCard } from '../../../src/card/run-renderer';
import { renderText } from '../../../src/card/text-renderer';

const progress = '小包已安装，219 个文件及链接核对通过，服务已恢复 ready。继续观察节点稳定性。';
const final = '#2755 控制小包已部署到 156，旧模块已备份。\n系统 ready，底盘三电机初始化、全身伺服启用均成功。';
const boldFinal = '**#2755 控制小包已部署到 156，旧模块已备份。**\n**系统 ready，底盘三电机初始化、全身伺服启用均成功。**';
const native = (texts: string[]): RunState => ({ ...initialState,
  blocks: texts.map(content => ({ kind: 'text', content, streaming: false })), terminal: 'done', footer: null });

it('restores commentary/final paragraph breaks without changing the answer, tool summaries or terminal state', () => {
  let state = reduce(initialState, { type: 'text', delta: progress });
  state = reduce(state, { type: 'tool_use', id: 'tool', name: 'private', input: 'private details' });
  state = reduce(state, { type: 'text', delta: final });
  state = reduce(state, { type: 'done', terminationReason: 'normal' });
  const repaired = restoreMessageBoundaries(state, native([progress, final]));
  expect(repaired.terminal).toBe('done');
  expect(repaired.blocks.filter(b => b.kind === 'tool')).toEqual(state.blocks.filter(b => b.kind === 'tool'));
  expect(renderText(repaired)).toContain(progress + '\n\n' + boldFinal);
  for (const auxiliary of [false, true]) {
    const json = JSON.stringify(renderCard(repaired, { auxiliary }));
    expect(json).toContain(JSON.stringify(progress + '\n\n' + boldFinal).slice(1, -1));
    expect(json).not.toContain('private');
  }
});

it('bolds a final-only reply but never bolds running progress or an interrupted tail', () => {
  const done = native([final]);
  expect(restoreMessageBoundaries(done, done).blocks[0]).toMatchObject({content:boldFinal});
  for (const terminal of ['running', 'interrupted', 'error'] as const) {
    const state = {...done,terminal};
    expect(restoreMessageBoundaries(state, state)).toBe(state);
  }
});

it.each([['a', 'b', 'a\n\nb'], ['a\n', 'b', 'a\n\nb'], ['a', '\nb', 'a\n\nb'],
  ['a\n\n', '\nb', 'a\n\n\nb']])('preserves existing newlines between native messages (%j, %j)', (a, b, expected) => {
  const state = reduce(initialState, { type: 'text', delta: a + b });
  expect(restoreMessageBoundaries(state, native([a, b])).blocks[0]).toMatchObject({content:expected});
});

it('never guesses boundaries from words or replaces text with an incomplete or unrelated native answer', () => {
  const state = reduce(initialState, { type: 'text', delta: progress + final });
  for (const candidate of [native([progress]), native([progress, final + 'different']), native([progress, ''])])
    expect(restoreMessageBoundaries(state, candidate)).toBe(state);
  const repaired = restoreMessageBoundaries(state, native([progress, final]));
  expect(restoreMessageBoundaries(repaired, native([progress, final]))).toBe(repaired);
});
