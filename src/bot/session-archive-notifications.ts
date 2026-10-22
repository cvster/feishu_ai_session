import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../commands';
import type { SessionArchiveNotification, SessionCatalog } from '../session/catalog';
import { log } from '../core/logger';

/** The catalog persists the archive and notification together, before IM I/O. */
export function startSessionArchiveNotifications(options: {
  channel: LarkChannel; controls: Controls; catalog: SessionCatalog; intervalMs?: number; now?: () => number;
}) {
  const { channel, controls, catalog } = options;
  const now = options.now ?? Date.now;
  let stopped = false, running: Promise<void> | undefined, lastWarning = 0;
  const eligible = (n: SessionArchiveNotification) => {
    if (n.botAppId && n.botAppId !== controls.profileConfig.accounts.app.id) return false;
    if (catalog.isChatDissolved(n.scopeId) || !catalog.isScopeArchived(n.scopeId)) return false;
    const b = controls.toolBindings?.get(n.scopeId);
    if (controls.toolRegistry && !controls.toolRegistry.all().some(tool => tool.id === n.agentId && tool.sourceId === b?.sourceId)) return false;
    return !!b && b.toolId === n.agentId && b.nativeId === n.nativeId && (!n.sourceId || b.sourceId === n.sourceId) &&
      !b.linkedSource && !b.sharedScope && !b.auxiliaryWorkgroup && !controls.auxiliary?.isAuxiliary(n.scopeId);
  };
  const flush = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      await catalog.flush();
      for (const notice of catalog.pendingArchiveNotifications()) {
        if (stopped) break;
        if (!eligible(notice)) {
          catalog.completeArchiveNotification(notice.id); await catalog.flush(); continue;
        }
        try {
          // A lost receipt retries the same Feishu uuid only within its 1h
          // deduplication window; never create a second archive message later.
          if (notice.sendingAt !== undefined && now() - notice.sendingAt >= 55 * 60_000)
            throw new Error('归档通知发送结果未确认，已超过消息去重窗口');
          catalog.startArchiveNotification(notice.id, now()); await catalog.flush();
          if (stopped) break;
          if (!eligible(notice)) { catalog.completeArchiveNotification(notice.id); await catalog.flush(); continue; }
          const ownerId = controls.botOwnerId;
          const response = await channel.rawClient.im.v1.message.create({ params: { receive_id_type: 'chat_id' },
            data: { receive_id: notice.scopeId, msg_type: ownerId ? 'post' : 'text',
              content: ownerId ? JSON.stringify({ zh_cn: { title: '', content: [[
                { tag: 'at', user_id: ownerId }, { tag: 'text', text: ' 会话已归档。' },
              ]] } }) : JSON.stringify({ text: '会话已归档。' }), uuid: notice.id } });
          if (response.code || !response.data?.message_id) throw new Error(`归档通知发送未确认：${response.code ?? 'missing-message-id'}`);
          catalog.completeArchiveNotification(notice.id); await catalog.flush();
        } catch (error) {
          if (now() - lastWarning >= 60_000 || !lastWarning) {
            lastWarning = now(); log.warn('session', 'archive-notification-failed', { scope: notice.scopeId, error: String(error) });
          }
        }
      }
    })().catch(error => log.fail('session', error, { step: 'archive-notifications' })).finally(() => { running = undefined; });
    return running;
  };
  const timer = setInterval(() => { void flush(); }, options.intervalMs ?? 2000); timer.unref();
  void flush();
  return { flush, async stop() { stopped = true; clearInterval(timer); await running; } };
}
