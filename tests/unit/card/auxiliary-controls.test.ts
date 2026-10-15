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
