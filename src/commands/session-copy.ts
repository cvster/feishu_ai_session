import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { access } from 'node:fs/promises';
import type { CommandContext } from './index';
import type { CopiedSessionSource } from '../tools/bindings';
import { nativeSessionId, type ToolId } from '../tools/definitions';
import { sessionOperations } from '../tools/session-api';
import { sessionCopyCard } from '../card/templates';
import { sendManagedCard } from '../card/managed';

interface CopyChoice {
  actor: string;
  scope: string;
  appId: string;
  source: CopiedSessionSource;
  target: ToolId;
  targetSource?: string;
  expires: number;
  creating?: boolean;
  created?: boolean;
  name?: string;
  defaultName: string;
}
const choices = new Map<string, CopyChoice>();

function nextCopyName(name: string, existing: Set<string>): string {
  const suffix = /^(.*)-(\d+)$/.exec(name);
  const base = suffix ? suffix[1]! : name;
  let number = suffix ? BigInt(suffix[2]!) + 1n : 2n;
  while (existing.has(`${base}-${number}`)) number++;
  return `${base}-${number}`;
}

export async function currentCopySource(ctx: CommandContext): Promise<CopiedSessionSource> {
  const toolId = ctx.controls.profileConfig.agentKind;
  const tool = ctx.controls.toolRegistry?.find(toolId);
  const binding = ctx.controls.toolBindings?.get(ctx.scope);
  const appId = ctx.controls.profileConfig.accounts.app.id;
  const row = ctx.sessionCatalog?.entries().filter(e => e.status === 'active' && e.scopeId === ctx.scope &&
    e.botAppId === appId && e.agentId === toolId && (!tool || !e.sourceId || e.sourceId === tool.sourceId))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const id = row ? nativeSessionId(toolId, row) : binding?.nativeCreated !== false ? binding?.nativeId : undefined;
  if (!id || ctx.sessionCatalog?.isScopeArchived(ctx.scope) || (binding && tool && binding.sourceId !== tool.sourceId))
    throw new Error('当前群尚未绑定本机器人的可用会话，无法复制。');
  const native = !binding?.name && tool ? (await tool.listSessions()).find(s => s.nativeId === id) : undefined;
  return { toolId, sourceId: tool?.sourceId ?? row?.sourceId ?? '', nativeId: id,
    cwd: row?.cwdRealpath ?? ctx.workspaces.cwdFor(ctx.scope) ?? '',
    name: binding?.name || native?.name || ctx.controls.knownChats?.find(c => c.id === ctx.msg.chatId)?.name || id,
    copyId: randomUUID() };
}

export async function showSessionCopyMenu(ctx: CommandContext): Promise<void> {
  const source = await currentCopySource(ctx);
  const tools = ctx.controls.toolRegistry?.all() ?? [];
  const available = await Promise.allSettled(tools.map(t => t.agent.isAvailable()));
  const creationTools = tools.filter((_, i) => available[i]?.status === 'fulfilled' && (available[i] as PromiseFulfilledResult<boolean>).value);
  // Include unbound native sessions and pending group bindings, not only the
  // Web sidebar. Both copy rows share the same suggested name across tools.
  const rosters = await Promise.allSettled(creationTools.map(t => t.listSessions()));
  const existing = new Set([source.name,
    ...(ctx.controls.toolBindings?.entries() ?? []).map(([, b]) => b.name ?? ''),
    ...rosters.flatMap(r => r.status === 'fulfilled' ? r.value.map(s => s.name ?? '') : []),
  ].map(name => name.trim()).filter(Boolean));
  const defaultName = nextCopyName(source.name, existing);
  for (const [key, choice] of choices) if (choice.expires < Date.now()) choices.delete(key);
  const issue = (target: ToolId) => {
    const token = randomUUID();
    choices.set(token, { actor: ctx.msg.senderId, scope: ctx.scope, appId: ctx.controls.profileConfig.accounts.app.id,
      source: { ...source, copyId: randomUUID() }, target, targetSource: ctx.controls.toolRegistry?.find(target)?.sourceId, defaultName, expires: Date.now() + 15 * 60_000 });
    return token;
  };
  await sendManagedCard(ctx.channel, ctx.msg.chatId, sessionCopyCard(source.toolId, issue(source.toolId), creationTools.map(t => ({ id: t.id, token: issue(t.id) })), defaultName),
    { replyTo: ctx.msg.messageId, ...(ctx.chatMode === 'topic' ? { replyInThread: true } : {}) });
}

export async function sessionCopyChoice(ctx: CommandContext, token: string): Promise<CopyChoice> {
  const choice = choices.get(token);
  if (!choice || choice.expires < Date.now() || choice.actor !== ctx.msg.senderId || choice.scope !== ctx.scope ||
      choice.appId !== ctx.controls.profileConfig.accounts.app.id) throw new Error('复制会话操作已过期，请重新打开。');
  const source = await currentCopySource(ctx);
  if (source.toolId !== choice.source.toolId || source.sourceId !== choice.source.sourceId || source.nativeId !== choice.source.nativeId || source.cwd !== choice.source.cwd ||
      choice.targetSource !== ctx.controls.toolRegistry?.find(choice.target)?.sourceId) throw new Error('会话或工具来源已变化，请重新打开复制会话。');
  return choice;
}

export async function readCopiedSession(ctx: CommandContext, copyId: string): Promise<void> {
  const binding = ctx.controls.toolBindings?.get(ctx.scope);
  const source = binding?.copiedFrom;
  if (!ctx.fromCardAction || !source || source.copyId !== copyId || ctx.sessionCatalog?.isScopeArchived(ctx.scope))
    throw new Error('读取入口已失效，请在新会话中要求读取原会话。');
  const tool = ctx.controls.toolRegistry?.find(source.toolId);
  if (!tool || tool.sourceId !== source.sourceId) throw new Error('来源工具配置已变化，无法读取原会话。');
  const historyPath = await sessionOperations(tool).historyPath(source.nativeId);
  if (!historyPath) throw new Error('原会话记录暂不可读，请稍后重试。');
  await access(historyPath);
  if (!ctx.controls.submitMessage) throw new Error('消息入口暂不可用，请稍后重试。');
  const content = `读取${tool.label} '${basename(source.cwd)}/${source.name}' 的内容\n会话记录：${historyPath}`;
  const sent = await ctx.channel.send(ctx.msg.chatId, { text: content }, {
    ...(ctx.msg.messageId ? { replyTo: ctx.msg.messageId } : {}), ...(ctx.chatMode === 'topic' ? { replyInThread: true } : {}),
  });
  await ctx.controls.submitMessage({ ...ctx.msg, messageId: ctx.msg.messageId || sent.messageId || `copy-read-${copyId}`, content,
    chatType: ctx.chatMode === 'p2p' ? 'p2p' : 'group', rawContentType: 'card_action', raw: { bridgeCallbackId: `copy-read-${copyId}` },
    mentionedBot: true, mentionAll: false, resources: [], mentions: [], createTime: Date.now() });
}
