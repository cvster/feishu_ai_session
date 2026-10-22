import type { RunState, ToolEntry } from './run-state';

/** Only phase and count leave the renderer; never names, arguments or outputs. */
export function runProgress(state: RunState): string[] {
  const labels: string[] = [];
  const thinking = state.terminal === 'running' && state.footer === 'thinking';
  if (thinking || state.reasoning.active || state.reasoning.content.length > 0) {
    labels.push(thinking ? '🧠 思考中' : '🧠 思考完成');
  }
  const tools = new Map<string, ToolEntry>();
  for (const block of state.blocks) if (block.kind === 'tool') tools.set(block.tool.id, block.tool);
  if (tools.size) {
    const running = state.terminal === 'running' && [...tools.values()].some(tool => tool.status === 'running');
    labels.push(`🧰 ${tools.size} 个工具调用（${running ? '进行中' : '已完成'}）`);
  }
  return labels;
}
