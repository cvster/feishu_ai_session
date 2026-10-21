import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

// Codex spawning lives in the shared core; Claude keeps its adapter facade.
vi.mock('../../../packages/codex-core/src/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../packages/codex-core/src/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import { wrapAuxiliaryPrompt } from '../../../src/bot/auxiliary-groups';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter';
import { CodexAdapter } from '../../../src/agent/codex/adapter';

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = 0;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  spawnMock.spawnProcess.mockReset();
});

const prompts = [
  ['direct', '原样输入 <tag>\n第二行'],
  ['context', '<lark_context>\n{"quotes":[{"content":"引用"}]}\n</lark_context>\n\n请看引用'],
  ['group', wrapAuxiliaryPrompt('检查', false, { chatId: 'oc_target' })],
];

describe.each(['claude', 'codex'] as const)('%s prompt delivery', tool => {
  it.each(prompts)('passes %s input unchanged for fresh and resumed conversations', async (_kind, prompt) => {
    for (const resumed of [false, true]) {
      const child = fakeChild();
      spawnMock.spawnProcess.mockReturnValue(child);
      const adapter = tool === 'claude' ? new ClaudeAdapter() : new CodexAdapter({
        binary: '/usr/local/bin/codex', profileStateDir: '/tmp/codex-profile',
        useAppServerForFreshThreads: false, useQueueForExistingThreads: false,
      });
      adapter.run({ runId: 'r1', prompt: prompt!, cwd: '/tmp',
        ...(resumed ? { sessionId: 'session-1', threadId: 'thread-1' } : {}),
      });
      expect(await readAll(child.stdin)).toBe(prompt);
      const args = spawnMock.spawnProcess.mock.calls.at(-1)?.[1] as string[];
      expect(args).not.toContain('--append-system-prompt-file');
      expect(args).not.toContain('--append-system-prompt');
      expect(args).not.toContain('--system-prompt');
    }
  });
});

async function readAll(stream: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
