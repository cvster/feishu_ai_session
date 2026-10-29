import { initialState, reduce } from '../../card/run-state';
import type { NativeConversationReader, NativeConversationSnapshot, NativeConversationTurn } from '../native-conversation';
import { PiSessionFiles, piActiveBranch } from './sessions';
import type { PiOptions } from './client';
export const piText = (content: any) => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n') : '';

export class PiNativeConversationReader implements NativeConversationReader {
  private files: PiSessionFiles;
  constructor(options: PiOptions) { this.files = new PiSessionFiles(options); }
  async read(id: string): Promise<NativeConversationSnapshot> {
    const file = await this.files.find(id), turns: NativeConversationTurn[] = [];
    let model: string | undefined, reasoningEffort: string | undefined;
    for (const entry of piActiveBranch(file.entries)) {
      if (entry.type === 'model_change') model = `${entry.provider}/${entry.modelId}`;
      if (entry.type === 'thinking_level_change') reasoningEffort = entry.thinkingLevel;
      if (entry.type !== 'message') continue;
      const message = entry.message;
      if (message?.role === 'user') {
        const old = turns.at(-1);
        if (old?.state.terminal === 'running') old.state = reduce(old.state, { type: 'done', terminationReason: 'interrupted' });
        // Pi persists no reliable terminal-vs-RPC provenance. Unknown inputs
        // remain visible on Web but must never be rebroadcast to Feishu.
        turns.push({ id: entry.id, input: piText(message.content), createdAtMs: Date.parse(entry.timestamp) || message.timestamp || 0,
          bridge: true, state: structuredClone(initialState) });
      }
      const turn = turns.at(-1); if (!turn || message?.role !== 'assistant') continue;
      turn.state = reduce(turn.state, { type: 'text', delta: piText(message.content) });
      if (message.provider && message.model) model = `${message.provider}/${message.model}`;
      if (['error', 'aborted'].includes(message.stopReason)) turn.state = reduce(turn.state,
        message.stopReason === 'error' ? { type: 'error', message: 'Pi 原生任务失败，请在 Pi 查看详情', terminationReason: 'failed' } : { type: 'done', terminationReason: 'interrupted' });
      else if (message.stopReason === 'stop' || message.stopReason === 'length') turn.state = reduce(turn.state, { type: 'done', terminationReason: 'normal' });
    }
    return { id, cwd: file.header.cwd, name: file.name, archived: false, turns, settings: { model, reasoningEffort } };
  }
  async close() {}
}
