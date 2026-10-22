import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { SessionCatalog } from '../../../src/session/catalog';
import { startNativeTurnSync } from '../../../src/bot/native-turn-sync';
import { projectZcodeConversation } from '../../../src/agent/zcode/conversation';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function messages(id: string, at: number, origin = 'desktop', finished = false): any[] {
  return [{ info: { messageId: id, sessionId: 'sess_native', role: 'user', time: { created: at },
    metadata: { inputIntent: { inputOrigin: origin, sourceCommandId: origin === 'bridge' ? 'bridge-worker' : `command-${id}` } } }, parts: [{ type: 'text', text: 'hi222' }] },
  { info: { messageId: `a-${id}`, sessionId: 'sess_native', role: 'assistant', parentMessageId: id, time: { created: at + 1 }, ...(finished ? { finish: 'stop' } : {}) }, parts: [{ type: 'text', text: 'hello' }] }];
}
async function fixture(stoppable = false) {
  const dir = await mkdtemp(join(tmpdir(), 'zcode-turn-sync-')); cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const bindings = new ToolBindingStore(join(dir, 'bindings.json')); await bindings.load();
  const catalog = new SessionCatalog(join(dir, 'catalog.json')); await catalog.load();
  cleanup.push(async () => { await bindings.flush(); await catalog.flush(); });
  const add = (scope: string, auxiliary = false) => {
    bindings.set(scope, { toolId: 'zcode', sourceId: 'local-zcode', nativeId: 'sess_native',
      ...(auxiliary ? { linkedSource: { toolId: 'zcode' as const, sourceId: 'local-zcode', nativeId: 'sess_native' } } : {}) });
    catalog.upsertActive({ scopeId: scope, agentId: 'zcode', cwdRealpath: dir, policyFingerprint: scope, sessionId: 'sess_native', sourceId: 'local-zcode', botAppId: 'cli_test' });
  };
  add('oc_personal');
  const profile = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex', inheritCodexHome: true }, accounts: { app: { id: 'cli_test', secret: 'test', tenant: 'feishu' } } });
  const controls = { profileConfig: profile, toolBindings: bindings, cfg: { preferences: { messageReply: 'card' } } } as unknown as Controls;
  const snapshot = { session: { sessionId: 'sess_native', sessionKind: 'interactive', title: 'AA-pc飞书桥接开放（ZCode）', workspace: { workspacePath: dir } }, messages: messages('old', 500, 'desktop', true) };
  const stopNative = vi.fn(async () => true);
  const reader = { ...(stoppable ? { stopTurn: stopNative } : {}), read: vi.fn(async () => projectZcodeConversation(structuredClone(snapshot))), close: vi.fn(async () => {}) };
  const create = vi.fn(async (..._args: any[]) => ({ code: 0, data: { message_id: `om_${create.mock.calls.length}` } }));
  const channel = { createCard: vi.fn(async () => ({ cardId: 'card_one' })), updateCardById: vi.fn(async () => {}), rawClient: { im: { v1: { message: { create } } } } } as unknown as LarkChannel;
  let clock = 1000;
  const start = async () => {
    const sync = await startNativeTurnSync({ toolId: 'zcode', displayName: 'ZCode', channel, controls, catalog, sourceId: 'local-zcode', reader,
      statePath: join(dir, 'sync.json'), intervalMs: 60_000, now: () => clock });
    cleanup.push(() => sync.stop()); return sync;
  };
  return { add, bindings, catalog, controls, snapshot, reader, stopNative, create, channel, start, advance: (at: number) => { clock = at; } };
}
it('baselines old hi222, forwards new native input and incremental answer once, and resumes the same card after restart', async () => {
  const h = await fixture(), first = await h.start(); expect(h.create).not.toHaveBeenCalled();
  h.advance(3000); h.snapshot.messages.push(...messages('new-hi222', 2000)); await first.runNow();
  expect(h.create).toHaveBeenCalledTimes(2);
  expect(h.create.mock.calls.map(([r]) => r.data.receive_id)).toEqual(['oc_personal', 'oc_personal']);
  expect(JSON.stringify(h.create.mock.calls[0])).toContain('来自 ZCode 界面');
  expect(JSON.stringify(h.create.mock.calls[0])).toContain('hi222');
  await first.runNow(); expect(h.create).toHaveBeenCalledTimes(2); expect(h.channel.createCard).toHaveBeenCalledOnce();
  await first.stop(); const second = await h.start();
  h.snapshot.messages.at(-1).parts[0].text = 'hello completed'; h.snapshot.messages.at(-1).info.finish = 'stop';
  await second.runNow(); expect(h.create).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(vi.mocked(h.channel.updateCardById).mock.calls.at(-1))).toContain('hello completed');
  expect(await second.refreshMessage('oc_personal', 'om_2')).toBe(true);
  expect(await second.stopScope('oc_personal')).toBe(false); // No unrelated desktop stop through a detached reader.
});
it('does not repeat worker-origin or unknown-origin inputs/answers even with identical text', async () => {
  const h = await fixture(), sync = await h.start(); h.advance(3000);
  const bridged = messages('bridge', 2000, 'bridge', true); bridged[0].info.metadata.inputIntent.inputOrigin = 'desktop';
  const unknown = messages('unknown', 2000, 'desktop', true); delete unknown[0].info.metadata;
  h.snapshot.messages.push(...bridged, ...unknown); await sync.runNow(); expect(h.create).not.toHaveBeenCalled();
  h.snapshot.messages.push(...messages('native', 2500, 'desktop', true)); await sync.runNow(); expect(h.create).toHaveBeenCalledTimes(2);
});
it('does not broadcast to open groups, private groups, FF owner groups or topics sharing the same native session', async () => {
  const h = await fixture();
  for (const scope of ['oc_open', 'oc_private', 'oc_ffowner', 'oc_topic:thread']) h.add(scope, true);
  h.bindings.set('oc_ffowner', { ...h.bindings.get('oc_ffowner')!, auxiliaryWorkgroup: true });
  h.controls.auxiliary = { isAuxiliary: (scope: string) => ['oc_open', 'oc_private'].includes(scope) } as any;
  const sync = await h.start(); h.advance(3000); h.snapshot.messages.push(...messages('new', 2000, 'desktop', true)); await sync.runNow();
  expect(h.create.mock.calls.map(([r]) => r.data.receive_id)).toEqual(['oc_personal', 'oc_personal']);
});
it.each(['archive', 'source', 'binding', 'cwd', 'app'] as const)('stops mirroring when %s changes', async kind => {
  const h = await fixture(), sync = await h.start(); h.advance(3000); h.snapshot.messages.push(...messages('new', 2000, 'desktop', true));
  if (kind === 'archive') h.catalog.archiveScope('oc_personal', 'sess_native');
  if (kind === 'source') h.catalog.upsertActive({ ...h.catalog.entries().find(row => row.scopeId === 'oc_personal')!, sourceId: 'other' });
  if (kind === 'binding') h.bindings.set('oc_personal', { ...h.bindings.get('oc_personal')!, nativeId: 'sess_other' });
  if (kind === 'cwd') h.snapshot.session.workspace.workspacePath = '/other';
  if (kind === 'app') h.controls.profileConfig.accounts.app.id = 'cli_other';
  await sync.runNow(); expect(h.create).not.toHaveBeenCalled();
});
it('rechecks scope ownership after async read before sending anything', async () => {
  const h = await fixture(), sync = await h.start(); h.advance(3000); h.snapshot.messages.push(...messages('new', 2000, 'desktop', true));
  h.reader.read.mockImplementationOnce(async () => { h.catalog.archiveScope('oc_personal', 'sess_native'); return projectZcodeConversation(h.snapshot); });
  await sync.runNow(); expect(h.create).not.toHaveBeenCalled();
});

