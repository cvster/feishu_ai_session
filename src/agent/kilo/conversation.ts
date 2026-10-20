import type { RunState } from '../../card/run-state';
import { initialState, projectNameFromCwd, reduce, startRunRuntime } from '../../card/run-state';
import { KiloClient, kiloSessionId, type KiloOptions } from './client';

// Supported native text-part metadata stays outside the model prompt. Do not
// guess provenance from ID shape or insert a marker into the user's text.
export const kiloBridgeTextPart = (text: string) => ({ type: 'text' as const, text, metadata: { 'lark-channel-bridge': { version: 1, origin: 'feishu' } } });
export const isKiloBridgeInput = (user: { parts?: any[] }) => (user.parts ?? []).some(part => {
  const origin = part.metadata?.['lark-channel-bridge'];
  return part.type === 'text' && origin?.version === 1 && origin.origin === 'feishu';
});

export interface KiloConversationTurn {
  id: string;
  createdAtMs: number;
  bridge: boolean;
  input: string;
  state: RunState;
}
export interface KiloConversationSnapshot {
  id: string;
  name?: string;
  cwd: string;
  archived: boolean;
  turns: KiloConversationTurn[];
}
export interface KiloConversationReader {
  read(id: string): Promise<KiloConversationSnapshot>;
  stopTurn(id: string, turnId: string): Promise<boolean>;
  close(): Promise<void>;
}

export function projectKiloConversation(info: any, rows: any[], busy: boolean): KiloConversationSnapshot {
  const users = rows.filter(row => row.info?.role === 'user');
  const byId = new Map<string, any>(rows.filter(row => row.info?.id).map(row => [row.info.id, row]));
  const root = (row: any): string | undefined => {
    const visited = new Set<string>();
    while (row?.info?.role === 'assistant') {
      if (visited.has(row.info.id)) return;
      visited.add(row.info.id); row = byId.get(row.info.parentID);
    }
    return row?.info?.role === 'user' ? row.info.id : undefined;
  };
  const answers = new Map<string, any[]>();
  for (const row of rows) if (row.info?.role === 'assistant') {
    const parent = root(row); if (parent) answers.set(parent, [...(answers.get(parent) ?? []), row]);
  }
  const turns = users.map((user, index): KiloConversationTurn => {
    const id = user.info.id, assistant = answers.get(id) ?? [], last = assistant.at(-1)?.info;
    const running = index === users.length - 1 && (busy || !last?.time?.completed);
    let state = startRunRuntime(initialState, user.info.time.created);
    state = { ...state, projectName: projectNameFromCwd(info.directory) };
    for (const row of assistant) {
      const model = row.info;
      state = reduce(state, { type: 'system', model: `${model.providerID}/${model.modelID}`, ...(model.variant ? { reasoningEffort: model.variant } : {}) });
      for (const part of row.parts ?? []) {
        if (part.type === 'text' && typeof part.text === 'string') state = reduce(state, { type: 'text', delta: part.text });
        if (part.type === 'reasoning' && typeof part.text === 'string') state = reduce(state, { type: 'thinking', delta: part.text });
        if (part.type === 'tool' && part.state) {
          state = reduce(state, { type: 'tool_use', id: part.callID, name: part.tool, input: part.state.input ?? {} });
          if (['completed', 'error'].includes(part.state.status)) state = reduce(state, {
            type: 'tool_result', id: part.callID, output: part.state.output ?? part.state.error ?? '', isError: part.state.status === 'error',
          });
        }
      }
    }
    if (last?.error) state = reduce(state, { type: 'error', message: 'Kilo 原生会话执行失败，请在原工具查看详情。',
      terminationReason: last.error.name === 'MessageAbortedError' ? 'interrupted' : 'failed' });
    else if (!running) state = reduce(state, { type: 'done', terminationReason: last?.time?.completed ? 'normal' : 'interrupted' });
    state = { ...state, runtime: { ...state.runtime!, processRunning: state.terminal === 'running' } };
    return { id, createdAtMs: user.info.time.created, bridge: isKiloBridgeInput(user),
      input: (user.parts ?? []).filter((p: any) => p.type === 'text' && !p.synthetic && typeof p.text === 'string').map((p: any) => p.text).join('\n'), state };
  });
  return { id: info.id, name: typeof info.title === 'string' ? info.title : undefined, cwd: info.directory, archived: !!info.time?.archived, turns };
}

/** Read bound native sessions only. Cached clients detach without stopping UI processes. */
export class KiloNativeConversationReader implements KiloConversationReader {
  private clients = new Map<string, KiloClient>();
  constructor(private options: KiloOptions = {}) {}
  private client(id: string): KiloClient {
    kiloSessionId(id);
    let client = this.clients.get(id);
    if (!client) { client = new KiloClient(this.options, undefined, id); this.clients.set(id, client); }
    return client;
  }
  async read(id: string): Promise<KiloConversationSnapshot> {
    const client = this.client(id);
    try {
      const info = await client.request('GET', `/session/${id}`);
      if (info.id !== id || typeof info.directory !== 'string') throw new Error('Kilo 原生会话身份不匹配');
      const rows = await client.request('GET', `/session/${id}/message`, undefined, info.directory);
      const statuses = await client.request('GET', '/session/status', undefined, info.directory);
      if (!Array.isArray(rows)) throw new Error('Kilo 原生消息格式不兼容');
      return projectKiloConversation(info, rows, !!statuses[id] && statuses[id].type !== 'idle');
    } catch (error) {
      this.clients.delete(id); await client.close(); throw error;
    }
  }
  async stopTurn(id: string, turnId: string): Promise<boolean> {
    const snapshot = await this.read(id), current = snapshot.turns.at(-1);
    if (snapshot.archived || current?.id !== turnId || current.bridge || current.state.terminal !== 'running') return false;
    await this.client(id).request('POST', `/session/${id}/abort?scope=session`, undefined, snapshot.cwd);
    return true;
  }
  async close() { await Promise.all([...this.clients.values()].map(client => client.close())); this.clients.clear(); }
}
