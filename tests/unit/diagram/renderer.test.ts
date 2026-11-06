import { expect, it } from 'vitest';
import { marked } from 'marked';
import { DiagramStore, mermaidSource } from '../../../src/diagram/renderer';

it('renders a self-contained Chinese flowchart to SVG and a real PNG, and reuses the result', async () => {
  const store = new DiagramStore(), source = 'flowchart TD\n A[开始] --> B{成功?}\n B -->|是| C[完成]';
  const id = store.register(source)!;
  const [a, b] = await Promise.all([store.render(id), store.render(id)]);
  expect(a).toBe(b);
  expect(a.svg).toContain('开始');
  expect(a.svg).not.toMatch(/@import|var\(|color-mix\(|<script|foreignObject|https:\/\/fonts/);
  expect(a.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(a.png.length).toBeGreaterThan(1000);
});

it.each([
  'flowchart TD\n A[开始<br/>检查] --> B[完成]',
  'sequenceDiagram\n participant A as 用户\n participant B as 服务\n A->>B: 请求\n B-->>A: 完成',
  'stateDiagram-v2\n [*] --> Ready\n Ready --> Done',
  'classDiagram\n class Animal {\n +String name\n +run()\n }\n Animal <|-- Dog',
  'erDiagram\n USER ||--o{ ORDER : creates\n USER {\n string name\n }',
  'xychart-beta\n x-axis [A, B, C]\n y-axis "Count" 0 --> 10\n bar [2, 5, 8]',
])('renders supported diagram family: %s', async source => {
  const store = new DiagramStore();
  const rendered = await store.render(store.register(source)!);
  expect(rendered.svg).toContain('<svg'); expect(rendered.png.length).toBeGreaterThan(1000);
});

it('keeps unsupported, oversized, interactive and external-resource syntax as source', () => {
  const store = new DiagramStore();
  for (const source of ['pie\n "A": 1', 'flowchart TD\n' + 'x'.repeat(16_000),
    'flowchart TD\nA[<script>alert(1)</script>]', 'flowchart TD\nclick A "https://example.com"',
    '%%{init: {}}%%\nflowchart TD\nA-->B', 'flowchart TD\nclassDef x fill:url(https://example.com/a)']) expect(store.register(source)).toBeUndefined();
});

it('bounds rendering time and keeps invalid diagrams failed without repeated work', async () => {
  const store = new DiagramStore(1), id = store.register('flowchart TD\nA-->B')!;
  await expect(store.render(id)).rejects.toThrow('timed out');
  await expect(store.render(id)).rejects.toThrow('unavailable');
  await expect(store.render('absent')).rejects.toThrow('not found');
});

it('recognizes complete Mermaid fences, including tildes, while retaining partial streams', () => {
  for (const fence of ['```', '~~~~']) {
    expect(mermaidSource(marked.lexer(fence + 'mermaid\nflowchart TD\nA-->B\n' + fence)[0]!)).toBe('flowchart TD\nA-->B');
    expect(mermaidSource(marked.lexer(fence + 'mermaid\nflowchart TD\nA-->B')[0]!)).toBeUndefined();
  }
});