it('renders a working stop control on native cards and binds clicks to the exact message', async () => {
  const h = await fixture(true), sync = await h.start(); h.advance(3000);
  h.snapshot.messages.push(...messages('desktop-one', 2000)); await sync.runNow();
  expect(JSON.stringify(vi.mocked(h.channel.updateCardById).mock.calls.at(-1))).toContain('stop');
  expect(JSON.stringify(vi.mocked(h.channel.updateCardById).mock.calls.at(-1))).toContain('nativeMirror');
  expect(sync.ownsMessage('oc_personal', 'om_2')).toBe(true);
  expect(sync.ownsMessage('oc_other', 'om_2')).toBe(false);
  expect(await sync.stopScope('oc_personal', 'om_unrelated')).toBe(false); expect(h.stopNative).not.toHaveBeenCalled();
  expect(await sync.stopScope('oc_personal', 'om_2')).toBe(true);
  expect(h.stopNative).toHaveBeenCalledWith('sess_native', 'desktop-one');
  h.stopNative.mockClear(); h.advance(5000); h.snapshot.messages.push(...messages('desktop-new', 4000)); await sync.runNow();
  expect(await sync.stopScope('oc_personal', 'om_2')).toBe(false); expect(h.stopNative).not.toHaveBeenCalled();
  h.bindings.set('oc_personal', { ...h.bindings.get('oc_personal')!, nativeId: 'sess_rebound' });
  expect(sync.ownsMessage('oc_personal', 'om_2')).toBe(true);
  expect(await sync.stopScope('oc_personal', 'om_2')).toBe(false);
});
