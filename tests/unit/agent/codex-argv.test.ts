import { describe, expect, it } from 'vitest';
import { buildCodexQueueArgs } from '../../../src/agent/codex/argv.js';

describe('Codex argv contract', () => {
  it('builds a native queue command for an existing Desktop-owned thread', () => {
    expect(
      buildCodexQueueArgs({
        cwd: '/repo',
        sandbox: 'workspace-write',
        threadId: 'thread-123',
        prompt: '晚上好',
        remote: 'unix://',
        images: ['/tmp/image.png'],
        model: 'gpt-5.6-sol',
        reasoningEffort: 'high',
      }),
    ).toEqual([
      'queue',
      '--remote',
      'unix://',
      '--thread',
      'thread-123',
      '--message',
      '晚上好',
      '--image',
      '/tmp/image.png',
    ]);
  });

});
