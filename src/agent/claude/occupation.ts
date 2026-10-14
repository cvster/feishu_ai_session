import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export interface ClaudeProcess {
  argv: string[];
  cwd: string;
}

// An interactive process can switch sessions after launch. Its initial --resume
// argument is therefore insufficient: conservatively reserve its whole cwd.
export function occupiesClaudeWorkspace(process: ClaudeProcess, cwd: string, binary: string): boolean {
  const commands = new Set(['claude', 'claude.exe', 'claude.cmd', basename(binary)]);
  const isClaude = process.argv.slice(0, 2).some(arg => commands.has(basename(arg))) ||
    process.argv.some(arg => /[/\\]@anthropic-ai[/\\]claude-code[/\\]/.test(arg));
  return isClaude && resolve(process.cwd) === resolve(cwd);
}

/** Linux read-only preflight; does not stop or send to any external process. */
export async function claudeWorkspaceOccupation(cwd: string, binary: string): Promise<'idle' | 'busy' | 'unknown'> {
  if (process.platform !== 'linux' || !process.getuid) return 'unknown';
  try {
    for (const pid of await readdir('/proc')) {
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
      const dir = join('/proc', pid);
      try {
        if ((await stat(dir)).uid !== process.getuid()) continue;
        const argv = (await readFile(join(dir, 'cmdline'), 'utf8')).split('\0').filter(Boolean);
        // Only inspect cwd for a recognized Claude executable.
        if (!occupiesClaudeWorkspace({ argv, cwd }, cwd, binary)) continue;
        const actualCwd = await readlink(join(dir, 'cwd'));
        if (occupiesClaudeWorkspace({ argv, cwd: actualCwd }, cwd, binary)) return 'busy';
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        return 'unknown';
      }
    }
    return 'idle';
  } catch { return 'unknown'; }
}
