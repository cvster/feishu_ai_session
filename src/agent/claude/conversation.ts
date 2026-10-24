import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { findNativeHistory } from '../../tools/session-operations';
import { initialState, reduce } from '../../card/run-state';
import type { NativeConversationReader, NativeConversationSnapshot, NativeConversationTurn } from '../native-conversation';

/** Transcript provenance is explicit: SDK/unknown entries are never broadcast. */
export function projectClaudeConversation(id: string, rows: any[], cwd: string, name?: string): NativeConversationSnapshot {
  const turns: NativeConversationTurn[] = [], seen = new Set<string>();
  for (const row of rows) {
    if (row.sessionId !== id || row.isSidechain || row.isMeta || !row.uuid || seen.has(row.uuid)) continue;
    seen.add(row.uuid);
    const blocks = row.message?.content;
    if (row.type === 'user') {
      const input = typeof blocks === 'string' ? blocks : Array.isArray(blocks) ? blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
      if (!input || row.sourceToolAssistantUUID || !Number.isFinite(Date.parse(row.timestamp))) continue;
      const previous = turns.at(-1);
      if (previous?.state.terminal === 'running') previous.state = reduce(previous.state, { type: 'done', terminationReason: 'interrupted' });
      turns.push({ id: row.uuid, createdAtMs: Date.parse(row.timestamp), input,
        bridge: row.userType !== 'external' || !['cli', 'claude-vscode'].includes(row.entrypoint), state: structuredClone(initialState) });
    }
    const turn = turns.at(-1);
    if (!turn || row.type !== 'assistant' || !Array.isArray(blocks)) continue;
    if (typeof row.message?.model === 'string') turn.state = reduce(turn.state, { type: 'system', model: row.message.model });
    for (const block of blocks) if (block.type === 'text' && typeof block.text === 'string') turn.state = reduce(turn.state, { type: 'text', delta: block.text });
    if (['end_turn', 'stop_sequence'].includes(row.message?.stop_reason)) turn.state = reduce(turn.state, { type: 'done', terminationReason: 'normal' });
    if (row.message?.stop_reason === 'refusal') turn.state = reduce(turn.state, { type: 'error', terminationReason: 'failed', message: 'Claude 未完成本次任务，请查看原工具' });
  }
  return { id, name, cwd, archived: false, turns };
}
export class ClaudeNativeConversationReader implements NativeConversationReader {
  private paths = new Map<string, string>();
  constructor(private readonly configDir: string) {}
  async read(id: string) {
    const path = this.paths.get(id) ?? await findNativeHistory('claude', this.configDir, id);
    if (!path) throw new Error('Claude 会话不可读');
    let content: string;
    try {
      if ((await stat(path)).size > 32 * 1024 * 1024) throw new Error('Claude 历史过大');
      content = await readFile(path, 'utf8'); this.paths.set(id, path);
    } catch (e) { this.paths.delete(id); throw e; }
    const rows = content.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const main = rows.filter(r => r.sessionId === id && !r.isSidechain);
    const cwd = [...main].reverse().find(r => typeof r.cwd === 'string')?.cwd;
    const name = [...main].reverse().find(r => r.type === 'custom-title' && typeof r.customTitle === 'string')?.customTitle;
    if (!cwd || !main.some(r => ['user', 'assistant'].includes(r.type))) throw new Error('Claude 会话元数据不可用');
    const snapshot = projectClaudeConversation(id, rows, cwd, name);
    let settings: any = {};
    for (const path of [join(this.configDir, 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')]) {
      try {
        const value = JSON.parse(await readFile(path, 'utf8'));
        settings = { ...settings, ...value, modelSettings: { ...settings.modelSettings, ...value.modelSettings }, env: { ...settings.env, ...value.env } };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const model = snapshot.turns.at(-1)?.state.execution?.model ?? settings.model;
    const effort = settings.env?.CLAUDE_CODE_EFFORT_LEVEL ?? settings.modelSettings?.[model]?.effortLevel ?? settings.effortLevel;
    return { ...snapshot, settings: { ...(typeof model === 'string' ? { model } : {}),
      ...(typeof effort === 'string' ? { reasoningEffort: effort } : {}) } };
  }
  async close() { this.paths.clear(); }
}
