import type { NativeConversationReader, NativeConversationSnapshot, NativeConversationTurn } from '../native-conversation';
import { initialState, reduce, startRunRuntime } from '../../card/run-state';
import { ZcodeClient, type ZcodeOptions } from './client';

const validId = (id: unknown): id is string => typeof id === 'string' && /^(?:sess|session)_[A-Za-z0-9_-]+$/.test(id);
const visible = (info: any): boolean => !info?.synthetic && !info?.source &&
  (!info?.semantics || info.semantics.uiVisibility === 'visible') &&
  !['hidden', 'model-only', 'debug'].includes(info?.visibility);
const visiblePart = (part: any): boolean => !part.synthetic && !part.ignored &&
  !['hidden', 'model-only', 'debug'].includes(part.visibility ?? part.metadata?.visibility);

/** Native structured admission metadata, never text matching or prompt JSON.
 * Desktop and official remote inputs carry desktop/mobile origins. Missing/old
 * provenance is deliberately not broadcast; exclude our input command ID.
 */
export function isZcodeNativeInput(info: any): boolean {
  const intents = [info?.metadata?.inputIntent, info?.metadata?.conversationInputIntent].filter(Boolean);
  return visible(info) && intents.length > 0 && intents.every(intent =>
    ['desktop', 'mobile'].includes(intent.inputOrigin) && intent.inputOrigin === intents[0].inputOrigin &&
    intent.sourceCommandId === intents[0].sourceCommandId && typeof intent.sourceCommandId === 'string' &&
    !!intent.sourceCommandId && !intent.sourceCommandId.startsWith('bridge-'));
}

export function projectZcodeConversation(snapshot: any): NativeConversationSnapshot {
  const session = snapshot?.session, rows: any[] = snapshot?.messages;
  if (!validId(session?.sessionId) || typeof session?.workspace?.workspacePath !== 'string' || !Array.isArray(rows) ||
    !['interactive', 'fork'].includes(session.sessionKind)) throw new Error('ZCode 原生会话记录格式不兼容');
  if (rows.some(row => !row?.info?.messageId || row.info.sessionId !== session.sessionId || !Array.isArray(row.parts)))
    throw new Error('ZCode 原生消息身份不匹配');
  const byId = new Map(rows.map(row => [row.info.messageId, row]));
  const users = rows.filter(row => row.info.role === 'user' && visible(row.info) &&
    (!row.info.semantics || ['user_prompt', 'slash_command'].includes(row.info.semantics.kind)));
  const userIds = new Set(users.map(row => row.info.messageId));
  const answers = new Map<string, any[]>();
  for (const row of rows) {
    if (row.info.role !== 'assistant' || !visible(row.info)) continue;
    let parent = row.info.parentMessageId;
    const visited = new Set<string>();
    while (byId.get(parent)?.info.role === 'assistant' && !visited.has(parent)) {
      visited.add(parent); parent = byId.get(parent)!.info.parentMessageId;
    }
    if (userIds.has(parent)) answers.set(parent, [...(answers.get(parent) ?? []), row]);
  }
  const turns = users.map((user, index): NativeConversationTurn => {
    const id = user.info.messageId, createdAtMs = user.info.time?.created;
    const assistant = answers.get(id) ?? [], last = assistant.at(-1)?.info;
    let state = startRunRuntime(initialState, createdAtMs);
    state = reduce(state, { type: 'system', cwd: session.workspace.workspacePath });
    for (const row of assistant) {
      const model = row.info.model;
      if (model?.providerId && model?.modelId) state = reduce(state, { type: 'system', model: `${model.providerId}/${model.modelId}`,
        ...(model.options?.reasoningLevel ? { reasoningEffort: model.options.reasoningLevel } : {}) });
      for (const part of row.parts.filter(visiblePart)) {
        if (part.type === 'text' && typeof part.text === 'string') state = reduce(state, { type: 'text', delta: part.text });
        if (part.type === 'reasoning' && typeof part.text === 'string') state = reduce(state, { type: 'thinking', delta: part.text });
        if (part.type === 'tool' && part.callId && part.state) {
          state = reduce(state, { type: 'tool_use', id: part.callId, name: part.tool, input: part.state.input ?? {} });
          if (['completed', 'error'].includes(part.state.status)) state = reduce(state, { type: 'tool_result', id: part.callId,
            output: part.state.output ?? part.state.error ?? '', isError: part.state.status === 'error' });
        }
      }
    }
    // A detached CLI's runtime is idle even while the desktop is running. Use
    // durable message completion, never that CLI's local runtime status.
    if (last?.error) state = reduce(state, { type: 'error', message: 'ZCode 原生会话执行失败，请在桌面查看详情。',
      terminationReason: ['MessageAbortedError', 'AbortError'].includes(last.error.name) ? 'interrupted' : 'failed' });
    else if (last?.finish && !['tool-calls', 'unknown'].includes(last.finish)) state = reduce(state, { type: 'done',
      terminationReason: ['cancelled', 'aborted'].includes(last.finish) ? 'interrupted' : 'normal' });
    else if (index < users.length - 1) state = reduce(state, { type: 'done', terminationReason: 'interrupted' });
    const command = user.info.metadata?.inputIntent?.sourceCommandId ?? user.info.metadata?.conversationInputIntent?.sourceCommandId;
    const bridgeJobId = typeof command === 'string' && command.startsWith('bridge-') ? command.slice(7) : undefined;
    return { id, createdAtMs, bridge: !isZcodeNativeInput(user.info), ...(bridgeJobId ? { bridgeJobId } : {}),
      input: user.parts.filter((part: any) => part.type === 'text' && typeof part.text === 'string' && visiblePart(part)).map((part: any) => part.text).join('\n'), state };
  });
  return { id: session.sessionId, name: session.title, cwd: session.workspace.workspacePath, archived: !!session.archivedAt, turns };
}

