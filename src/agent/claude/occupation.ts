import { execFile } from 'node:child_process';
import { readFile, readdir, readlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { promisify } from 'node:util';

// Exact owned discovery invocation; it never receives a user turn or persists a session.
export const CLAUDE_MODEL_QUERY_ARGS = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--name', 'lark-bridge-model-catalog-readonly'] as const;

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ClaudeProcess {
  pid: number;
  argv: string[];
  cwd: string;
}

/**
 * A Claude CLI process that could run a turn in `cwd`. The owned read-only
 * model catalog query is excluded: it never receives a turn or persists state.
 */
export function isClaudeWorkProcess(argv: string[], binary: string): boolean {
  const commands = new Set(['claude', 'claude.exe', 'claude.cmd', basename(binary)]);
  const isClaude = argv.slice(0, 2).some(arg => commands.has(basename(arg))) ||
    argv.some(arg => /[/\\]@anthropic-ai[/\\]claude-code[/\\]/.test(arg));
  // Read-only listings: the owned catalog query and our own `agents --json` probe.
  if (isClaude && argv[1] === 'agents' && argv.includes('--json')) return false;
  const optionsIndex = argv.indexOf('--input-format');
  if (isClaude && optionsIndex >= 1 && optionsIndex <= 2 && argv.slice(optionsIndex).join('\0') === CLAUDE_MODEL_QUERY_ARGS.join('\0')) return false;
  return isClaude;
}

/** The session a process was launched for. Interactive sessions can switch afterwards. */
export function sessionFromArgv(argv: string[]): string | undefined {
  for (const flag of ['--resume', '-r', '--session-id']) {
    const at = argv.indexOf(flag);
    const value = at >= 0 ? argv[at + 1] : argv.find(arg => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
    if (value && UUID.test(value)) return value;
  }
  return undefined;
}

/**
 * Live pid → session map reported by the CLI itself (`claude agents --json`).
 * Unlike the per-process registry file this follows in-process session switches.
 */
export async function liveClaudeSessions(binary: string): Promise<Map<number, string> | undefined> {
  try {
    const { stdout } = await execFileAsync(binary, ['agents', '--json'], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    const rows: unknown = JSON.parse(stdout);
    if (!Array.isArray(rows)) return undefined;
    const sessions = new Map<number, string>();
    for (const row of rows as { pid?: unknown; sessionId?: unknown }[]) {
      if (Number.isInteger(row?.pid) && typeof row.sessionId === 'string' && UUID.test(row.sessionId)) sessions.set(row.pid as number, row.sessionId);
    }
    return sessions;
  } catch { return undefined; }
}

/** Fields after the command name in `/proc/<pid>/stat`. */
async function procFields(pid: number): Promise<string[] | undefined> {
  try {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8');
    return text.slice(text.lastIndexOf(')') + 2).split(' ');
  } catch { return undefined; }
}

/** `/proc/<pid>/stat` start time, which changes when a pid is reused. */
async function processStart(pid: number): Promise<string | undefined> {
  return (await procFields(pid))?.[19];
}

/** This worker's own agent children, whose sessions the run lease already tracks. */
async function isOwnDescendant(pid: number): Promise<boolean> {
  for (let current = pid, hops = 0; current > 1 && hops < 64; hops++) {
    const parent = Number((await procFields(current))?.[1]);
    if (!Number.isInteger(parent)) return false;
    if (parent === process.pid) return true;
    current = parent;
  }
  return false;
}

async function configDirOf(pid: number): Promise<string> {
  const own = process.env.CLAUDE_CONFIG_DIR?.trim();
  try {
    const entry = (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0').find(row => row.startsWith('CLAUDE_CONFIG_DIR='));
    if (entry?.slice('CLAUDE_CONFIG_DIR='.length).trim()) return entry.slice('CLAUDE_CONFIG_DIR='.length).trim();
  } catch { /* fall through to this process's own configuration */ }
  return own || join(homedir(), '.claude');
}

/** Fallback for CLIs without `agents --json`: the per-process registry entry written at startup. */
async function registrySession(pid: number): Promise<string | undefined> {
  try {
    const row = JSON.parse(await readFile(join(await configDirOf(pid), 'sessions', `${pid}.json`), 'utf8'));
    if (String(row?.pid) !== String(pid) || typeof row?.sessionId !== 'string' || !UUID.test(row.sessionId)) return undefined;
    // Written once at launch, so a reused pid would otherwise return a stranger's session.
    if (row.procStart && await processStart(pid) !== String(row.procStart)) return undefined;
    return row.sessionId;
  } catch { return undefined; }
}

export interface OccupationDeps {
  /** Claude processes of this user whose cwd equals the target directory. */
  processes?: (cwd: string) => Promise<ClaudeProcess[] | 'unknown'>;
  liveSessions?: () => Promise<Map<number, string> | undefined>;
  registry?: (pid: number) => Promise<string | undefined>;
  /** Whether a process belongs to this worker, and so is not an external holder. */
  isOwn?: (pid: number) => Promise<boolean>;
}

/** Linux read-only preflight of this user's Claude processes in `cwd`. */
export async function claudeProcessesIn(cwd: string, binary: string,
  isOwn: (pid: number) => Promise<boolean> = isOwnDescendant): Promise<ClaudeProcess[] | 'unknown'> {
  if (process.platform !== 'linux' || !process.getuid) return 'unknown';
  const found: ClaudeProcess[] = [];
  try {
    for (const name of await readdir('/proc')) {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
      const dir = join('/proc', name);
      try {
        if ((await stat(dir)).uid !== process.getuid()) continue;
        const argv = (await readFile(join(dir, 'cmdline'), 'utf8')).split('\0').filter(Boolean);
        // Only inspect cwd for a recognized Claude executable.
        if (!isClaudeWorkProcess(argv, binary)) continue;
        // This worker's own runs are serialized by the run lease, not by this preflight.
        if (await isOwn(Number(name))) continue;
        const actual = await readlink(join(dir, 'cwd')).catch(() => undefined);
        if (actual && resolve(actual) === resolve(cwd)) found.push({ pid: Number(name), argv, cwd: actual });
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
        return 'unknown';
      }
    }
    return found;
  } catch { return 'unknown'; }
}

/**
 * Whether resuming `sessionId` would write a transcript that another live
 * process already owns. Other sessions in the same directory are fine: Claude
 * Code supports concurrent sessions per directory and only the same session
 * file is unsafe to share. An unattributable process stays conservative.
 */
export async function claudeSessionOccupation(cwd: string, sessionId: string, binary: string,
  deps: OccupationDeps = {}): Promise<'idle' | 'busy' | 'unknown'> {
  const processes = await (deps.processes ?? (dir => claudeProcessesIn(dir, binary, deps.isOwn)))(cwd);
  if (processes === 'unknown') return 'unknown';
  const others = processes.filter(entry => entry.pid !== process.pid);
  if (!others.length) return 'idle';
  const live = await (deps.liveSessions ?? (() => liveClaudeSessions(binary)))();
  const registry = deps.registry ?? registrySession;
  let unattributed = false;
  for (const entry of others) {
    const held = live?.get(entry.pid) ?? sessionFromArgv(entry.argv) ?? await registry(entry.pid);
    if (held === sessionId) return 'busy';
    // A process without `agents --json` and without a registry entry could still
    // hold this session after an in-process switch; refuse rather than corrupt it.
    if (!held) unattributed = true;
  }
  return unattributed ? 'unknown' : 'idle';
}
