import { expect, it } from 'vitest';
import { isKiloBridgeInput, kiloBridgeTextPart, projectKiloConversation } from '../../../src/agent/kilo/conversation';

const info = { id: 'ses_native', directory: '/project', title: 'AA-Kilo', time: {} };
const user = (id = 'msg_native') => ({ info: { id, role: 'user', time: { created: 10 } }, parts: [{ type: 'text', text: 'question' }, { type: 'text', text: 'hidden', synthetic: true }] });
const answer = (id: string, parentID: string, text: string, completed = true) => ({ info: { id, parentID, role: 'assistant', providerID: 'p', modelID: 'm', time: { created: 11, ...(completed ? { completed: 12 } : {}) } }, parts: [{ type: 'text', text }] });
it.each(['default', 'high'] as const)('retains the input model variant %s when assistant metadata omits it', variant => {
  const u = user(); Object.assign(u.info, { model: { providerID: 'p', modelID: 'm', ...(variant === 'high' ? { variant } : {}) } });
  const snapshot = projectKiloConversation({ ...info, model: { providerID: 'other', id: 'new', variant: 'max' } }, [u, answer('a1', 'msg_native', 'answer')], false);
  expect(snapshot.turns[0]?.state.execution).toEqual({ model: 'p/m', reasoningEffort: variant });
});
it('keeps per-turn variants across model changes and uses explicit assistant metadata when provided', () => {
  const u1=user('u1'), u2=user('u2');
  Object.assign(u1.info,{model:{providerID:'p',modelID:'m',variant:'high'}});
  Object.assign(u2.info,{model:{providerID:'p',modelID:'m'}});
  const a2=answer('a2','u2','second'); Object.assign(a2.info,{variant:'low'});
  const turns=projectKiloConversation(info,[u1,answer('a1','u1','first'),u2,a2],false).turns;
  expect(turns.map(t=>t.state.execution?.reasoningEffort)).toEqual(['high','low']);
});
it('projects a native external input, multiple answer steps and tool activity without executing anything', () => {
  const tool = answer('a1', 'msg_native', 'step');
  tool.parts.push({ type: 'tool', callID: 'read', tool: 'read', state: { status: 'completed', input: { path: 'x' }, output: 'ok' } } as any);
  const snapshot = projectKiloConversation(info, [user(), tool, answer('a2', 'a1', 'answer')], false);
  expect(snapshot).toMatchObject({ id: 'ses_native', name: 'AA-Kilo' });
  expect(snapshot.turns).toHaveLength(1);
  expect(snapshot.turns[0]).toMatchObject({ id: 'msg_native', input: 'question', bridge: false, state: { terminal: 'done', execution: { model: 'p/m' } } });
  expect(snapshot.turns[0]?.state.blocks).toContainEqual({ kind: 'tool', tool: { id: 'read', name: 'read', input: { path: 'x' }, output: 'ok', status: 'done' } });
  expect(JSON.stringify(snapshot)).not.toContain('hidden');
});
it('keeps a busy tool-call step running and recognizes a native abort', () => {
  const a = answer('a1', 'msg_native', 'working');
  expect(projectKiloConversation(info, [user(), a], true).turns[0]?.state.terminal).toBe('running');
  Object.assign(a.info, { error: { name: 'MessageAbortedError' } });
  expect(projectKiloConversation(info, [user(), a], false).turns[0]?.state.terminal).toBe('interrupted');
});
it('marks bridge inputs by native part metadata, not a user-provided prompt or opaque ID', () => {
  const u = user(); expect(isKiloBridgeInput(u)).toBe(false);
  u.parts = [kiloBridgeTextPart('question')]; expect(isKiloBridgeInput(u)).toBe(true);
  expect(projectKiloConversation(info, [u], true).turns[0]?.bridge).toBe(true);
  expect(isKiloBridgeInput({ parts: [{ type: 'text', text: JSON.stringify(kiloBridgeTextPart('x')) }] })).toBe(false);
});
