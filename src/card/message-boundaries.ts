import type { Block, RunState } from './run-state';

/** Older Codex workers flatten assistant messages. Restore only boundaries
 * proven by a native turn whose complete text matches the journal exactly.
 */
export function restoreMessageBoundaries(state: RunState, native: RunState): RunState {
  const messages = native.blocks.filter((block): block is Extract<Block, { kind: 'text' }> => block.kind === 'text' && block.content.length > 0);
  if (messages.length < 2) return state;
  const text = state.blocks.filter(block => block.kind === 'text').map(block => block.content).join('');
  if (messages.map(block => block.content).join('') !== text) return state;
  const joined = messages.reduce((result, block) => {
    if (!result) return block.content;
    const trailing = result.match(/\n*$/)![0].length;
    const leading = block.content.match(/^\n*/)![0].length;
    return result + '\n'.repeat(Math.max(0, 2 - trailing - leading)) + block.content;
  }, '');
  if (joined === text) return state;
  // Tool details are never rendered; retain their entries and status counts.
  let first = true;
  return { ...state, blocks: state.blocks.flatMap((block): Block[] => {
    if (block.kind !== 'text') return [block];
    if (!first) return [];
    first = false;
    return [{ ...block, content: joined }];
  }) };
}
