import { readFile, writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { fixture } from '../../helpers/worker-fixture';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { startWorkerReplies } from '../../../src/worker/replies';
import { createFakeChannel } from '../../helpers/fake-channel';
import type { Controls } from '../../../src/commands';
import type { LarkChannel } from '@larksuite/channel';
import { ZcodeAdapter } from '../../../src/agent/zcode/adapter';
import { DurableAgentAdapter } from '../../../src/worker/adapter';

it('rejects a paired bridge against a worker still using independent execution', async () => {
  const h = await fixture('zcode');
  const adapter = new DurableAgentAdapter(h.client, new ZcodeAdapter({ remoteControlFile: '/private/pair.link' }));
  await expect(adapter.prepareRun(h.options)).rejects.toThrow('桌面配对模式与配置不一致');
  expect(h.calls).toHaveLength(0);
});
it.each(['zcode', 'kilo'] as const)('keeps %s running across bridge detach and recovers exactly one result in its own group', async toolId => {
  const h = await fixture(toolId);
  const options = { ...h.options, initialSessionId: 'sess_ff' };
  const first = h.adapter.run(options);
  const consume = (async () => { for await (const _event of first.events) { /* observation only */ } })();
  await vi.waitFor(() => expect(h.calls).toHaveLength(1));
  await first.detach!(); await consume; expect(h.stop).not.toHaveBeenCalled();
  const bindings = new ToolBindingStore(join(h.dir, 'bindings')); await bindings.load();
  bindings.set('oc_group', { toolId, sourceId: `local-${toolId}`, nativeId: 'sess_ff', nativeCreated: false });
  const profile = createDefaultProfileConfig({ agentKind: toolId, accounts: { app: { id: 'cli_test', secret: 's', tenant: 'feishu' } } });
  const channel = createFakeChannel();
  const update = vi.spyOn(channel, 'updateCardById');
  const catalog = new SessionCatalog(join(h.dir, 'catalog')); await catalog.load();
  const sessions = new SessionStore(join(h.dir, 'sessions')); await sessions.load();
  const controls = { profileConfig: profile, cfg: profile, toolBindings: bindings } as unknown as Controls;
  const activeRuns = new ActiveRuns();
  const deps = { adapter: h.adapter, channel: channel as unknown as LarkChannel, controls, catalog, sessions, activeRuns,
    statePath: join(h.dir, 'replies'), intervalMs: 60000, renderOptions: () => ({ supportsFork: true }) };
  let publisher = await startWorkerReplies(deps);
  try {
    await publisher.runNow(); expect(channel.sent).toHaveLength(1);
    expect(catalog.entries()[0]).toMatchObject({ agentId: toolId, sessionId: 'sess_ff', scopeId: 'oc_group' });
    await publisher.stop(); expect(h.stop).not.toHaveBeenCalled();
    h.finish(); await vi.waitFor(async () => expect((await h.client.list())[0]?.status).toBe('completed'));
    publisher = await startWorkerReplies(deps); await publisher.runNow();
    expect(channel.sent).toHaveLength(1); expect(h.calls).toHaveLength(1);
    const completed = JSON.stringify(update.mock.calls.at(-1)?.[1]);
    for (const cmd of ['stop', 'fork']) expect(completed).toContain(`\"cmd\":\"${cmd}\"`);
    expect(channel.sent[0]?.chatId).not.toBe('oc_other');
    await publisher.stop();
    const path = join(h.dir, 'replies'), ledger = JSON.parse(await readFile(path, 'utf8'));
    for (const delivery of Object.values(ledger.deliveries) as any[]) delete delivery.controlsVersion;
    await writeFile(path, JSON.stringify(ledger));
    const updates = update.mock.calls.length;
    publisher = await startWorkerReplies(deps); await publisher.runNow(); await publisher.runNow();
    expect(update.mock.calls.length).toBe(updates + (toolId === 'zcode' ? 1 : 0));
    expect(channel.sent).toHaveLength(1); expect(h.calls).toHaveLength(1);
  } finally { await publisher.stop(); await Promise.all([bindings.flush(), catalog.flush(), sessions.flush()]); }
});
