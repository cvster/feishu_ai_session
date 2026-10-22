import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolSession, ToolSessionOperations } from './types';
import { KiloClient, kiloSessionId, type KiloOptions } from '../agent/kilo/client';
import { writeFileAtomic } from '../platform/atomic-write';

/** Read native history through the API; never sends a prompt to the source conversation. */
export class KiloSessionProvider implements ToolSessionOperations {
  readonly historyMode = 'snapshot';
  constructor(private options: KiloOptions, private stateDir: string) {}
  async listSessions(): Promise<ToolSession[]> {
    const client = new KiloClient(this.options);
    try {
      const rows = await client.request('GET', '/experimental/session?limit=10000');
      if (!Array.isArray(rows)) throw new Error('Kilo 会话列表格式不兼容');
      return rows.filter(row => !row.parentID && !!row.metadata?.['kilo-desktop'] === (this.options.client === 'app') && typeof row.directory === 'string').map(row => ({
        nativeId: kiloSessionId(row.id), name: row.title, cwd: row.directory,
        createdAtMs: row.time.created, updatedAtMs: row.time.updated, archived: !!row.time.archived,
      }));
    } finally { await client.close(); }
  }
  async historyPath(id: string): Promise<string | undefined> {
    try { kiloSessionId(id); } catch { return undefined; }
    const client = new KiloClient(this.options, undefined, id);
    try {
      const session = await client.request('GET', `/session/${id}`);
      if (session.id !== id) throw new Error('Kilo 返回了不匹配的会话记录');
      const messages = await client.request('GET', `/session/${id}/message`, undefined, session.directory);
      if (!Array.isArray(messages)) throw new Error('Kilo 消息格式不兼容');
      const dir = join(this.stateDir, 'history'); await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${createHash('sha256').update(id).digest('hex')}.json`);
      await writeFileAtomic(path, JSON.stringify({ session, messages }), { mode: 0o600 }); return path;
    } finally { await client.close(); }
  }
  private async update(id: string, body: unknown) {
    const client = new KiloClient(this.options, undefined, id);
    try {
      const session = await client.request('GET', `/session/${kiloSessionId(id)}`);
      if (session.id !== id || typeof session.directory !== 'string') throw new Error('Kilo 返回了不匹配的会话');
      const result = await client.request('PATCH', `/session/${id}`, body, session.directory);
      if (result.id !== id) throw new Error('Kilo 返回了不匹配的会话');
    }
    finally { await client.close(); }
  }
  rename(id: string, title: string) { return this.update(id, { title }); }
  archive(id: string) { return this.update(id, { time: { archived: Date.now() } }); }
  async fork(id: string): Promise<{ nativeId: string; name: string; cwd: string }> {
    const client = new KiloClient(this.options, undefined, id);
    try {
      const source = await client.request('GET', `/session/${kiloSessionId(id)}`);
      if (source.id !== id || source.time.archived) throw new Error('Kilo 原会话不存在或已归档');
      const statuses = await client.request('GET', '/session/status', undefined, source.directory);
      if (statuses[id] && statuses[id].type !== 'idle') throw new Error('请先停止当前 Kilo 任务，再复制会话');
      const result = await client.request('POST', `/session/${id}/fork`, {}, source.directory);
      const nativeId = kiloSessionId(result.id);
      if (nativeId === id || result.directory !== source.directory) throw new Error('Kilo 返回了不匹配的复制会话');
      if (source.metadata?.['kilo-desktop'] && !result.metadata?.['kilo-desktop']) {
        await client.request('PATCH', `/session/${nativeId}`, { metadata: { ...result.metadata, 'kilo-desktop': source.metadata['kilo-desktop'] } }, source.directory);
      }
      return { nativeId, name: result.title, cwd: result.directory };
    } finally { await client.close(); }
  }
}
