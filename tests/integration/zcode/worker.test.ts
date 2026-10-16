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
it('keeps ZCode running across bridge detach and recovers exactly one result in its own group', async () => {
  const h = await fixture('zcode');
  const options = { ...h.options, initialSessionId: 'sess_ff' };
  const first = h.adapter.run(options);
  const consume = (async () => { for await (const _event of first.events) { /* observation only */ } })();
  await vi.waitFor(() => expect(h.calls).toHaveLength(1));
  await first.detach!(); await consume; expect(h.stop).not.toHaveBeenCalled();
  const bindings = new ToolBindingStore(join(h.dir, 'bindings')); await bindings.load();
  bindings.set('oc_group', { toolId: 'zcode', sourceId: 'local-zcode', nativeId: 'sess_ff', nativeCreated: false });
  const profile = createDefaultProfileConfig({ agentKind: 'zcode', accounts: { app: { id: 'cli_test', secret: 's', tenant: 'feishu' } } });
  const channel = createFakeChannel();
  const catalog = new SessionCatalog(join(h.dir, 'catalog')); await catalog.load();
  const sessions = new SessionStore(join(h.dir, 'sessions')); await sessions.load();
  const controls = { profileConfig: profile, cfg: profile, toolBindings: bindings } as unknown as Controls;
  const activeRuns = new ActiveRuns();
  const deps = { adapter: h.adapter, channel: channel as unknown as LarkChannel, controls, catalog, sessions, activeRuns,
    statePath: join(h.dir, 'replies'), intervalMs: 60000 };
  let publisher = await startWorkerReplies(deps);
  try {
    await publisher.runNow(); expect(channel.sent).toHaveLength(1);
    expect(catalog.entries()[0]).toMatchObject({ agentId: 'zcode', sessionId: 'sess_ff', scopeId: 'oc_group' });
    await publisher.stop(); expect(h.stop).not.toHaveBeenCalled();
    h.finish(); await vi.waitFor(async () => expect((await h.client.list())[0]?.status).toBe('completed'));
    publisher = await startWorkerReplies(deps); await publisher.runNow();
    expect(channel.sent).toHaveLength(1); expect(h.calls).toHaveLength(1);
    expect(channel.sent[0]?.chatId).not.toBe('oc_other');
  } finally { await publisher.stop(); await Promise.all([bindings.flush(), catalog.flush(), sessions.flush()]); }
});
