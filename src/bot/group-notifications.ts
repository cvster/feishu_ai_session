import type { LarkChannel } from '@larksuite/channel';
import { log } from '../core/logger';
import { spawnProcess } from '../platform/spawn';

interface OwnerContext {
  appId: string;
  ownerId(): string | undefined;
}
type CliRunner = (args: string[], data?: unknown) => Promise<unknown>;
interface Notifications {
  context: OwnerContext;
  run: CliRunner;
  pending: Map<string, Promise<void>>;
}
const channels = new WeakMap<LarkChannel, Notifications>();

/** Management uses the owner's CLI, never the bot-only CLI exposed to agents. */
export function configureGroupNotifications(channel: LarkChannel, context: OwnerContext, run?: CliRunner): void {
  channels.set(channel, { context, run: run ?? ((args, data) => runOwnerCli(context.appId, args, data)), pending: new Map() });
}

/** Apply once at creation/linking; later manual notification changes are respected. */
export async function muteSessionGroup(channel: LarkChannel, chatId: string): Promise<void> {
  const state = channels.get(channel);
  if (!state) return;
  const ownerId = state.context.ownerId();
  if (!ownerId) {
    log.warn('group-notifications', 'mute-skipped-owner-unavailable', { chatId });
    return;
  }
  const key = JSON.stringify([ownerId, chatId]);
  let task = state.pending.get(key);
  if (!task) {
    task = (async () => {
      const auth = await state.run(['auth', 'status', '--json']) as {
        appId?: string; identities?: { user?: { available?: boolean; openId?: string } };
      };
      if (auth?.appId !== state.context.appId || auth.identities?.user?.available !== true ||
        auth.identities.user.openId !== ownerId || state.context.ownerId() !== ownerId) {
        throw new Error('owner CLI application/user mismatch or user not authorized');
      }
      const result = await state.run(['im', 'chat.user_setting', 'batch_update', '--as', 'user', '--data', '-'], {
        chat_settings: [{ chat_id: chatId, is_muted: true }],
      }) as { ok?: boolean; identity?: string; data?: { invalid_ids?: unknown[] } };
      if (result?.ok !== true || result.identity !== 'user' || !result.data ||
        (result.data.invalid_ids !== undefined && (!Array.isArray(result.data.invalid_ids) || result.data.invalid_ids.length))) {
        throw new Error('owner chat mute request failed or chat not accessible');
      }
      log.info('group-notifications', 'muted', { chatId });
    })();
    state.pending.set(key, task);
  }
  try { await task; }
  catch (error) {
    if (state.pending.get(key) === task) state.pending.delete(key);
    // Notification preferences must not turn a successful group creation into a retry/duplicate.
    log.warn('group-notifications', 'mute-failed', { chatId, error: String(error) });
  }
}

async function runOwnerCli(appId: string, args: string[], data?: unknown): Promise<unknown> {
  const env = { ...process.env };
  for (const key of ['LARK_CHANNEL', 'LARK_CHANNEL_PROFILE', 'LARK_CHANNEL_HOME', 'LARK_CHANNEL_CONFIG', 'LARKSUITE_CLI_CONFIG_DIR']) delete env[key];
  if (process.env.LARK_CHANNEL_OWNER_CLI_CONFIG_DIR) env.LARKSUITE_CLI_CONFIG_DIR = process.env.LARK_CHANNEL_OWNER_CLI_CONFIG_DIR;
  env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1';
  env.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1';
  return new Promise((resolve, reject) => {
    const child = spawnProcess('lark-cli', ['--profile', appId, ...args], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    const fail = (message: string) => { child.kill('SIGKILL'); reject(new Error(message)); };
    const timer = setTimeout(() => fail('owner CLI request timed out'), 15_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) fail('owner CLI response too large');
      else chunks.push(chunk);
    });
    child.stdin?.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new Error('owner CLI unavailable')); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(`owner CLI request failed (exit ${code})`)); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('owner CLI returned invalid JSON')); }
    });
    child.stdin?.end(data === undefined ? undefined : JSON.stringify(data));
  });
}