/** Owns an independent local CLI reader, not the desktop's remote terminal.
 * Resume only materializes this reader; no send, model/registry update, stop or
 * remote operation is issued by polling. Explicit stop delegates to the paired
 * worker; subsequent read snapshots refresh persisted rows.
 */
export class ZcodeNativeConversationReader implements NativeConversationReader {
  private client?: ZcodeClient;
  private loaded = new Set<string>();
  readonly stopTurn?: (id: string, turnId: string) => Promise<boolean>;
  constructor(private options: ZcodeOptions = {}, stopNativeTurn?: (id: string, turnId: string, cwd: string) => Promise<boolean>) {
    if (stopNativeTurn) this.stopTurn = async (id, turnId) => {
      const snapshot = await this.read(id), turn = snapshot.turns.at(-1);
      if (snapshot.archived || turn?.id !== turnId || turn.bridge || turn.state.terminal !== 'running') return false;
      return stopNativeTurn(id, turnId, snapshot.cwd);
    };
  }
  async read(id: string): Promise<NativeConversationSnapshot> {
    if (!validId(id)) throw new Error('ZCode 原生会话 ID 无效');
    const client = this.client ??= new ZcodeClient(this.options);
    try {
      const snapshot = await client.request(this.loaded.has(id) ? 'session/read' : 'session/resume', { sessionId: id });
      if (snapshot?.session?.sessionId !== id) throw new Error('ZCode 原生会话身份不匹配');
      const result = projectZcodeConversation(snapshot);
      this.loaded.add(id);
      return result;
    } catch {
      await this.close();
      // Native errors can include model/provider context. Do not log their payload.
      throw new Error('ZCode 原生消息读取失败；未发送输入或连接远控，请检查本机会话数据源及 CLI 版本。');
    }
  }
  async close(): Promise<void> {
    const client = this.client; this.client = undefined; this.loaded.clear(); await client?.close();
  }
}
