import { describe, expect, it } from 'vitest';
import { configFormCard, configSavedCard, type ConfigFormOpts } from '../../../src/card/config-card';

const defaults: ConfigFormOpts = {
  modelOptions: [{ value: 'default', label: '跟随工具默认', reasoningEfforts: [{ value: 'high', label: 'High' }, { value: 'native-new', label: 'New level' }] }, { value: 'claude-opus-5-5', label: 'Opus 5.5' }],
  agentKind: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high',
  messageReply: 'card', cotMessages: 'brief', maxConcurrentRuns: 7,
  runIdleTimeoutMinutes: 27, requireMentionInGroup: true, larkCliIdentity: 'bot-only',
  allowedUsers: [], allowedChats: [], admins: [], knownChats: [],
};

interface Element {
  tag: string; name?: string; expanded?: boolean; initial_option?: string; default_value?: string;
  options?: Array<{ value: string }>; elements?: Element[];
}

describe('compact settings card', () => {
  it.each(['claude', 'codex'] as const)('shows only model and effort above folded preferences for %s', agentKind => {
    const card = configFormCard({ ...defaults, agentKind, model: 'default' }) as { body: { elements: Element[] } };
    const form = card.body.elements.find(element => element.tag === 'form')!;
    expect(form.elements!.filter(element => element.tag === 'select_static').map(element => element.name))
      .toEqual(['model', 'reasoning_effort']);
    const effort = form.elements!.find(element => element.name === 'reasoning_effort')!;
    expect(effort.initial_option).toBe('high');
    expect(effort.options!.map(option => option.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    const more = form.elements!.find(element => element.tag === 'collapsible_panel')!;
    expect(more.expanded).toBe(false);
    expect(more.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'message_reply', initial_option: 'card' }),
      expect.objectContaining({ name: 'cot_messages', initial_option: 'brief' }),
      expect.objectContaining({ name: 'max_concurrent_runs', default_value: '7' }),
    ]));
    expect(JSON.stringify(card)).not.toContain('show_tool_calls');
    expect(form.elements!.length).toBeLessThanOrEqual(8);
  });

  it('confirms the selected CC effort in a short saved card', () => {
    const card = configSavedCard({ ...defaults, reasoningEffort: 'xhigh' }) as {
      body: { elements: Array<{ content?: string }> };
    };
    const summary = card.body.elements[0]!.content!;
    expect(summary).toContain('Opus 5.5');
    expect(summary).toContain('xhigh');
    expect(summary.split('\n').length).toBeLessThanOrEqual(4);
  });
});

it('pages large native catalogs while retaining the current selection as a valid Feishu option', () => {
  const options = [{ value: 'default', label: 'Default' }, ...Array.from({ length: 210 }, (_, i) => ({ value: `model-${i}`, label: `Model ${i}` }))];
  const card = configFormCard({ ...defaults, model: 'model-209', modelOptions: options, modelPage: 1 }) as { body: { elements: Element[] } };
  const picker = card.body.elements.find(e => e.tag === 'form')!.elements!.find(e => e.name === 'model')!;
  expect(picker.options!.length).toBeLessThanOrEqual(82);
  expect(picker.options!.some(o => o.value === picker.initial_option)).toBe(true);
  expect(picker.options!.some(o => o.value === 'model-100')).toBe(true);
  expect(JSON.stringify(card)).toContain('config.models.2');
});

it('offers the fixed unified list without a default or per-model read button', () => {
  const card = configFormCard({ ...defaults, model: 'claude-opus-5-5' }) as { body: { elements: Element[] } };
  const picker = card.body.elements.find(e => e.tag === 'form')!.elements!.find(e => e.name === 'reasoning_effort')!;
  expect(picker.initial_option).toBe('high');
  expect(picker.options!.map(option => option.value)).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  expect(JSON.stringify(card)).not.toContain('config.preview');
});
