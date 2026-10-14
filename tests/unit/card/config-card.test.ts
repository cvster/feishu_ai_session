import { describe, expect, it } from 'vitest';
import { configFormCard, configSavedCard, type ConfigFormOpts } from '../../../src/card/config-card';

const defaults: ConfigFormOpts = {
  agentKind: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high',
  messageReply: 'card', showToolCalls: false, cotMessages: 'brief', maxConcurrentRuns: 7,
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
    expect(effort.options!.some(option => option.value === 'ultra')).toBe(agentKind === 'codex');
    const more = form.elements!.find(element => element.tag === 'collapsible_panel')!;
    expect(more.expanded).toBe(false);
    expect(more.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'message_reply', initial_option: 'card' }),
      expect.objectContaining({ name: 'show_tool_calls', initial_option: 'hide' }),
      expect.objectContaining({ name: 'cot_messages', initial_option: 'brief' }),
      expect.objectContaining({ name: 'max_concurrent_runs', default_value: '7' }),
    ]));
    expect(form.elements!.length).toBeLessThanOrEqual(6);
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
