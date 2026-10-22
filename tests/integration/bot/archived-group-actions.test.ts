import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { LarkChannel, CardActionEvent } from '@larksuite/channel';
import type { Controls } from '../../../src/commands';
import { archivedGroupToken } from '../../../src/bot/archived-group-actions';
import { startSessionArchiveNotifications } from '../../../src/bot/session-archive-notifications';
import { handleCardAction } from '../../../src/card/dispatcher';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { PendingQueue } from '../../../src/bot/pending-queue';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache';
import { createFakeChannel } from '../../helpers/fake-channel';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile } from '../../helpers/tmp-profile';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture(toolId: 'codex' | 'claude' | 'kilo' | 'zcode' | 'dsh' = 'codex') {
  const tmp = await createTmpProfile('archived-group-action-'); cleanup.push(() => tmp.cleanup());
  const catalog = new SessionCatalog(join(tmp.profile, 'catalog.json')); await catalog.load();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json')); await sessions.load();
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json')); await workspaces.load();
  const bindings = new ToolBindingStore(join(tmp.profile, 'bindings.json')); await bindings.load();
  cleanup.push(() => Promise.all([catalog.flush(), sessions.flush(), workspaces.flush(), bindings.flush()]));
  const controls = { profile: 'test', profileConfig: createDefaultProfileConfig({ agentKind: 'codex',
    accounts: { app: { id: 'bot', secret: 'test', tenant: 'feishu' } } }),
    toolBindings: bindings, botOwnerId: 'ou_owner', ownerRefreshState: 'ok' } as Controls;
  const channel = createFakeChannel(), deletion = vi.spyOn(channel.rawClient.im.v1.chat, 'delete');
  const agent = new FakeAgentAdapter({ id: toolId }), pending = new PendingQueue(60_000, () => {});
  cleanup.push(async () => pending.cancelAll());
  const identity = { scopeId: 'oc_group', agentId: toolId, sourceId: 'source', botAppId: 'bot', cwdRealpath: tmp.workspace,
    policyFingerprint: 'original', ...(toolId === 'codex' ? { threadId: 'native' } : { sessionId: 'native' }) };
  bindings.set('oc_group', { toolId, sourceId: 'source', nativeId: 'native' });
  catalog.upsertActive(identity); sessions.set('oc_group', 'native', tmp.workspace); workspaces.setCwd('oc_group', tmp.workspace);
  catalog.archiveScope('oc_group', 'native', true);
  const notices = startSessionArchiveNotifications({ channel: channel as unknown as LarkChannel, controls, catalog, intervalMs: 60_000 });
  cleanup.push(() => notices.stop()); await notices.flush();
  const sent = channel.rawClient.requests.find(r => r.method === 'im.v1.message.create')!;
  const card = JSON.parse((sent.params as any).data.content), value = card.body.elements[1].behaviors[0].value;
  const activeRuns = new ActiveRuns();
  const dispatch = (payload = value, operatorId = 'ou_owner', mode: 'group' | 'topic' | 'p2p' = 'group', chatId = 'oc_group') => handleCardAction({
    channel: channel as unknown as LarkChannel, controls, sessionCatalog: catalog, sessions, workspaces, activeRuns, agent, pending,
    chatModeCache: { resolve: async () => mode } as unknown as ChatModeCache,
    evt: { chatId, messageId: 'om_notice', operator: { openId: operatorId }, action: { value: payload } } as CardActionEvent,
  });
  return { tmp, identity, controls, channel, deletion, agent, pending, catalog, sessions, workspaces, bindings, value, dispatch };
}

it.each(['codex', 'claude', 'kilo', 'zcode', 'dsh'] as const)('confirms and dissolves the archived %s group once through the ordinary callback path without touching native history', async toolId => {
  const h = await fixture(toolId);
  await h.dispatch(); expect(h.deletion).not.toHaveBeenCalled();
  const confirmation = (h.channel.sent.at(-1)!.content as any).card;
  expect(confirmation.body.elements[0].content).toContain('群聊解散后无法恢复');
  const choice = confirmation.body.elements[1].behaviors[0].value;
  expect(choice).toEqual({ cmd: 'archive-group.dissolve', arg: h.value.arg });
  h.pending.push('oc_group', { messageId: 'queued', content: 'do not run' } as any);
  await Promise.all([h.dispatch(choice), h.dispatch(choice)]);
  expect(h.deletion).toHaveBeenCalledOnce(); expect(h.deletion).toHaveBeenCalledWith({ path: { chat_id: 'oc_group' } });
  expect(h.catalog.isChatDissolved('oc_group')).toBe(true);
  expect(h.catalog.isAutoGroupSuppressed(toolId, 'source', 'native')).toBe(true);
  expect(h.bindings.get('oc_group')).toBeUndefined(); expect(h.workspaces.cwdFor('oc_group')).toBeUndefined();
  expect(h.sessions.getRaw('oc_group')).toBeUndefined(); expect(h.pending.cancel('oc_group')).toHaveLength(0);
  expect(h.agent.runs).toHaveLength(0); expect(h.agent.archivedThreads).toHaveLength(0);
});

