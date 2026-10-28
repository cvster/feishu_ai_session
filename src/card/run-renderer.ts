import { queueFooter } from './queue-footer';
import type { QueuedMessage } from '../bot/message-queue';
import type { FooterStatus, RunState } from './run-state';
import { renderColoredRunStatus } from './run-status-render';
import type { RunControlIcons } from './run-control-icons';
import type { RunButtonAction } from './run-button-images';
import { runProgress } from './run-progress';

export interface RunCardRenderOptions extends RunControlIcons {
  queuedMessages?: QueuedMessage[];
  /** A newer reply is already visible in the same shared group. */
  auxiliaryPreviousReply?: boolean;
  signCallback?: (action: string) => string;
  /** External Codex turns have no bridge-owned RunHandle to interrupt. */
  showStopButton?: boolean;
  /** Keep expired native mirror buttons from falling through to unrelated runs. */
  nativeMirror?: boolean;
}

export function renderCard(state: RunState, options: RunCardRenderOptions = {}): object {
  // Reasoning and tool details are never included in the serialized card.
  const textBlocks = state.blocks.filter(block => block.kind === 'text');
  const elements: object[] = options.auxiliary ? auxiliaryContent(textBlocks, options.auxiliaryPreviousReply === true) :
    textBlocks.filter(block => block.content.trim()).map(block => markdown(block.content));
  const progress = runProgress(state);
  elements.push(...progress.map(noteMd));

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_⏱ ${mins} 分钟无响应,已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${state.errorMsg}`));
  } else if (state.terminal === 'done' && !textBlocks.some(block => block.content.trim())) {
    elements.push(noteMd('_（未返回内容）_'));
  }

  const footerStart = elements.length;
  const status = renderColoredRunStatus(state);
  if (status) elements.push(noteMd(status));
  else if (state.terminal === 'running' && state.footer && !(state.footer === 'thinking' || state.footer === 'tool_running' && state.blocks.some(block => block.kind === 'tool'))) elements.push(footerStatus(state.footer));
  elements.push(controlButtonRow(options.auxiliary && state.terminal !== 'running' ? { ...options, showStopButton: false } : options, state.terminal === 'done'));
  if (!options.auxiliary) elements.push(...queueFooter(options.queuedMessages ?? []));
  if (options.auxiliary && state.terminal !== 'running') {
    const details = elements.find(element => (element as { tag?: string }).tag === 'collapsible_panel') as
      { elements: object[] } | undefined;
    if (details) details.elements.push(...elements.splice(footerStart));
  }

  return {
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: summaryText(state) },
    },
    body: { elements },
  };
}

/** The latest reply is always complete; only older replies over 1000 characters fold. */
function auxiliaryContent(blocks: Array<{ kind: 'text'; content: string }>, previousReply: boolean): object[] {
  const visible = blocks.filter(block => block.content.trim());
  const content = visible.map(block => block.content.trim()).join('\n\n');
  if (!previousReply || Array.from(content).length <= 1000) return visible.map(block => markdown(block.content));
  const answer = visible.at(-1)!.content.trim();
  return [
    { tag: 'div', text: { tag: 'plain_text', content: auxiliaryPreview(answer), lines: 5 } },
    auxiliaryDetails(visible.map(block => markdown(block.content))),
  ];
}

function auxiliaryDetails(elements: object[]): object {
  return {
    tag: 'collapsible_panel', expanded: false,
    header: panelHeader('查看详细说明（点击展开 / 收起）'),
    border: { color: 'grey', corner_radius: '5px' },
    vertical_spacing: '8px', padding: '8px', elements,
  };
}

function auxiliaryPreview(content: string): string {
  // Keep fenced code and incomplete Markdown out of the compact plain-text preview.
  const opening = content.split(/```|~~~/, 1)[0]!.split(/\n\s*\n/, 1)[0]!.split('\n').slice(0, 5).join('\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^(?:#{1,6}\s+|>\s?)/gm, '').replace(/\*\*|__|~~|`/g, '').trim();
  if (!opening) return '回复包含代码或详细内容，请展开查看。';
  const chars = Array.from(opening);
  return chars.length > 200 ? `${chars.slice(0, 199).join('').trimEnd()}…` : opening;
}

