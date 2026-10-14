import { beforeEach, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter';
import { claudeWorkspaceOccupation } from '../../../src/agent/claude/occupation';
import type { AgentAvailability } from '../../../src/agent/preflight';

vi.mock('../../../src/agent/claude/occupation', () => ({ claudeWorkspaceOccupation: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

it.each(['busy', 'unknown'] as const)('refuses native resume when external occupation is %s', async state => {
  const adapter = new ClaudeAdapter();
  vi.spyOn(adapter, 'checkAvailability').mockResolvedValue({ ok: true } as AgentAvailability);
  vi.mocked(claudeWorkspaceOccupation).mockResolvedValue(state);
  await expect(adapter.prepareRun({ runId: 'r', prompt: 'continue', cwd: '/repo', sessionId: 'native' }))
    .rejects.toMatchObject({ code: state === 'busy' ? 'native-session-busy' : 'archive-check-unavailable' });
});

it('checks occupation on resume and does not invent a native session for fresh requests', async () => {
  const adapter = new ClaudeAdapter();
  vi.spyOn(adapter, 'checkAvailability').mockResolvedValue({ ok: true } as AgentAvailability);
  vi.mocked(claudeWorkspaceOccupation).mockResolvedValue('idle');
  await adapter.prepareRun({ runId: 'r', prompt: 'continue', cwd: '/repo', sessionId: 'native' });
  expect(claudeWorkspaceOccupation).toHaveBeenCalledOnce();
  await adapter.prepareRun({ runId: 'new', prompt: 'first', cwd: '/repo', initialSessionId: 'reserved' });
  expect(claudeWorkspaceOccupation).toHaveBeenCalledOnce();
});
