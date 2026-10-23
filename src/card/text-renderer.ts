import type { RunState } from './run-state';
import { renderColoredRunStatus } from './run-status-render';
import { runProgress } from './run-progress';

/**
 * Render `RunState` as plain markdown text — used in `messageReply: 'text'`
 * mode where we stream a markdown message instead of a card.
 *
 * Differences vs `renderCard`:
 *   - No collapsible panels, no buttons (markdown messages have neither)
 *   - Same phase/count summaries, without reasoning or tool details
 *   - Footer is appended inline at the bottom while running
 */
export function renderText(state: RunState): string {
  const parts: string[] = [];

  for (const block of state.blocks) if (block.kind === 'text' && block.content.trim()) parts.push(block.content.trim());
  const progress = runProgress(state);
  parts.push(...progress);

  if (state.terminal === 'interrupted') {
    parts.push('_⏹ 已被中断_');
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    parts.push(`_⏱ ${mins} 分钟无响应,已自动终止_`);
  } else if (state.terminal === 'error' && state.errorMsg) {
    parts.push(`⚠️ agent 失败:${state.errorMsg}`);
  }

  const status = renderColoredRunStatus(state);
  if (status) {
    parts.push(status);
  } else if (state.terminal === 'running' && state.footer && !(state.footer === 'thinking' || state.footer === 'tool_running' && state.blocks.some(block => block.kind === 'tool'))) {
    parts.push(`<font color='blue'>${footerLine(state.footer)}</font>`);
  }

  return parts.join('\n\n');
}

function footerLine(status: 'thinking' | 'tool_running' | 'streaming' | 'waiting_input'): string {
  if (status === 'waiting_input') return '_⏳ 等待选择…_';
  if (status === 'thinking') return '_🧠 正在思考…_';
  if (status === 'tool_running') return '_🧰 正在调用工具…_';
  return '_✍️ 正在输出…_';
}
