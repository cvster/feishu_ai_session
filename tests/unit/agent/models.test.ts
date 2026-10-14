import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MODEL,
  isDefaultModel,
  modelLabel,
  normalizeModelSelection,
  resolveModelArg,
  supportedModels,
  normalizeReasoningEffort,
  supportedReasoningEfforts,
  unavailableModelNotice,
} from '../../../src/agent/models.js';

describe('agent model catalog', () => {
  it('offers a distinct catalog per agent kind, each led by the default sentinel', () => {
    const claude = supportedModels('claude');
    const codex = supportedModels('codex');
    expect(claude[0]?.value).toBe(DEFAULT_MODEL);
    expect(codex[0]?.value).toBe(DEFAULT_MODEL);
    expect(claude.map((m) => m.value)).toContain('claude-opus-4-8');
    expect(codex.map((m) => m.value)).toContain('gpt-6-astra');
    expect(codex.map((m) => m.value)).toContain('gpt-6.1-sol');
    expect(resolveModelArg('codex', 'gpt-6.1-sol')).toBe('gpt-6.1-sol');
    expect(codex.map((m) => m.value)).toContain('gpt-5.6-sol');
    expect(claude.map((m) => m.value)).not.toContain('gpt-5.6-sol');
  });

  it('treats unset and the default sentinel as "use agent default"', () => {
    expect(isDefaultModel(undefined)).toBe(true);
    expect(isDefaultModel('')).toBe(true);
    expect(isDefaultModel(DEFAULT_MODEL)).toBe(true);
    expect(isDefaultModel('claude-opus-4-8')).toBe(false);
  });

  it('coerces unknown / cross-agent selections back to the default option', () => {
    expect(normalizeModelSelection('claude', 'claude-opus-4-8')).toBe('claude-opus-4-8');
    // A Codex model left over after switching a profile to Claude is invalid.
    expect(normalizeModelSelection('claude', 'gpt-5.6-sol')).toBe(DEFAULT_MODEL);
    expect(normalizeModelSelection('claude', undefined)).toBe(DEFAULT_MODEL);
  });

  it('resolves the --model argument, omitting it for the default', () => {
    expect(resolveModelArg('claude', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(resolveModelArg('claude', DEFAULT_MODEL)).toBeUndefined();
    expect(resolveModelArg('claude', undefined)).toBeUndefined();
    // Cross-agent value → no flag rather than a broken model.
    expect(resolveModelArg('codex', 'claude-opus-4-8')).toBeUndefined();
  });

  it('labels a stored value using the picker option text', () => {
    expect(modelLabel('codex', 'gpt-6.1-sol')).toBe('GPT-6.1-Sol');
    expect(modelLabel('claude', 'claude-opus-4-8')).toBe('Opus 4.8');
    expect(modelLabel('claude', DEFAULT_MODEL)).toContain('跟随默认');
  });

  it.each([
    ['claude-opus-5-5', 'Opus 5.5（最新）'],
  ])('offers %s and forwards its concrete model ID only to Claude', (model, label) => {
    expect(supportedModels('claude')).toContainEqual({ value: model, label });
    expect(normalizeModelSelection('claude', model)).toBe(model);
    expect(resolveModelArg('claude', model)).toBe(model);
    expect(resolveModelArg('codex', model)).toBeUndefined();
  });

  it('retires the unavailable Fable option and recovers old bindings via the CLI default', () => {
    expect(supportedModels('claude').some(model => model.value === 'claude-fable-5-1')).toBe(false);
    expect(normalizeModelSelection('claude', 'claude-fable-5-1')).toBe(DEFAULT_MODEL);
    expect(resolveModelArg('claude', 'claude-fable-5-1')).toBeUndefined();
    expect(unavailableModelNotice('claude', 'claude-fable-5-1')).toContain('不可用');
    expect(unavailableModelNotice('claude', 'claude-opus-5-5')).toBeUndefined();
  });

  it('keeps CC effort within the native CLI levels while retaining Codex ultra', () => {
    expect(supportedReasoningEfforts('claude')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(normalizeReasoningEffort('claude', 'ultra')).toBe('high');
    expect(normalizeReasoningEffort('claude', 'max')).toBe('max');
    expect(normalizeReasoningEffort('codex', 'ultra')).toBe('ultra');
  });
});
