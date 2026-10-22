import type { NormalizedMessage } from '@larksuite/channel';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createFakeChannel } from '../../helpers/fake-channel';
import { createTmpProfile } from '../../helpers/tmp-profile';
import { startWorkerServer } from '../../../src/worker/server';
import { WorkerInbox } from '../../../src/worker/inbox';
const mock = vi.hoisted(() => ({ channel: undefined as unknown }));
vi.mock('@larksuite/channel', async original => ({ ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => mock.channel }));
vi.mock('../../../src/bot/aa-session-groups', () => ({ startAaSessionGroupSync: () => ({ stop() {}, withPaused: async (f: () => Promise<unknown>) => f() }) }));
import { startChannel } from '../../../src/bot/channel';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });

describe('Codex through the common worker transport', () => {
  it('submits raw input once and lets the journal own the reply even with native mirroring and CoT enabled', async () => {
    const h = await harness(); await h.message('raw');
    await vi.waitFor(() => expect(h.worker.store.list()[0]?.status).toBe('completed'));
    await vi.waitFor(() => expect(JSON.stringify(h.channel.rawClient.requests)).toContain('worker answer'), { timeout: 3000 });
    expect(h.raw.runOptions).toHaveLength(1); expect(h.raw.runOptions[0]?.prompt).toBe('原样输入');
    await h.message('raw'); await new Promise(resolve => setTimeout(resolve, 150));
    expect(h.raw.runOptions).toHaveLength(1);
    const requests = h.channel.rawClient.requests.filter(row => row.method === 'im.v1.message.create' && JSON.stringify(row.params).includes('interactive'));
    expect(requests).toHaveLength(1);
  });
  it('preserves pending intake when stopping only the current reply', async () => {
    const h = await harness(); await h.message('next'); await h.message('stop', '/stop');
    await vi.waitFor(() => expect(h.raw.runOptions).toHaveLength(1), { timeout: 3000 });
    expect(h.raw.runOptions[0]?.prompt).toBe('原样输入');
  });
  it('reconnects to the same worker without replaying accepted input or creating another reply', async () => {
    const h = await harness(); await h.message('once');
    await vi.waitFor(() => expect(h.worker.store.list()[0]?.status).toBe('completed'));
    await vi.waitFor(() => expect(h.channel.rawClient.requests.filter(row => row.method === 'im.v1.message.create' && JSON.stringify(row.params).includes('interactive'))).toHaveLength(1));
    await h.bridge.disconnect(); await h.connect();
    await h.message('once'); await new Promise(resolve => setTimeout(resolve, 200));
    expect(h.raw.runOptions).toHaveLength(1); expect(h.channel.rawClient.requests.filter(row => row.method === 'im.v1.message.create' && JSON.stringify(row.params).includes('interactive'))).toHaveLength(1);
  });
  it('rejects restored media without executing a prompt that lost its attachment', async () => {
    const h = await harness(false, true);
    await vi.waitFor(() => expect(JSON.stringify(h.channel.sent)).toContain('附件'), { timeout: 3000 });
    expect(h.raw.runOptions).toHaveLength(0);
    const inbox = new WorkerInbox(join(h.tmp.profile, 'codex-inbox.json')); await inbox.load(); expect(inbox.available()).toEqual([]);
  });
  it('supports startup without workers and attaches a worker discovered later', async () => {
    const h = await harness(true); expect(h.controls.toolRegistry!.all()).toHaveLength(0);
    await h.message('missing'); expect(JSON.stringify(h.channel.sent)).toContain('worker 未发现');
    await h.launch(); await h.controls.refreshWorkerDiscovery!();
    expect(h.controls.toolRegistry!.all().map(tool => tool.id)).toEqual(['codex']);
    await h.message('after-discovery'); await vi.waitFor(() => expect(h.raw.runOptions).toHaveLength(1), { timeout: 3000 });
  });
});
async function harness(late = false, restoredMedia = false) {
  const tmp = await createTmpProfile('codex-worker-channel-'); cleanups.push(() => tmp.cleanup());
  const channel = createFakeChannel(), handlers: { message?: (message: NormalizedMessage) => Promise<void> } = {};
  mock.channel = Object.assign(channel, { botIdentity: { openId: 'ou_bot', name: 'Bridge' }, connect: async () => {}, disconnect: async () => {},
    on: (h: typeof handlers) => Object.assign(handlers, h), getChatMode: async () => 'group', getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }),
    listChats: async () => [], getChatInfo: async () => ({ name: 'test' }), addReaction: async () => 'reaction', removeReaction: async () => {},
    downloadResourceToFile: async () => { throw Error('expired attachment'); } });
  const profile = createDefaultProfileConfig({ agentKind: 'codex', accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    access: { allowedUsers: ['ou_user'], allowedChats: ['oc_group'] }, preferences: { cotMessages: 'brief', messageReply: 'card' } });
  profile.workspaces.default = tmp.workspace;
  const controls = { profile: 'codex', profileConfig: profile, cfg: profile, configPath: join(tmp.profile, 'config.json'), botOwnerId: 'ou_user',
    ownerRefreshState: 'ok', refreshOwner: async () => {}, restart: async () => {}, exit: async () => {}, processId: 'test' } as unknown as Controls;
  const raw = new FakeAgentAdapter({ id: 'codex', events: [{ type: 'system', threadId: 'native', turnId: 'turn' }, { type: 'text', delta: 'worker answer' }, { type: 'done', threadId: 'native', terminationReason: 'normal' }] });
  let worker: Awaited<ReturnType<typeof startWorkerServer>>;
  const launch = async () => {
    worker = await startWorkerServer({ stateDir: join(tmp.profile, 'workers', 'any-name'), sourceId: 'source', botAppId: 'cli_test', agent: raw,
      manifest: { label: 'Codex', nativeField: 'threadId', sessionKind: 'codex-thread', historyFormat: 'jsonl', nativeHistory: false },
      sessions: { list: async () => [{ nativeId: 'native', cwd: tmp.workspace, createdAtMs: 1, updatedAtMs: 2 }], history: async () => undefined,
        conversation: async id => ({ id, cwd: tmp.workspace, archived: false, turns: [{ id: 'turn', createdAtMs: 1, bridge: true, input: '原样输入', state: { blocks: [{ kind: 'text', content: 'worker answer', streaming: false }], terminal: 'done', reasoning: { content: '', active: false }, footer: null } }] }) } });
    cleanups.push(() => worker.close());
  };
  if (!late) await launch();
  const bindings = new ToolBindingStore(join(tmp.profile, 'tool-bindings.json')); await bindings.load();
  bindings.set('oc_group', { toolId: 'codex', sourceId: 'source', nativeId: 'native', nativeCreated: true }); await bindings.flush();
  const msg = (id: string, content = '原样输入') => ({ messageId: id, chatId: 'oc_group', chatType: 'group', senderId: 'ou_user', content, rawContentType: 'text', resources: [], mentionedBot: true, createTime: Date.now(), mentions: [], mentionAll: false } as NormalizedMessage);
  if (restoredMedia) { const inbox = new WorkerInbox(join(tmp.profile, 'codex-inbox.json')); await inbox.load(); await inbox.receive('oc_group', { ...msg('lost'), rawContentType: 'image', resources: [{ type: 'image', fileKey: 'missing' }] }); }
  let bridge: Awaited<ReturnType<typeof startChannel>>;
  const connect = async () => { bridge = await startChannel({ cfg: profile, controls, agent: raw, sessions: new SessionStore(join(tmp.profile, 'sessions.json')),
    sessionCatalog: new SessionCatalog(join(tmp.profile, 'catalog.json')), workspaces: new WorkspaceStore(join(tmp.profile, 'workspaces.json')),
    appPaths: { profileDir: tmp.profile, mediaDir: join(tmp.profile, 'media'), secretsFile: join(tmp.profile, 'secrets'), keystoreSaltFile: join(tmp.profile, 'salt') } }); cleanups.push(() => bridge.disconnect()); };
  await connect();
  return { tmp, channel, controls, raw, get worker() { return worker; }, get bridge() { return bridge; }, launch, connect, message: (id: string, content?: string) => handlers.message!(msg(id, content)) };
}
