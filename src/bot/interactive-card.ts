export const INTERACTIVE_CARD_PLACEHOLDER = '[interactive card]';
const MAX_CARD_CHARS = 1_000_000;
const MAX_TEXT_CHARS = 60_000;
const TEXT_TAGS = new Set(['plain_text', 'lark_md', 'markdown']);
const CONTROL_TAGS = new Set(['action', 'button', 'input', 'select_static', 'select_person',
  'multi_select_static', 'multi_select_person', 'date_picker', 'picker_time', 'picker_datetime', 'overflow', 'checker']);
const BRIDGE_SUMMARIES = new Set(['已完成', '已中断', '已超时', '出错', '等待选择', '正在调用工具', '正在输出', '思考中']);
const BRIDGE_CONTROLS = new Set(['停止当前回复', '本次任务已完成', '本次任务已结束', '刷新会话状态',
  '模型与推理设置', '复制会话并创建新群', '归档会话（打开终止任务确认）']);
type CardNode = Record<string, unknown>;

/** Decode structural JSON strings, never JSON-looking text inside a Markdown node. */
function decode(value: unknown): unknown {
  for (let n = 0; n < 4 && typeof value === 'string'; n++) {
    if (value.length > MAX_CARD_CHARS) return undefined;
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  return value;
}
function object(value: unknown): CardNode | undefined {
  const decoded = decode(value);
  return decoded && typeof decoded === 'object' && !Array.isArray(decoded) ? decoded as CardNode : undefined;
}
function textValue(value: unknown): string {
  if (typeof value === 'string') return value;
  const node = object(value);
  return typeof node?.content === 'string' ? node.content : '';
}

function isRuntimeText(text: string): boolean {
  const plain = text.trim().replace(/^<font\b[^>]*>([\s\S]*)<\/font>$/i, '$1').trim();
  return /^(?:运行中 · .+ · 已运行.+|(?:✅ 已完成|⏹ 已中断|⏱ 已超时|⚠️ 运行失败) · 用时 .+) · 最近更新 \d{2}:\d{2}:\d{2}(?: · [^\n]*)?$/.test(plain) ||
    /^(?:🧠 思考中|🧠 思考完成|🧠 正在思考|🧰 正在调用工具|✍️ 正在输出|⏳ 等待选择|🧰 \d+ 个工具调用（(?:进行中|已完成)）)$/.test(plain);
}

function readableFallback(flattened: string): string {
  const text = flattened.trim();
  // Never fall back to a serialized card, including an old expanded-card wrapper.
  const candidate = text.replace(/^<interactive_card>\s*([\s\S]*?)\s*<\/interactive_card>$/, '$1');
  const parsed = decode(candidate);
  if (!text || parsed && typeof parsed === 'object' || /^\{\s*"(?:schema|body|elements|user_dsl)"\s*:/.test(candidate)) return INTERACTIVE_CARD_PLACEHOLDER;
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) + '\n（卡片正文过长，已截断）' : text;
}

/** Keep readable card content, not CardKit DSL, callbacks or presentation metadata. */
export function expandInteractiveCard(flattenedContent: string, rawJsonContent: string | undefined): string {
  if (!rawJsonContent) return readableFallback(flattenedContent);
  let card = object(rawJsonContent);
  // Prefer the real v2 card to the webhook's v1 "please upgrade" fallback.
  for (let n = 0; card?.user_dsl !== undefined && n < 4; n++) card = object(card.user_dsl);
  if (!card) return readableFallback(flattenedContent);
  const body = object(card.body);
  if (!body && !Array.isArray(decode(card.elements)) && !card.tag) return readableFallback(flattenedContent);
  const bridge = BRIDGE_SUMMARIES.has(textValue(object(card.config)?.summary));
  let count = 0, characters = 0, truncated = false;
  const parts: string[] = [];
  const add = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const available = MAX_TEXT_CHARS - characters;
    if (available <= 0) { truncated = true; return; }
    parts.push(trimmed.slice(0, available)); characters += Math.min(trimmed.length, available);
    if (trimmed.length > available) truncated = true;
  };
  const walk = (value: unknown, depth = 0): void => {
    if (depth > 30 || ++count > 10_000 || characters >= MAX_TEXT_CHARS) { truncated = true; return; }
    value = decode(value);
    if (Array.isArray(value)) {
      // Folded auxiliary replies contain a short preview followed by the full answer.
      const full = bridge ? value.find(item => {
        const panel = object(item);
        return panel?.tag === 'collapsible_panel' && textValue(object(panel.header)?.title) === '查看详细说明（点击展开 / 收起）';
      }) : undefined;
      for (const child of full ? [full] : value) { walk(child, depth + 1); if (truncated) break; }
      return;
    }
    const node = object(value);
    if (!node || typeof node.tag === 'string' && CONTROL_TAGS.has(node.tag)) return;
    if (bridge && node.tag === 'interactive_container' &&
      BRIDGE_CONTROLS.has(textValue(node.hover_tips) || textValue(node.disabled_tips))) return;
    if (typeof node.tag === 'string' && TEXT_TAGS.has(node.tag)) {
      const content = typeof node.content === 'string' ? node.content : '';
      if (!bridge || !isRuntimeText(content)) add(content);
      return;
    }
    if (node.tag === 'img') {
      const alt = textValue(node.alt) || textValue(node.title) || '图片';
      add(typeof node.img_key === 'string' ? `![${alt}](${node.img_key})` : `[${alt}]`);
      return;
    }
    if (node.tag === 'file') {
      const name = textValue(node.title) || textValue(node.file_name) || '附件';
      add(typeof node.file_key === 'string' ? `[${name}](${node.file_key})` : `[${name}]`);
      return;
    }
    if (node.tag === 'a') {
      const label = textValue(node.text) || textValue(node.content);
      add(typeof node.href === 'string' && /^https?:\/\//i.test(node.href) ? `[${label || node.href}](${node.href})` : label);
      return;
    }
    if (node.tag === 'table' && Array.isArray(node.columns) && Array.isArray(node.rows)) {
      const columns = node.columns.map(object).filter((column): column is CardNode => typeof column?.name === 'string');
      const cell = (value: unknown) => (typeof value === 'number' || typeof value === 'boolean' ? String(value) : textValue(value)).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
      if (columns.length) {
        const lines = ['| ' + columns.map(column => cell(column.display_name ?? column.name)).join(' | ') + ' |',
          '| ' + columns.map(() => '---').join(' | ') + ' |'];
        let length = lines.join('\n').length;
        for (const row of node.rows) {
          const record = object(row);
          if (record) { const line = '| ' + columns.map(column => cell(record[column.name as string])).join(' | ') + ' |'; lines.push(line); length += line.length + 1; }
          if (length >= MAX_TEXT_CHARS - characters || lines.length >= 10_000) { truncated = true; break; }
        }
        add(lines.join('\n'));
      }
      return;
    }
    // Traverse only visible content slots; never callback values, config, alt tips or styles.
    if (node.tag !== 'collapsible_panel' && node.title !== undefined) walk(node.title, depth + 1);
    if (node.text !== undefined) { if (typeof node.text === 'string') add(node.text); else walk(node.text, depth + 1); }
    for (const key of ['elements', 'columns', 'fields']) if (node[key] !== undefined) walk(node[key], depth + 1);
  };
  if (card.header) walk(object(card.header)?.title);
  walk(body?.elements ?? card.elements ?? card);
  if (truncated) parts.push('（卡片正文过长，已截断）');
  const content = parts.join('\n\n');
  return content ? `<interactive_card>\n${content}\n</interactive_card>` : INTERACTIVE_CARD_PLACEHOLDER;
}
