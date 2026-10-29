import { expect, it } from 'vitest';
import { fixture } from './fixture';
import { KiloClient } from '../../../src/agent/kilo/client';
import { KiloNativeConversationReader } from '../../../src/agent/kilo/conversation';
import { KiloSessionProvider } from '../../../src/tools/kilo-sessions';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function within(check: () => boolean, timeout = 3000): Promise<boolean> {
  for (const start = Date.now(); Date.now() - start < timeout; await new Promise(done => setTimeout(done, 50))) if (check()) return true;
  return check();
}

it('serves every session, reader and tool call from a single standalone backend', async () => {
  const h = await fixture();
  const reader = new KiloNativeConversationReader(h.options);
  try {
    expect(await reader.read('ses_source')).toMatchObject({ cwd: h.root, archived: false });
    const sessions = new KiloSessionProvider(h.options, h.root);
    await sessions.listSessions();
    await sessions.historyPath('ses_source');
    const client = new KiloClient(h.options, h.root);
    try { expect(await client.request('GET', '/config', undefined, h.root)).toEqual({ model: 'other/model' }); } finally { await client.close(); }
    const spawns = await h.spawns();
    expect(spawns).toHaveLength(1);
    // The reader still holds the lease: closing the extra client must not stop the engine.
    expect(await within(() => alive(spawns[0]!.pid), 300)).toBe(true);
    expect(() => process.kill(spawns[0]!.pid, 0)).not.toThrow();
  } finally { await reader.close(); }
});

it('starts and stops engines only with the leases, never one per closed client', async () => {
  const h = await fixture();
  const first = new KiloClient(h.options, h.root);
  await first.request('GET', '/config', undefined, h.root);
  const [spawn] = await h.spawns();
  const second = new KiloClient(h.options, h.root);
  await second.request('GET', '/config', undefined, h.root);
  expect(await h.spawns()).toHaveLength(1);
  await first.close();
  await second.request('GET', '/config', undefined, h.root);
  expect(await h.spawns()).toHaveLength(1);
  await second.close();
  expect(await within(() => !alive(spawn!.pid))).toBe(true);
  const third = new KiloClient(h.options, h.root);
  try { await third.request('GET', '/config', undefined, h.root); } finally { await third.close(); }
  expect(await h.spawns()).toHaveLength(2);
});

it('keeps the shared backend warm for the idle window and reuses it for the next client', async () => {
  process.env.LARK_CHANNEL_KILO_IDLE_MS = '3000';
  try {
    const h = await fixture();
    const first = new KiloClient(h.options, h.root);
    await first.request('GET', '/config', undefined, h.root);
    const [spawn] = await h.spawns();
    await first.close();
    await new Promise(done => setTimeout(done, 100));
    const second = new KiloClient(h.options, h.root);
    try { await second.request('GET', '/config', undefined, h.root); } finally { await second.close(); }
    expect((await h.spawns()).map(s => s.pid)).toEqual([spawn!.pid]);
    expect(alive(spawn!.pid)).toBe(true);
  } finally { process.env.LARK_CHANNEL_KILO_IDLE_MS = '0'; }
});
