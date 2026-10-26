import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { CLAUDE_MODEL_QUERY_ARGS, claudeSessionOccupation, isClaudeWorkProcess, sessionFromArgv } from '../../../src/agent/claude/occupation';

const SESSION = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-8888-7777-6666-555555555555';
const process_ = (pid: number, argv: string[], cwd = '/repo') => ({ pid, argv, cwd });

it('recognizes native and Node Claude executables without matching unrelated processes', () => {
  expect(isClaudeWorkProcess(['/bin/claude', '--resume', SESSION], 'claude')).toBe(true);
  expect(isClaudeWorkProcess(['node', '/npm/@anthropic-ai/claude-code/cli.js'], 'claude')).toBe(true);
  expect(isClaudeWorkProcess(['bash', '-c', 'claude'], 'claude')).toBe(false);
});

it('does not mistake an owned read-only model query for an active task in the same project', () => {
  const query = ['/usr/bin/claude', ...CLAUDE_MODEL_QUERY_ARGS];
  expect(isClaudeWorkProcess(query, 'claude')).toBe(false);
  expect(isClaudeWorkProcess([...query, '-p', 'real task'], 'claude')).toBe(true);
  // The bridge's own session listing holds no session.
  expect(isClaudeWorkProcess(['/usr/bin/claude', 'agents', '--json'], 'claude')).toBe(false);
});

it('reads a session hint from the launch arguments', () => {
  expect(sessionFromArgv(['/bin/claude', '--resume', SESSION])).toBe(SESSION);
  expect(sessionFromArgv(['/bin/claude', `--resume=${SESSION}`])).toBe(SESSION);
  expect(sessionFromArgv(['/bin/claude', '-r', SESSION])).toBe(SESSION);
  expect(sessionFromArgv(['/bin/claude', '--session-id', SESSION])).toBe(SESSION);
  expect(sessionFromArgv(['/bin/claude', '--resume', 'search words'])).toBeUndefined();
  expect(sessionFromArgv(['/bin/claude'])).toBeUndefined();
});

it('returns idle without consulting the CLI when the directory has no other Claude process', async () => {
  const liveSessions = vi.fn(async () => new Map<number, string>());
  expect(await claudeSessionOccupation('/repo', SESSION, 'claude', { processes: async () => [], liveSessions })).toBe('idle');
  expect(liveSessions).not.toHaveBeenCalled();
});

it('is busy only for the same session, and idle for a different one in the same directory', async () => {
  const deps = { processes: async () => [process_(4242, ['/bin/claude'])], liveSessions: async () => new Map([[4242, SESSION]]) };
  expect(await claudeSessionOccupation('/repo', SESSION, 'claude', deps)).toBe('busy');
  expect(await claudeSessionOccupation('/repo', OTHER, 'claude', deps)).toBe('idle');
});

it('follows an in-process session switch instead of the original launch arguments', async () => {
  const deps = { processes: async () => [process_(4242, ['/bin/claude', '--resume', OTHER])], liveSessions: async () => new Map([[4242, SESSION]]) };
  expect(await claudeSessionOccupation('/repo', SESSION, 'claude', deps)).toBe('busy');
  expect(await claudeSessionOccupation('/repo', OTHER, 'claude', deps)).toBe('idle');
});

it('falls back to the launch arguments when the CLI cannot report live sessions', async () => {
  const deps = { processes: async () => [process_(4242, ['/bin/claude', '--resume', SESSION])], liveSessions: async () => undefined };
  expect(await claudeSessionOccupation('/repo', SESSION, 'claude', deps)).toBe('busy');
  expect(await claudeSessionOccupation('/repo', OTHER, 'claude', deps)).toBe('idle');
});

it('falls back to the per-process registry entry for a process without arguments hints', async () => {
  const deps = { processes: async () => [process_(4242, ['/bin/claude'])], liveSessions: async () => undefined, registry: async (pid: number) => pid === 4242 ? SESSION : undefined };
  expect(await claudeSessionOccupation('/repo', SESSION, 'claude', deps)).toBe('busy');
  expect(await claudeSessionOccupation('/repo', OTHER, 'claude', deps)).toBe('idle');
});

it('stays conservative when a candidate session cannot be determined', async () => {
  const processes = async () => [process_(4242, ['/bin/claude']), process_(4343, ['/bin/claude', '--resume', OTHER])];
  const deps = { processes, liveSessions: async () => undefined, registry: async () => undefined };
  expect(await claudeSessionOccupation('/repo', SESSION, 'claude', deps)).toBe('unknown');
  // A known duplicate still wins over the unattributable process.
  expect(await claudeSessionOccupation('/repo', OTHER, 'claude', deps)).toBe('busy');
});

it('ignores its own process and reports unknown when the scan is unavailable', async () => {
  expect(await claudeSessionOccupation('/repo', SESSION, 'claude', { processes: async () => [process_(process.pid, ['/bin/claude'])], liveSessions: async () => new Map([[process.pid, SESSION]]) })).toBe('idle');
  expect(await claudeSessionOccupation('/repo', SESSION, 'claude', { processes: async () => 'unknown' })).toBe('unknown');
});

it.skipIf(process.platform !== 'linux')('detects a live external process resuming the same session', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-occupation-'));
  const binary = join(cwd, 'claude');
  await writeFile(binary, 'setInterval(() => {}, 1000);');
  const child = spawn(process.execPath, [binary, '--resume', SESSION], { cwd, stdio: 'ignore' });
  // The child is this test's descendant, so stand in for a user's own terminal;
  // older CLIs have no `agents --json`, so the arguments hint must decide.
  const deps = { liveSessions: async () => undefined, isOwn: async () => false };
  try {
    await once(child, 'spawn');
    expect(await claudeSessionOccupation(cwd, SESSION, binary, deps)).toBe('busy');
    expect(await claudeSessionOccupation(cwd, OTHER, binary, deps)).toBe('idle');
    const exited = once(child, 'exit'); child.kill(); await exited;
    expect(await claudeSessionOccupation(cwd, SESSION, binary, deps)).toBe('idle');
  } finally {
    child.kill(); await rm(cwd, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== 'linux')('ignores this worker\'s own Claude children', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-occupation-'));
  const binary = join(cwd, 'claude');
  await writeFile(binary, 'setInterval(() => {}, 1000);');
  const child = spawn(process.execPath, [binary, '--resume', SESSION], { cwd, stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    expect(await claudeSessionOccupation(cwd, SESSION, binary, { liveSessions: async () => undefined })).toBe('idle');
  } finally {
    child.kill(); await rm(cwd, { recursive: true, force: true });
  }
});
