import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { KiloAdapter } from '../../../src/agent/kilo/adapter';
import { KiloClient } from '../../../src/agent/kilo/client';
import { readKiloModels } from '../../../src/agent/kilo/models';
import { KiloSessionProvider } from '../../../src/tools/kilo-sessions';
import type { AgentRunOptions, AgentEvent } from '../../../src/agent/types';

it.skipIf(process.env.KILO_LIVE_SMOKE !== '1')('reads a real file, resumes the native model, and continues a native fork with remembered context', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'kilo-bridge-live-'));
  const token = `KILO_TOKEN_${randomBytes(8).toString('hex')}`;
  await writeFile(join(cwd, 'marker.txt'), token);
  const adapter = new KiloAdapter(); const sessions = new KiloSessionProvider({}, join(cwd, 'snapshots'));
  const created: string[] = [];
  try {
    const client = new KiloClient({}, cwd);
    let model: string | undefined;
    try {
      const catalog = await readKiloModels(client, cwd);
      const recent = await client.request('GET', '/experimental/session?limit=50');
      const selected = recent.find((s: any) => !s.parentID && s.model?.providerID && catalog.options.some(m => m.value === `${s.model.providerID}/${s.model.id}`));
      model = process.env.KILO_LIVE_MODEL ?? catalog.selected ?? (selected ? `${selected.model.providerID}/${selected.model.id}` : undefined);
      if (!model || !catalog.options.some(m => m.value === model)) throw new Error('No configured native model available for the Kilo live test; set KILO_LIVE_MODEL');
      console.log(JSON.stringify({ kiloLiveModel: model, modelChoices: catalog.options.length }));
    } finally { await client.close(); }
    const turn = async (input: Partial<AgentRunOptions>) => {
      const run = adapter.run({ runId: randomBytes(6).toString('hex'), cwd, prompt: '', accessMode: 'read-only', ...input });
      const timer = setTimeout(() => void run.stop(), 60000);
      const events: AgentEvent[] = [];
      try { for await (const event of run.events) { events.push(event); if (event.type === 'system' && event.sessionId && !created.includes(event.sessionId)) created.push(event.sessionId); } }
      finally { clearTimeout(timer); }
      expect(await run.waitForExit(6000)).toBe(true);
      const failure = events.find(e => e.type === 'error');
      if (failure?.type === 'error') throw new Error(failure.message);
      expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'normal' });
      return { events, text: events.filter(e => e.type === 'text').map(e => e.delta).join(''), id: created.at(-1)! };
    };
    const first = await turn({ model, prompt: '读取当前目录 marker.txt，记住其内容供下一轮使用，然后只回答 KILO_BRIDGE_READY。', sessionName: '[bridge-check] Kilo integration' });
    console.log('Kilo live: file read complete');
    expect(first.text).toContain('KILO_BRIDGE_READY');
    expect(first.events.some(e => e.type === 'tool_use')).toBe(true);
    const second = await turn({ sessionId: first.id, prompt: '上一轮文件里的完整内容是什么？不要再读文件，只回答原样内容。' });
    console.log('Kilo live: native resume complete');
    expect(second.text).toContain(token);
    expect(second.events.filter(e => e.type === 'system' && e.model).every(e => e.type === 'system' && e.model === model)).toBe(true);
    const copy = await sessions.fork(first.id); created.push(copy.nativeId);
    const fork = await turn({ sessionId: copy.nativeId, prompt: '前文文件的完整内容是什么？不要读文件，只回答原样内容。' });
    console.log('Kilo live: native fork complete');
    expect(fork.text).toContain(token);
    const snapshot = await sessions.historyPath(first.id); expect(snapshot).toBeTruthy();
  } finally {
    for (const id of created) await sessions.archive(id).catch(() => {});
    await rm(cwd, { recursive: true, force: true });
  }
}, 180000);
