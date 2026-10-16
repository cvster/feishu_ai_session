import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

// Exact owned discovery invocation; it never receives a user turn or persists a session.
export const CLAUDE_MODEL_QUERY_ARGS = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--name', 'lark-bridge-model-catalog-readonly'] as const;

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
  const optionsIndex = process.argv.indexOf('--input-format');
  if (isClaude && optionsIndex >= 1 && optionsIndex <= 2 && process.argv.slice(optionsIndex).join('\0') === CLAUDE_MODEL_QUERY_ARGS.join('\0')) return false;
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
