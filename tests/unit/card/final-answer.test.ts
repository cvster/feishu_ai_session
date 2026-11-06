import { expect, it } from 'vitest';
import { Lexer } from 'marked';
import { boldFinalAnswer } from '../../../src/card/final-answer';

it('bolds every conclusion line while retaining paragraph breaks and existing emphasis', () => {
  const text = '已部署 **#2755**，旧模块已备份。\n系统 ready。\n\n当前未接入遥操设备。';
  const expected = '**已部署 #2755，旧模块已备份。**\n**系统 ready。**\n\n**当前未接入遥操设备。**';
  expect(boldFinalAnswer(text)).toBe(expected);
  expect(boldFinalAnswer(expected)).toBe(expected);
  expect(Lexer.lexInline(expected.split('\n')[0]!)[0]?.type).toBe('strong');
});

it('retains code, links, headings, list markers, blank lines and table syntax', () => {
  const text = '## 结论\n- 已完成 [详情](https://example.com)\n1. 检查 `a**b`\n\n```cpp\nconst int value = 1;\n```\n    indented code\n| 状态 | 结果 |\n| --- | --- |\n| ready | 正常 |\n完成。';
  const result = boldFinalAnswer(text);
  expect(result).toContain('## **结论**\n- **已完成 [详情](https://example.com)**\n1. **检查 `a**b`**');
  expect(result).toContain('\n\n```cpp\nconst int value = 1;\n```\n    indented code\n| 状态 | 结果 |\n| --- | --- |\n| ready | 正常 |\n**完成。**');
});
