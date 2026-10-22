import { marked, type MarkedToken, type Token } from 'marked';
import { decodeHTML } from 'entities';
import type { RunState } from '../card/run-state';

/** Only these presentation nodes cross the Web API; never send arbitrary HTML. */
export interface MarkdownNode {
  tag: 'span' | 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'strong' | 'em' | 'del' |
    'code' | 'pre' | 'blockquote' | 'br' | 'hr' | 'ul' | 'ol' | 'li' | 'a' |
    'table' | 'thead' | 'tbody' | 'tr' | 'th' | 'td';
  text?: string;
  children?: MarkdownNode[];
  href?: string;
  title?: string;
  align?: 'left' | 'center' | 'right';
  start?: number;
}
export interface WebAnswerSection { nodes: MarkdownNode[] }
const node = (tag: MarkdownNode['tag'], children: MarkdownNode[]): MarkdownNode => ({ tag, children });
const text = (value: string): MarkdownNode => ({ tag: 'span', text: value });

function safeLink(raw: string): string | undefined {
  const href = decodeHTML(raw).trim();
  // Explicit protocols only: native file paths and raw HTML stay readable text.
  if (!/^(https?:\/\/|mailto:)/i.test(href) || /[\u0000-\u0020\u007f]/.test(href)) return;
  try { new URL(href); return href; } catch { return; }
}

function nodes(tokens: Token[], depth = 0): MarkdownNode[] {
  if (depth > 40) return tokens.map(t => text(t.raw));
  return tokens.flatMap((token): MarkdownNode[] => {
    const t = token as MarkedToken;
    const nested = (children: Token[]) => nodes(children, depth + 1);
    switch (t.type) {
      case 'space': case 'def': return [];
      case 'text': return t.tokens ? nested(t.tokens) : [text(t.escaped ? t.text : decodeHTML(t.text))];
      case 'escape': return [text(decodeHTML(t.text))];
      case 'html': return [text(t.text)];
      case 'paragraph': return [node('p', nested(t.tokens))];
      case 'heading': return [node(('h' + t.depth) as MarkdownNode['tag'], nested(t.tokens))];
      case 'strong': case 'em': case 'del': case 'blockquote': return [node(t.type, nested(t.tokens))];
      case 'code': return [node('pre', [{ tag: 'code', text: t.text }])];
      case 'codespan': return [{ tag: 'code', text: t.text }];
      case 'br': case 'hr': return [{ tag: t.type }];
      case 'checkbox': return [text(t.checked ? '☑ ' : '☐ ')];
      case 'link': case 'image': {
        const children = t.type === 'image' ? [text(decodeHTML(t.text) || '图片')] : nested(t.tokens);
        const href = safeLink(t.href);
        // Images are links: history rendering must not fetch arbitrary remote assets.
        return [href ? { tag: 'a', href, children, ...(t.title ? { title: decodeHTML(t.title) } : {}) } : node('span', children)];
      }
      case 'list': return [{ tag: t.ordered ? 'ol' : 'ul', ...(t.ordered && typeof t.start === 'number' ? { start: t.start } : {}),
        children: t.items.map(item => node('li', nested(item.tokens))) }];
      case 'table': {
        const cells = (row: typeof t.header, tag: 'th' | 'td') => row.map(cell => ({ tag, children: nested(cell.tokens), ...(cell.align ? { align: cell.align } : {}) }));
        return [node('table', [node('thead', [node('tr', cells(t.header, 'th'))]), node('tbody', t.rows.map(row => node('tr', cells(row, 'td'))))])];
      }
      default: return [text(t.raw)];
    }
  });
}

/** Bounded per-service cache avoids reparsing unchanged history on every SSE poll. */
export class WebMarkdown {
  private cache = new Map<string, MarkdownNode[]>();
  private characters = 0;
  parse(value: string): MarkdownNode[] {
    const cached = this.cache.get(value);
    if (cached) { this.cache.delete(value); this.cache.set(value, cached); return cached; }
    let result: MarkdownNode[];
    try { result = nodes(marked.lexer(value, { gfm: true, breaks: true })); }
    catch { result = [node('p', [text(value)])]; } // Keep partial streaming output readable.
    this.cache.set(value, result); this.characters += value.length;
    while (this.cache.size > 256 || this.characters > 1_000_000) {
      const oldest = this.cache.keys().next().value!;
      this.cache.delete(oldest); this.characters -= oldest.length;
    }
    return result;
  }
  sections(state: RunState): WebAnswerSection[] {
    return state.blocks.flatMap(block => block.kind === 'text' && block.content.trim() ? [{ nodes: this.parse(block.content) }] : []);
  }
}
