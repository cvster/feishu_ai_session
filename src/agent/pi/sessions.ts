import { constants } from 'node:fs';
import { readdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { piSessionId, piStorageDir, type PiOptions } from './client';

export interface PiSessionFile { path: string; header: any; entries: any[]; name?: string; createdAtMs: number; updatedAtMs: number }
export class PiSessionFiles {
  constructor(private options: PiOptions) {}
  private async files() {
    const root = join(piStorageDir(this.options), 'sessions');
    const dirs = await readdir(root, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    const paths: string[] = [];
    for (const dir of dirs) {
      if (dir.isFile() && dir.name.endsWith('.jsonl')) paths.push(join(root, dir.name));
      if (!dir.isDirectory()) continue;
      for (const file of await readdir(join(root, dir.name), { withFileTypes: true }))
        if (file.isFile() && file.name.endsWith('.jsonl')) paths.push(join(root, dir.name, file.name));
    }
    return paths;
  }
  private async load(path: string): Promise<PiSessionFile | undefined> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw Error('Pi 会话历史过大');
      const bytes = Buffer.alloc(stat.size); let length = 0;
      while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
      const content = bytes.subarray(0, length).toString('utf8');
      const lines = content.slice(0, content.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
      if (!lines.length) return;
      const [header, ...entries] = lines.map(line => JSON.parse(line));
      if (header.type !== 'session' || header.version !== 3 || typeof header.id !== 'string' || typeof header.cwd !== 'string') return;
      piSessionId(header.id);
      return { path, header, entries, name: [...entries].reverse().find(e => e.type === 'session_info')?.name,
        createdAtMs: Date.parse(header.timestamp) || stat.birthtimeMs, updatedAtMs: stat.mtimeMs };
    } finally { await file.close(); }
  }
  async list(): Promise<PiSessionFile[]> {
    const result: PiSessionFile[] = [];
    for (const path of await this.files()) { const row = await this.load(path); if (row) result.push(row); }
    const seen = new Set<string>();
    for (const row of result) { if (seen.has(row.header.id)) throw Error('Pi 存在重复会话 ID，无法确定原生会话'); seen.add(row.header.id); }
    return result.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }
  async find(id: string): Promise<PiSessionFile> {
    piSessionId(id);
    const matches = (await this.list()).filter(row => row.header.id === id);
    if (matches.length !== 1) throw Error('Pi 会话不存在或身份不明确');
    return matches[0]!;
  }
}

/** Only the active parent chain is visible; abandoned branches are not replayed. */
export function piActiveBranch(entries: any[]): any[] {
  const byId = new Map(entries.filter(row => typeof row.id === 'string').map(row => [row.id, row]));
  const result: any[] = [], seen = new Set<string>();
  let entry = entries.at(-1);
  while (entry) {
    if (typeof entry.id !== 'string' || seen.has(entry.id)) throw Error('Pi 会话分支无效');
    seen.add(entry.id); result.push(entry);
    if (entry.parentId === null) break;
    entry = byId.get(entry.parentId);
    if (!entry) throw Error('Pi 会话分支缺少父记录');
  }
  return result.reverse();
}
