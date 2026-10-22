import { expect, it } from 'vitest';
import { WebMarkdown, type MarkdownNode } from '../../../src/web/markdown';

const flatten = (nodes: MarkdownNode[]): MarkdownNode[] => nodes.flatMap(n => [n, ...flatten(n.children ?? [])]);
const content = (nodes: MarkdownNode[]): string => nodes.map(n => (n.text ?? '') + content(n.children ?? [])).join('');

it('parses GFM tables, autolinks, inline formatting, lists and quotes into presentation nodes', () => {
  const result = new WebMarkdown().parse('# 状态\n\n| 工具 | 状态 |\n| :-- | --: |\n| **Worker** | `正常` |\n\n3. [文档](https://example.com/docs?q=1&amp;b=2)\n4. ~~旧项~~\n\n- [x] 已验证\n- [ ] 待办\n\n> 引用 *文字*\n\n网址 https://example.com/test\n下一行');
  const all = flatten(result);
  for (const tag of ['h1', 'table', 'thead', 'tbody', 'th', 'td', 'strong', 'code', 'ol', 'ul', 'li', 'del', 'blockquote', 'em', 'br']) expect(all.some(n => n.tag === tag)).toBe(true);
  expect(all.filter(n => n.tag === 'a').map(n => n.href)).toEqual(['https://example.com/docs?q=1&b=2', 'https://example.com/test']);
  expect(all.find(n => n.tag === 'ol')?.start).toBe(3);
  expect(all.filter(n => n.tag === 'th').map(n => n.align)).toEqual(['left', 'right']);
  expect(content(result)).toContain('☑ 已验证'); expect(content(result)).toContain('☐ 待办');
});

it('leaves HTML and unsafe links inert and does not introduce remotely fetched images', () => {
  const result = new WebMarkdown().parse('[bad](javascript:alert%281%29) [entity](javascript&#58;alert%281%29) [data](data:text/html,evil) [local](file:///tmp/x) [relative](//evil.example)\n\n<script>alert(1)</script>\n\n![图片](https://example.com/image.png) [邮件](mailto:test@example.com)');
  const all = flatten(result);
  expect(all.filter(n => n.tag === 'a').map(n => n.href)).toEqual(['https://example.com/image.png', 'mailto:test@example.com']);
  expect(content(result)).toContain('<script>alert(1)</script>');
  expect(content(result)).toContain('bad'); expect(all.some(n => (n.tag as string) === 'script' || (n.tag as string) === 'img')).toBe(false);
});

it('preserves code literally and displays incomplete streaming Markdown until it is complete', () => {
  const md = new WebMarkdown();
  expect(content(md.parse('A &amp; B'))).toBe('A & B');
  const partial = md.parse('```ts\nconst x = "<script> &amp;";');
  expect(partial[0]?.tag).toBe('pre');
  expect(content(partial)).toBe('const x = "<script> &amp;";');
  expect(content(md.parse('**正在'))).toBe('**正在');
  expect(flatten(md.parse('**正在完成**')).some(n => n.tag === 'strong')).toBe(true);
});
