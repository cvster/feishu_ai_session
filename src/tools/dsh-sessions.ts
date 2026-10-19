import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DshClient, dshSessionId, type DshOptions } from '../agent/dsh/client';
import { writeFileAtomic } from '../platform/atomic-write';
import type { ToolSession, ToolSessionOperations } from './types';

export class DshSessionProvider implements ToolSessionOperations {
  readonly historyMode = 'snapshot';
  constructor(private readonly options: DshOptions, private readonly stateDir: string) {}
  async listSessions(): Promise<ToolSession[]> {
    const client = new DshClient(this.options);
    try {
      const { rows, archived } = await client.roster();
      return rows.filter(row => !row.parentSessionId && row.origin !== 'subagent' && typeof row.cwd === 'string').map(row => ({
        nativeId: dshSessionId(row.sessionId), name: row.projections?.values?.title ?? undefined, cwd: row.cwd,
        createdAtMs: row.updatedAt, updatedAtMs: row.updatedAt, archived: archived.has(row.sessionId),
      }));
    } finally { await client.close(); }
  }
  async historyPath(id: string): Promise<string | undefined> {
    dshSessionId(id);
    const client = new DshClient(this.options);
    try {
      const snapshot = await client.session(id, 200);
      let records = snapshot.records, hasMore = snapshot.hasMore;
      while (hasMore) {
        const beforeSeq = Math.min(...records.filter((r: any) => r.type === 'event').map((r: any) => r.event.seq));
        if (!Number.isFinite(beforeSeq) || JSON.stringify(records).length > 32 * 1024 * 1024) throw new Error('DSH 历史过大或分页无效');
        const page = await client.request('session/page', { request: { address: { kind: 'session', sessionId: id }, throughSeq: snapshot.cursor, beforeSeq, maxMessages: 200 } });
        if (!page.records?.length) throw new Error('DSH 历史分页未推进');
        const previousSeq = Math.min(...page.records.filter((r: any) => r.type === 'event').map((r: any) => r.event.seq));
        if (!(previousSeq < beforeSeq)) throw new Error('DSH 历史分页游标未推进');
        records = [...page.records, ...records]; hasMore = page.hasMore;
      }
      const dir = join(this.stateDir, 'history'); await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${createHash('sha256').update(id).digest('hex')}.json`);
      const data = JSON.stringify({ header: snapshot.header, cursor: snapshot.cursor, records });
      if (Buffer.byteLength(data, 'utf8') > 32 * 1024 * 1024) throw new Error('DSH 历史快照过大');
      await writeFileAtomic(path, data, { mode: 0o600 });
      return path;
    } finally { await client.close(); }
  }
  async rename(id: string, title: string): Promise<void> {
    const client = new DshClient(this.options);
    try { await client.request('session/rename', { request: { sessionId: dshSessionId(id), title } }); }
    finally { await client.close(); }
  }
  async archive(id: string): Promise<void> {
    const client = new DshClient(this.options);
    try { await client.request('workspace/archiveSession', { request: { sessionId: dshSessionId(id) } }); }
    finally { await client.close(); }
  }
  async fork(id: string) {
    const client = new DshClient(this.options);
    try {
      const { rows, archived } = await client.roster(), source = rows.find(row => row.sessionId === id);
      if (!source || source.running || archived.has(id)) throw new Error('DSH 会话不存在、已归档或仍在运行');
      const result = await client.request('session/fork', { request: { sessionId: dshSessionId(id) } });
      const nativeId = dshSessionId(result.sessionId);
      if (nativeId === id) throw new Error('DSH 返回了相同的复制会话 ID');
      const copy = await client.session(nativeId);
      if (copy.header.cwd !== source.cwd) throw new Error('DSH 复制会话的工作目录不匹配');
      return { nativeId, cwd: copy.header.cwd, name: copy.projections?.values?.title || source.projections?.values?.title || nativeId };
    } finally { await client.close(); }
  }
}