it.each(['member', 'invalid-token', 'foreign-app', 'source', 'rebound', 'unarchived', 'shared', 'dissolved'] as const)('rejects a %s dissolution without deleting a group', async state => {
  const h = await fixture(), choice = { ...h.value, cmd: 'archive-group.dissolve' };
  if (state === 'invalid-token') choice.arg = '0'.repeat(64);
  if (state === 'foreign-app') h.controls.profileConfig.accounts.app.id = 'other';
  if (state === 'source') { h.bindings.removeChat('oc_group'); h.bindings.set('oc_group', { toolId: 'codex', sourceId: 'other', nativeId: 'native' }); }
  if (state === 'rebound' || state === 'unarchived') {
    h.catalog.upsertActive({ ...h.identity, rebindArchivedScope: true, now: Date.now() + 1000 });
    if (state === 'rebound') h.catalog.archiveScope('oc_group', 'native');
  }
  if (state === 'shared') h.bindings.set('oc_group', { toolId: 'codex', sourceId: 'source', nativeId: 'native',
    linkedSource: { toolId: 'codex', sourceId: 'source', nativeId: 'native' } });
  if (state === 'dissolved') h.catalog.markChatDissolved('oc_group', []);
  await h.dispatch(choice, state === 'member' ? 'ou_member' : 'ou_owner');
  expect(h.deletion).not.toHaveBeenCalled(); expect(h.agent.runs).toHaveLength(0);
});

it.each(['topic', 'p2p'] as const)('ignores archive dissolution outside an ordinary group: %s', async mode => {
  const h = await fixture(); await h.dispatch({ ...h.value, cmd: 'archive-group.dissolve' }, 'ou_owner', mode);
  expect(h.deletion).not.toHaveBeenCalled(); expect(h.agent.runs).toHaveLength(0);
});

it('keeps the token valid across bridge restart and preserves a permission-failed group for retry', async () => {
  const h = await fixture(); await h.catalog.flush(); await h.bindings.flush();
  const catalog = new SessionCatalog(join(h.tmp.profile, 'catalog.json')); await catalog.load();
  const bindings = new ToolBindingStore(join(h.tmp.profile, 'bindings.json')); await bindings.load();
  expect(archivedGroupToken({ ...h.controls, toolBindings: bindings }, catalog, 'oc_group')).toBe(h.value.arg);
  const choice = { ...h.value, cmd: 'archive-group.dissolve' };
  h.deletion.mockResolvedValueOnce({ code: 232017 }); await h.dispatch(choice);
  expect(h.catalog.isChatDissolved('oc_group')).toBe(false); expect(h.bindings.get('oc_group')).toBeDefined();
  expect(JSON.stringify(h.channel.sent.at(-1)!.content)).toContain('232017');
  await h.dispatch(choice); expect(h.deletion).toHaveBeenCalledTimes(2); expect(h.catalog.isChatDissolved('oc_group')).toBe(true);
});

it('ignores unrelated controls and agent callbacks in an archived group', async () => {
  const h = await fixture();
  for (const cmd of ['stop', 'refresh', 'finish.archive-dissolve', 'config']) await h.dispatch({ cmd });
  await h.dispatch({ __worker_input: 'old-question' }); await h.dispatch({ __bridge_cb: true, bridge_token: 'old', value: 'run' });
  expect(h.deletion).not.toHaveBeenCalled(); expect(h.agent.runs).toHaveLength(0); expect(h.pending.cancel('oc_group')).toHaveLength(0);
});

it('permits configured administrators while refusing a confirmation redirected to another group', async () => {
  const h = await fixture(), choice = { ...h.value, cmd: 'archive-group.dissolve' };
  h.controls.profileConfig.access.admins.push('ou_admin');
  await h.dispatch(choice, 'ou_admin', 'group', 'oc_other'); expect(h.deletion).not.toHaveBeenCalled();
  await h.dispatch(choice, 'ou_admin'); expect(h.deletion).toHaveBeenCalledOnce();
});
