import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ToolSession } from './types';

/** Version-contained reader of Claude CLI's local metadata; never uses prompt previews as names. */
export class ClaudeSessionProvider {
  private readonly cache = new Map<string, { stamp: string; session: ToolSession | undefined }>();
  constructor(private readonly configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')) {}
  async listSessions(): Promise<ToolSession[]> {
    const root = join(this.configDir, 'projects');
    const projects = await readdir(root, { withFileTypes: true }).catch(e => {
      if (e.code === 'ENOENT') return []; throw e;
    });
    const result: ToolSession[] = [];
    const seen = new Set<string>();
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = join(root, project.name);
      for (const file of await readdir(dir)) {
        if (!/^[a-f0-9-]{36}\.jsonl$/i.test(file)) continue;
        const path = join(dir, file); seen.add(path);
        const st = await stat(path);
        const stamp = `${st.mtimeMs}:${st.size}`;
        let cached = this.cache.get(path);
        if (!cached || cached.stamp !== stamp) {
          let cwd: string | undefined, name: string | undefined, main = false;
          let createdAtMs = st.birthtimeMs;
          const stream = createReadStream(path, { encoding: 'utf8' });
          const lines = createInterface({ input: stream, crlfDelay: Infinity });
          try {
            for await (const line of lines) {
              let row: Record<string, unknown>;
              try { row = JSON.parse(line); } catch { continue; } // trailing partial append
              if (row.isSidechain === true) continue;
              if ((row.type === 'user' || row.type === 'assistant') && row.sessionId === file.slice(0, -6)) main = true;
              if (typeof row.cwd === 'string') cwd = row.cwd;
              if (row.type === 'custom-title' && typeof row.customTitle === 'string') name = row.customTitle;
              const time = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
              if (Number.isFinite(time)) createdAtMs = Math.min(createdAtMs, time);
            }
          } finally { lines.close(); stream.destroy(); }
          cached = { stamp, session: main && cwd ? { nativeId: file.slice(0, -6), name,
            cwd, createdAtMs, updatedAtMs: st.mtimeMs } : undefined };
          this.cache.set(path, cached);
        }
        if (cached.session) result.push({ ...cached.session });
      }
    }
    for (const path of this.cache.keys()) if (!seen.has(path)) this.cache.delete(path);
    return result.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }
}
