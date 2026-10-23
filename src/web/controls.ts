import { randomUUID } from 'node:crypto';
import type { LarkChannel } from '@larksuite/channel';
import { runCommandHandler, type CommandContext } from '../commands';
import { sendManagedCard } from '../card/managed';
import { WebError } from './service';

export type WebControlElement =
  | { kind: 'text'; text: string }
  | { kind: 'button'; text: string; action: string; primary: boolean; danger?: boolean }
  | { kind: 'select'; name: string; value: string; options: { value: string; text: string }[] }
  | { kind: 'input'; name: string; value: string; label?: string }
  | { kind: 'section'; text: string; elements: WebControlElement[] };
export interface WebControlResult { elements: WebControlElement[] }
type Field = { values?: string[] };
interface Choice {
  owner: string; sessionId: string; cmd: string; args: string; fields: Map<string, Field>; expires: number;
  result?: Promise<WebControlResult>; fingerprint?: string;
}
const callbackCommand = /^(?:config\.(?:models\.\d+|preview|submit|cancel)|fork\.(?:same|to)|finish\.(?:archive|archive-dissolve))$/;

/** Present existing command cards through a Web transport. Native operations stay in the common handlers. */
export class WebSessionControls {
  private choices = new Map<string, Choice>();
  constructor(private context: (scope: string, owner: string) => Promise<CommandContext>) {}

  async execute(sessionId: string, scope: string, owner: string, action: string, values?: unknown): Promise<WebControlResult> {
    for (const [id, choice] of this.choices) if (choice.expires < Date.now()) this.choices.delete(id);
    if (['stop', 'config', 'fork', 'finish'].includes(action)) return this.run(sessionId, scope, owner, action, '', {});
    const choice = this.choices.get(action);
    if (!choice || choice.owner !== owner || choice.sessionId !== sessionId) throw new WebError(409, '操作已过期或会话已变化，请重新打开');
    const input = values ?? {};
    if (typeof input !== 'object' || !input || Array.isArray(input)) throw new WebError(400, '表单内容无效');
    const form: Record<string, string> = {};
    for (const [name, value] of Object.entries(input)) {
      const field = choice.fields.get(name);
      if (!field || typeof value !== 'string' || value.length > 1000 || field.values && !field.values.includes(value)) throw new WebError(400, '表单字段或选项已变化，请重新打开');
      form[name] = value;
    }
    const fingerprint = JSON.stringify(Object.entries(form).sort(([a], [b]) => a.localeCompare(b)));
    if (choice.result && choice.fingerprint !== fingerprint) throw new WebError(409, '此操作已提交，请重新打开');
    choice.fingerprint = fingerprint;
    return choice.result ??= this.run(sessionId, scope, owner, choice.cmd, choice.args, form);
  }

  private async run(sessionId: string, scope: string, owner: string, cmd: string, args: string, formValue: Record<string, string>): Promise<WebControlResult> {
    const ctx = await this.context(scope, owner), elements: WebControlElement[] = [];
    const fields = new Map<string, Field>();
    const issue = (command: string, arg = '') => {
      const [name, ...rest] = command.split('.'), token = randomUUID();
      if (this.choices.size >= 2000) this.choices.delete(this.choices.keys().next().value!);
      this.choices.set(token, { sessionId, owner, cmd: name!, args: [...rest, arg].filter(Boolean).join(' '), fields, expires: Date.now() + 15 * 60_000 });
      return token;
    };
    const read = (v: any): WebControlElement[] => {
      if (!v || typeof v !== 'object') return [];
      if (v.tag === 'markdown' || v.tag === 'plain_text') return v.content ? [{ kind: 'text', text: v.content }] : [];
      if (v.tag === 'select_static' && typeof v.name === 'string') {
        const options = (v.options ?? []).map((o: any) => ({ value: String(o.value), text: String(o.text?.content ?? o.value) }));
        fields.set(v.name, { values: options.map((o: { value: string }) => o.value) });
        return [{ kind: 'select', name: v.name, value: String(v.initial_option ?? ''), options }];
      }
      if (v.tag === 'input' && typeof v.name === 'string') {
        fields.set(v.name, {}); return [{ kind: 'input', name: v.name, value: String(v.default_value ?? ''),
          ...(v.label?.content ? { label: String(v.label.content) } : {}) }];
      }
      if (v.tag === 'button' || v.tag === 'interactive_container') {
        const payload = v.behaviors?.find((b: any) => b.type === 'callback')?.value ?? v.value;
        return typeof payload?.cmd === 'string' && callbackCommand.test(payload.cmd) ? [{ kind: 'button',
          text: String(v.text?.content ?? v.hover_tips?.content ?? '继续'), action: issue(payload.cmd, payload.arg ?? ''), primary: v.type === 'primary', danger: v.type === 'danger' }] : [];
      }
      const children = (v.elements ?? v.columns ?? []).flatMap(read);
      return v.tag === 'collapsible_panel' ? [{ kind: 'section', text: String(v.header?.title?.content ?? '更多设置'), elements: children }] : children;
    };
    const present = (card: any) => {
      if (card.header?.title?.content) elements.push({ kind: 'text', text: card.header.title.content });
      elements.push(...read(card.body ?? card));
    };
    const channel = new Proxy(ctx.channel, { get(target, key) {
      if (key === 'managedCardTransport') return async (_channel: LarkChannel, recipient: string, card: object, opts: Parameters<typeof sendManagedCard>[3]) => {
        if (recipient !== scope) return sendManagedCard(target, recipient, card, opts);
        if (opts?.isActive && !opts.isActive()) throw new WebError(409, '会话绑定已变化');
        present(card); return { cardId: 'web-card-' + randomUUID(), messageId: 'web-control-' + randomUUID() };
      };
      if (key === 'send') return async (recipient: string, content: any, opts?: any) => {
        if (recipient !== scope) return target.send(recipient, content, opts);
        if (content.card) present(content.card);
        if (content.markdown ?? content.text) elements.push({ kind: 'text', text: String(content.markdown ?? content.text) });
        return { messageId: 'web-control-' + randomUUID() };
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } }) as LarkChannel;
    if (!await runCommandHandler(cmd, args, { ...ctx, channel, groupChannel: ctx.channel, fromWeb: true, fromCardAction: false, formValue })) throw new WebError(400, '不支持的会话操作');
    if (!elements.length) elements.push({ kind: 'text', text: cmd === 'stop' ? '已检查并请求停止当前任务。' : '操作已完成。' });
    return { elements };
  }
}
