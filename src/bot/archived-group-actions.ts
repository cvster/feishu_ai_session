import { createHash } from 'node:crypto';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../commands';
import type { SessionCatalog } from '../session/catalog';
import type { SessionStore } from '../session/store';
import type { WorkspaceStore } from '../workspace/store';
import { isPersonalWorkgroup } from '../tools/bindings';
import { canRunAdminCommand } from '../policy/access';
import { sendManagedCard } from '../card/managed';
import { cleanDissolvedChat } from './group-cleanup';
import { describeChatDeletionError, dissolveChat } from './group';
import { log } from '../core/logger';

export function isArchivedGroupAction(value: unknown): value is { cmd: string; arg?: unknown } {
  if (!value || typeof value !== 'object') return false;
  const cmd = (value as { cmd?: unknown }).cmd;
  return cmd === 'archive-group.confirm' || cmd === 'archive-group.dissolve';
}

/** Survives restart, but changes when the group is rebound, even to the same native session. */
export function archivedGroupToken(controls: Controls, catalog: SessionCatalog, scope: string): string | undefined {
  const binding = controls.toolBindings?.get(scope);
  if (!binding?.nativeId || !isPersonalWorkgroup(scope, binding) || controls.auxiliary?.isAuxiliary(scope) ||
      !catalog.isScopeArchived(scope) || catalog.isChatDissolved(scope)) return;
  const appId = controls.profileConfig.accounts.app.id;
  const row = catalog.entries().filter(row => row.scopeId === scope && row.agentId === binding.toolId &&
    (row.threadId ?? row.sessionId) === binding.nativeId && (!row.sourceId || row.sourceId === binding.sourceId) &&
    (!row.botAppId || row.botAppId === appId)).sort((a, b) => (b.boundAt ?? b.updatedAt) - (a.boundAt ?? a.updatedAt))[0];
  if (row?.status !== 'archived') return;
  return createHash('sha256').update(JSON.stringify([appId, scope, binding.toolId, binding.sourceId, binding.nativeId,
    row.key, row.boundAt ?? row.updatedAt])).digest('hex');
}

export async function handleArchivedGroupAction(input: {
  channel: LarkChannel; controls: Controls; catalog: SessionCatalog; sessions: SessionStore; workspaces: WorkspaceStore;
  chatId: string; operatorId: string; value: { cmd: string; arg?: unknown }; cancelPending(scope: string): Promise<void>;
}): Promise<void> {
  const { channel, controls, catalog, chatId, operatorId, value } = input;
  if (!isArchivedGroupAction(value)) return;
  if (!canRunAdminCommand(controls.profileConfig, controls, operatorId).ok) {
    await channel.send(chatId, { text: '仅所有者或管理员可以解散群。' }); return;
  }
  const valid = () => canRunAdminCommand(controls.profileConfig, controls, operatorId).ok &&
    typeof value.arg === 'string' && value.arg === archivedGroupToken(controls, catalog, chatId);
  if (!valid()) {
    if (!catalog.isChatDissolved(chatId)) await channel.send(chatId, { text: '会话归档状态或群绑定已变化，此解散按钮已失效。' });
    return;
  }
  if (value.cmd === 'archive-group.confirm') {
    const binding = controls.toolBindings?.get(chatId);
    const deleted = binding && controls.toolRegistry?.find(binding.toolId)?.sessions?.archiveEffect === 'delete';
    await sendManagedCard(channel, chatId, {
      schema: '2.0', config: { summary: { content: '是否解散此群？' } }, body: { elements: [
        { tag: 'markdown', content: '会话已归档。是否解散此群？\n\n群聊解散后无法恢复。' + (deleted ? '' : '原生会话历史仍然保留。') },
        { tag: 'button', text: { tag: 'plain_text', content: '确认解散群' }, type: 'danger',
          behaviors: [{ type: 'callback', value: { cmd: 'archive-group.dissolve', arg: value.arg } }] },
      ] },
    }, { isActive: valid });
    return;
  }
  const binding = controls.toolBindings!.get(chatId)!;
  await controls.toolBindings!.withPersonalBinding({ toolId: binding.toolId, sourceId: binding.sourceId, nativeId: binding.nativeId! }, async () => {
    // Concurrent/replayed clicks and old confirmation cards must never delete another binding.
    if (!valid()) return;
    try { await dissolveChat(channel, chatId); }
    catch (error) { await channel.send(chatId, { text: `会话已归档，解散群失败：${describeChatDeletionError(error)}` }); return; }
    try { await cleanDissolvedChat({ ...input, catalog }, chatId); }
    catch (error) { log.fail('session', error, { step: 'archive-notice-dissolved-group-cleanup', chatId }); }
  });
}
