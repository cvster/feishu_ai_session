import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZcodeAdapter } from '../../../src/agent/zcode/adapter';
import type { AgentEvent } from '../../../src/agent/types';
it.skipIf(process.env.ZCODE_LIVE_SMOKE !== '1')('creates, continues and reads a file through a real local ZCode session', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'bridge-zcode-live-'));
  const adapter = new ZcodeAdapter(); expect(await adapter.isAvailable()).toBe(true);
  let sessionId: string | undefined;
  const token = `ZCODE_${randomUUID()}`;
  await writeFile(join(cwd, 'marker.txt'), `FILE_${token}`);
  for (const n of [1, 2, 3]) {
    const run = adapter.run({ runId: `live-${Date.now()}-${n}`, cwd, sessionId, prompt: n === 1 ? `记住标记 ${token}，不要调用工具，只回复该标记。` : n === 2 ? '不要调用工具，回复我上轮让你记住的完整标记。' : '请使用读取工具读取当前目录 marker.txt，回复文件中的完整标记。不要修改任何文件。', accessMode: 'read-only' });
    const timer = setTimeout(() => { void run.stop(); }, 45000);
    const events: AgentEvent[] = [];
    try { for await (const event of run.events) { events.push(event); if (event.type === 'system') sessionId = event.sessionId; } }
    finally { clearTimeout(timer); await run.stop(); await run.waitForExit(5000); }
    expect(events.filter(e => e.type === 'error')).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
    expect(events.filter(e => e.type === 'text').map(e => e.delta).join('')).toContain(n === 3 ? `FILE_${token}` : token);
    if (n === 3) expect(events.some(e => e.type === 'tool_result')).toBe(true);
    expect(await run.waitForExit(5000)).toBe(true);
  }
  expect(sessionId).toMatch(/^sess_/);
}, 180000);