function panelHeader(titleMd: string): object {
  return {
    title: { tag: 'markdown', content: titleMd },
    vertical_align: 'center',
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  };
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function noteMd(content: string): object {
  return { tag: 'markdown', content, text_size: 'notation' };
}

interface RunControl {
  icon: object;
  color: string;
  hover_tips: { tag: 'plain_text'; content: string };
  behaviors: [{ type: 'callback'; value: Record<string, unknown> }];
  disabled?: boolean;
}

function stopButton(options: RunCardRenderOptions, completed: boolean): RunControl {
  const value: Record<string, unknown> = { cmd: 'stop', ...(options.nativeMirror ? { nativeMirror: true } : {}), ...(options.auxiliary ? { auxiliaryRunId: options.auxiliaryRunId ?? '' } : {}) };
  if (options.signCallback && !completed) {
    value.__bridge_cb = true;
    value.bridge_token = options.signCallback('stop');
  }
  return {
    icon: { tag: 'standard_icon', token: 'stop_outlined', color: completed ? 'grey' : 'red' },
    color: completed ? 'grey' : 'red',
    hover_tips: { tag: 'plain_text', content: completed ? '本次任务已完成' : options.auxiliary && options.showStopButton === false ? '本次任务已结束' : '停止当前回复' },
    behaviors: [{ type: 'callback', value }],
    ...(completed ? { disabled: true } : {}),
  };
}

function controlButtonRow(options: RunCardRenderOptions, completed: boolean): object {
  const buttons = [
    ...(completed || options.auxiliary || options.showStopButton !== false ? [stopButton(options, completed)] : []),
    ...(!options.auxiliary ? [iconButton('setting_outlined', 'config', '模型与推理设置')] : []),
    iconButton('refresh_outlined', 'refresh', '刷新会话状态', 'green'),
    ...(!options.auxiliary ? [...(options.supportsFork === false ? [] : [forkButton(options)]), archiveButton()] : []),
  ];
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: 'small',
    columns: buttons.map((button) => {
      if (options.auxiliaryScope) button.behaviors[0].value.auxiliaryScope = options.auxiliaryScope;
      const action = button.behaviors[0].value.cmd as RunButtonAction;
      // Both stop states use the same framed image layout, differing only in color.
      const imageKey = action === 'stop' && completed ? options.completedStopImageKey : options.buttonImageKeys?.[action];
      return {
      tag: 'column',
      // Icon-only controls have no labels to truncate. Equal weighted columns
      // distribute their centers across the entire card on desktop and mobile.
      width: 'weighted',
      weight: 1,
      horizontal_align: 'center',
      elements: [{
        tag: 'interactive_container',
        width: '32px', height: '32px',
        // Uploaded images include both the frame and centered glyph. Do not
        // add a second client-drawn border around them.
        has_border: !imageKey, border_color: button.color,
        corner_radius: '3px', padding: '0px',
        horizontal_align: 'center', vertical_align: 'center',
        hover_tips: button.hover_tips,
        behaviors: button.behaviors,
        ...(button.disabled ? { disabled: true, disabled_tips: button.hover_tips } : {}),
        elements: imageKey ? [{
          tag: 'img', img_key: imageKey,
          size: '32px 32px', scale_type: 'crop_center',
          margin: '0px', transparent: true, preview: false,
          alt: button.hover_tips,
        }] : [{
          // Markdown prefix icons remain left-anchored even with centered
          // text. Center a fixed glyph-width column, not an empty text line.
          tag: 'column_set', flex_mode: 'none', margin: '0px',
          horizontal_align: 'center', horizontal_spacing: '0px',
          columns: [{
            tag: 'column', width: '16px', padding: '0px', margin: '0px',
            elements: [{
              tag: 'markdown', content: '', text_size: 'notation',
              margin: '0px', text_align: 'left', icon: button.icon,
            }],
          }],
        }],
      }],
      };
    }),
  };
}

function iconButton(token: string, cmd: string, label: string, color = 'grey'): RunControl {
  return {
    icon: { tag: 'standard_icon', token, color },
    color,
    hover_tips: { tag: 'plain_text', content: label },
    behaviors: [{ type: 'callback', value: { cmd } }],
  };
}

function forkButton(options: RunCardRenderOptions): RunControl {
  const button = iconButton('mindmap-down_outlined', 'fork', '复制会话并创建新群', 'blue');
  return options.forkIconKey
    ? { ...button, icon: { tag: 'custom_icon', img_key: options.forkIconKey } }
    : button;
}

function archiveButton(): RunControl {
  return {
    icon: { tag: 'standard_icon', token: 'archive_outlined', color: 'red' },
    color: 'red',
    hover_tips: { tag: 'plain_text', content: '归档会话（打开终止任务确认）' },
    behaviors: [{ type: 'callback', value: { cmd: 'finish' } }],
  };
}

function footerStatus(status: Exclude<FooterStatus, null>): object {
  const text =
    status === 'waiting_input'
      ? '⏳ 等待选择'
      : status === 'thinking'
      ? '🧠 正在思考'
      : status === 'tool_running'
        ? '🧰 正在调用工具'
        : '✍️ 正在输出';
  return noteMd(`<font color='blue'>${text}</font>`);
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'waiting_input') return '等待选择';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '思考中';
}
