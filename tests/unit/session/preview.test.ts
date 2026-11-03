import { describe, expect, it } from 'vitest';
import { normalizeSessionPreview } from '../../../src/session/preview';

describe('session preview', () => {
  it('passes plain text through and truncates by code point', () => {
    expect(normalizeSessionPreview('  整理   一下  ')).toBe('整理 一下');
    expect(normalizeSessionPreview('😀😀😀', 2)).toBe('😀😀');
  });

  it('extracts the user text from an agent prompt section', () => {
    const prompt = [
      '<bridge_context>\n{"chatId":"oc_group"}\n</bridge_context>',
      '',
      '<user_input>\n{"text":"看这张图"}\n</user_input>',
    ].join('\n');
    expect(normalizeSessionPreview(prompt)).toBe('看这张图');
  });

  it('drops the context block that direct prompts put before the user words', () => {
    const prompt = [
      '<lark_context>\n{"attachments":[{"path":"/tmp/图片.png","kind":"image"}]}\n</lark_context>',
      '',
      '看图并解释',
    ].join('\n');
    expect(normalizeSessionPreview(prompt)).toBe('看图并解释');
  });

  it('drops every context section when the user text is not wrapped in one', () => {
    const prompt = [
      '<bridge_context>\n{"chatId":"oc_group"}\n</bridge_context>',
      '',
      '<quoted_messages>\n[{"content":"上文"}]\n</quoted_messages>',
      '',
      '<lark_context>\n{"topic":[{"content":"话题"}]}\n</lark_context>',
      '',
      '继续处理',
    ].join('\n');
    expect(normalizeSessionPreview(prompt)).toBe('继续处理');
  });

  it('falls back to an empty preview when nothing but context was recorded', () => {
    expect(normalizeSessionPreview('<lark_context>\n{"chatId":"oc_group"}\n</lark_context>')).toBe('');
    expect(normalizeSessionPreview('<lark_context>\r\n{"chatId":"oc_group"}\r\n</lark_context>')).toBe('');
    expect(normalizeSessionPreview('<lark_context>\n{"chatId":"oc_gro')).toBe('');
  });

  it('handles CRLF prompts written on Windows', () => {
    const prompt = '<lark_context>\r\n{"chatId":"oc_group"}\r\n</lark_context>\r\n\r\n看看日志';
    expect(normalizeSessionPreview(prompt)).toBe('看看日志');
    const sections = '<bridge_context>\r\n{}\r\n</bridge_context>\r\n\r\n<user_input>\r\n{"text":"继续"}\r\n</user_input>';
    expect(normalizeSessionPreview(sections)).toBe('继续');
  });

  it('keeps user prose that merely mentions a context tag', () => {
    expect(normalizeSessionPreview('请解释 </lark_context> 的作用')).toBe('请解释 </lark_context> 的作用');
    expect(normalizeSessionPreview('为什么 <lark_context> 要放在最前面\n第二行')).toBe('为什么 <lark_context> 要放在最前面 第二行');
  });
});
