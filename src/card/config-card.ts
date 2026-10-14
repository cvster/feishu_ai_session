import { modelLabel, normalizeReasoningEffort, supportedModels, supportedReasoningEfforts } from '../agent/models';
import type { KnownChat } from '../bot/lark-info';
import type { AgentKind, LarkCliIdentityPreset } from '../config/profile-schema';
import type { CotMessagesMode, MessageReplyMode } from '../config/schema';

export interface ConfigFormOpts {
  /** Profile's agent kind — decides which model catalog the picker shows. */
  agentKind: AgentKind;
  /** Current model selection (a value from {@link supportedModels}). */
  model: string;
  modelNotice?: string;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
  messageReply: MessageReplyMode;
  showToolCalls: boolean;
  cotMessages: CotMessagesMode;
  maxConcurrentRuns: number;
  /** 0 means "disabled". */
  runIdleTimeoutMinutes: number;
  requireMentionInGroup: boolean;
  larkCliIdentity: LarkCliIdentityPreset;
  allowedUsers: string[];
  allowedChats: string[];
  admins: string[];
  knownChats: KnownChat[];
}

function collapsedPanel(title: string, elements: object[]): object {
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'markdown', content: title },
      vertical_align: 'center',
      icon: {
        tag: 'standard_icon',
        token: 'down-small-ccm_outlined',
        size: '16px 16px',
      },
      icon_position: 'follow_text',
      icon_expanded_angle: -180,
    },
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements,
  };
}

/** Compact form: model and effort are primary; shared preferences stay folded. */
export function configFormCard(opts: ConfigFormOpts): object {
  const select = (name: string, value: string, options: Array<{ value: string; label: string }>) => ({
    tag: 'select_static', name, initial_option: value,
    options: options.map(option => ({ text: { tag: 'plain_text', content: option.label }, value: option.value })),
  });
  const label = (content: string) => ({ tag: 'markdown', content: `**${content}**` });
  const button = (name: string, text: string, cmd: string, submit = false) => ({
    tag: 'button', name, text: { tag: 'plain_text', content: text },
    ...(submit ? { type: 'primary', form_action_type: 'submit' } : {}),
    behaviors: [{ type: 'callback', value: { cmd } }],
  });
  return {
    schema: '2.0',
    config: { summary: { content: '偏好设置' } },
    body: {
      elements: [
        { tag: 'markdown', content: '⚙️ **偏好设置** · 保存后下次请求生效' },
        ...(opts.modelNotice ? [{ tag: 'markdown', content: `⚠️ ${opts.modelNotice}` }] : []),
        {
          tag: 'form', name: 'config_form', elements: [
            label('模型'),
            select('model', opts.model, supportedModels(opts.agentKind)),
            label('推理强度'),
            select('reasoning_effort', normalizeReasoningEffort(opts.agentKind, opts.reasoningEffort),
              supportedReasoningEfforts(opts.agentKind).map(value => ({ value, label: value }))),
            collapsedPanel('更多设置', [
              label('回复方式'),
              select('message_reply', opts.messageReply, [
                { value: 'card', label: '交互卡片' },
                { value: 'text', label: '纯文本' },
                { value: 'markdown', label: '流式消息' },
              ]),
              label('工具调用'),
              select('show_tool_calls', opts.showToolCalls ? 'show' : 'hide', [
                { value: 'show', label: '显示' }, { value: 'hide', label: '隐藏' },
              ]),
              label('过程消息'),
              select('cot_messages', opts.cotMessages, [
                { value: 'off', label: '关闭' }, { value: 'brief', label: '简略' }, { value: 'detailed', label: '详细' },
              ]),
              label('并发上限（1–50）'),
              { tag: 'input', name: 'max_concurrent_runs', default_value: String(opts.maxConcurrentRuns),
                placeholder: { tag: 'plain_text', content: '10' }, input_type: 'text' },
              { tag: 'markdown', content: `**访问控制** · 私聊 ${opts.allowedUsers.length} · 群 ${opts.allowedChats.length} · 管理员 ${opts.admins.length}\n通过 \`/invite\`、\`/remove\` 管理。` },
            ]),
            {
              tag: 'column_set', flex_mode: 'flow', horizontal_spacing: 'small',
              columns: [
                button('submit_btn', '保存', 'config.submit', true),
                button('cancel_btn', '取消', 'config.cancel'),
              ].map(action => ({ tag: 'column', width: 'auto', elements: [action] })),
            },
          ],
        },
      ],
    },
  };
}

export function configSavedCard(opts: ConfigFormOpts): object {
  return {
    schema: '2.0', config: { summary: { content: '偏好已保存' } },
    body: { elements: [
      { tag: 'markdown', content: `✅ **偏好已保存**\n${modelLabel(opts.agentKind, opts.model)} · ${opts.reasoningEffort}\n下次请求生效。` },
      { tag: 'button', text: { tag: 'plain_text', content: '返回控制台' },
        behaviors: [{ type: 'callback', value: { cmd: 'panel' } }] },
    ] },
  };
}

/**
 * Shown after `/config` saves "群里不需要 @ bot" but the app is missing the
 * `im:message.group_msg` scope. Guides the user through one-click incremental
 * authorization via the link from `requestScopeGrantLink`.
 */
export function groupMsgScopeGrantCard(url: string, expireMins: number): object {
  return {
    schema: '2.0',
    config: { summary: { content: '需要补授权' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '⚠️ **「群里不需要 @ bot」还差一个权限**\n\n' +
            '你已开启「不 @ bot 也回复」，但当前应用没有 **获取群组中所有消息**（`im:message.group_msg`）权限。' +
            '没有它，飞书不会把群里非 @ 的消息推给 bot，所以这个设置暂时不生效。\n\n' +
            `**点下面的链接补授权**（约 ${expireMins} 分钟内有效）：\n` +
            `[🔗 点此一键授权](${url})\n\n` +
            '_扫码/点击后会进入确认页，新权限已预填好，确认即可。授权成功后，群里新消息开始自动生效，无需重启。_\n' +
            `_若链接打不开，可复制：_\n\`${url}\`\n\n` +
            '_授权后若群里仍收不到非 @ 消息，发 `/reconnect` 重连一次即可。_',
        },
      ],
    },
  };
}

/** Replaces {@link groupMsgScopeGrantCard} in place once authorization completes. */
export function groupMsgScopeGrantedCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '授权成功' } },
    body: {
      elements: [
        {
          tag: 'markdown',
          content:
            '✅ **授权成功**\n\n' +
            '`im:message.group_msg` 权限已生效，群里非 @ bot 的消息从现在开始会触发回复。\n\n' +
            '_若仍未生效，发 `/reconnect` 重连一次。_',
        },
      ],
    },
  };
}

export function configCancelledCard(): object {
  return {
    schema: '2.0',
    config: { summary: { content: '已取消' } },
    body: {
      elements: [
        { tag: 'markdown', content: '已取消,未做任何修改。' },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '返回任务控制台' },
          behaviors: [{ type: 'callback', value: { cmd: 'panel' } }],
        },
      ],
    },
  };
}

export function configFailedCard(reason: string): object {
  return {
    schema: '2.0',
    config: { summary: { content: '保存失败' } },
    body: {
      elements: [
        { tag: 'markdown', content: `保存失败：${reason}` },
        {
          tag: 'button',
          text: { tag: 'plain_text', content: '返回任务控制台' },
          behaviors: [{ type: 'callback', value: { cmd: 'panel' } }],
        },
      ],
    },
  };
}
