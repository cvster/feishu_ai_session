import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { CLAUDE_MODEL_QUERY_ARGS, claudeWorkspaceOccupation, occupiesClaudeWorkspace } from '../../../src/agent/claude/occupation';

it('recognizes native and Node Claude executables without matching unrelated processes', () => {
  expect(occupiesClaudeWorkspace({ argv: ['/bin/claude', '--resume', 'id'], cwd: '/repo' }, '/repo', 'claude')).toBe(true);
  expect(occupiesClaudeWorkspace({ argv: ['node', '/npm/@anthropic-ai/claude-code/cli.js'], cwd: '/repo' }, '/repo', 'claude')).toBe(true);
  expect(occupiesClaudeWorkspace({ argv: ['/bin/claude'], cwd: '/other' }, '/repo', 'claude')).toBe(false);
  expect(occupiesClaudeWorkspace({ argv: ['bash', '-c', 'claude'], cwd: '/repo' }, '/repo', 'claude')).toBe(false);
});

it.skipIf(process.platform !== 'linux')('detects a live external Claude process and permits resume only after exit', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'claude-occupation-'));
  const binary = join(cwd, 'claude');
  await writeFile(binary, 'setInterval(() => {}, 1000);');
  const child = spawn(process.execPath, [binary], { cwd, stdio: 'ignore' });
  try {
    await once(child, 'spawn');
    expect(await claudeWorkspaceOccupation(cwd, binary)).toBe('busy');
    const exited = once(child, 'exit'); child.kill(); await exited;
    expect(await claudeWorkspaceOccupation(cwd, binary)).toBe('idle');
  } finally {
    child.kill(); await rm(cwd, { recursive: true, force: true });
  }
});

it('does not mistake an owned read-only model query for an active task in the same project', () => {
  const query = { argv: ['/usr/bin/claude', ...CLAUDE_MODEL_QUERY_ARGS], cwd: '/project' };
  expect(occupiesClaudeWorkspace(query, '/project', 'claude')).toBe(false);
  expect(occupiesClaudeWorkspace({ ...query, argv: [...query.argv, '-p', 'real task'] }, '/project', 'claude')).toBe(true);
});
