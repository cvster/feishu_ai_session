import type { NativeConversationReader, NativeConversationSnapshot, NativeConversationTurn } from '../native-conversation';
import { initialState, reduce } from '../../card/run-state';
import { DshClient, type DshOptions } from './client';
const text = (c: any) => Array.isArray(c) ? c.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
/** source.kind and source.rpcId are durable native metadata, never prompt markers. */
export function projectDshConversation(snapshot: any, row: any, archived: boolean): NativeConversationSnapshot {
  if (snapshot.header?.id !== row.sessionId || snapshot.header.cwd !== row.cwd || !Array.isArray(snapshot.records)) throw new Error('Dsh 会话身份不匹配');
  const turns: NativeConversationTurn[] = [], seen = new Set<number>();
  for (const record of snapshot.records) {
    const e = record.event;
    if (record.type !== 'event' || !Number.isSafeInteger(e?.seq) || seen.has(e.seq)) continue;
    seen.add(e.seq); const d = e.data;
    if (e.type === 'user/message') {
      if (!d.id || !text(d.content)) continue;
      const prior = turns.at(-1);
      if (prior?.state.terminal === 'running') prior.state = reduce(prior.state, { type: 'done', terminationReason: 'interrupted' });
      turns.push({ id: d.id, createdAtMs: e.time, input: text(d.content),
        bridge: d.source?.kind !== 'user' || typeof d.source?.rpcId === 'string' && d.source.rpcId.startsWith('bridge-'), state: structuredClone(initialState) });
    }
    const turn = turns.at(-1); if (!turn) continue;
    if (e.type === 'assistant/message') turn.state = reduce(turn.state, { type: 'text', delta: text(d.message?.content) });
    if (e.type === 'turn/end') {
      const failed = ['error', 'blocked'].includes(d.reason?.kind);
      if (failed) turn.state = reduce(turn.state, { type: 'error', terminationReason: 'failed', message: 'Dsh 原生任务失败，请查看原工具' });
      else turn.state = reduce(turn.state, { type: 'done', terminationReason: d.reason?.kind === 'cancelled' ? 'interrupted' : 'normal' });
    }
  }
  const latest = turns.at(-1);
  if (latest?.state.terminal === 'done' && row.running !== false) latest.state = { ...latest.state, terminal: 'running', footer: 'streaming' };
  return { id: row.sessionId, cwd: row.cwd, name: row.projections?.values?.title, archived, turns };
}
export class DshNativeConversationReader implements NativeConversationReader {
  private client?: DshClient;
  constructor(private readonly options: DshOptions) {}
  async read(id: string) {
    const client = this.client ??= new DshClient(this.options);
    try {
      const { rows, archived } = await client.roster(), row = rows.find(r => r.sessionId === id);
      if (!row || row.parentSessionId || row.origin === 'subagent') throw new Error('Dsh 会话不可用');
      const snapshot = await client.session(id, 200);
      while (snapshot.hasMore) {
        const seq = Math.min(...snapshot.records.filter((r: any) => r.type === 'event').map((r: any) => r.event.seq));
        if (!Number.isFinite(seq) || Buffer.byteLength(JSON.stringify(snapshot)) > 32 * 1024 * 1024) throw new Error('Dsh 分页过大或无效');
        const page = await client.request('session/page', { request: { address: { kind: 'session', sessionId: id }, throughSeq: snapshot.cursor, beforeSeq: seq, maxMessages: 200 } });
        if (!Array.isArray(page.records) || !page.records.some((r: any) => r.event?.seq < seq)) throw new Error('Dsh 分页未推进');
        snapshot.records = [...page.records, ...snapshot.records]; snapshot.hasMore = page.hasMore;
      }
      const current = (await client.roster()).rows.find(r => r.sessionId === id);
      if (!current) throw new Error('Dsh 会话已变化');
      return projectDshConversation(snapshot, current, archived.has(id));
    } catch (e) { this.client = undefined; await client.close(); throw e; }
  }
  async close() { const client = this.client; this.client = undefined; await client?.close(); }
}
