import { expect, it } from 'vitest';
import { isZcodeNativeInput, projectZcodeConversation } from '../../../src/agent/zcode/conversation';

const session = { sessionId: 'sess_native', sessionKind: 'interactive', title: 'AA-ZCode', workspace: { workspacePath: '/project' } };
const user = (id = 'u1', created = 100) => ({ info: { messageId: id, sessionId: 'sess_native', role: 'user', time: { created },
  semantics: { origin: 'real_user', kind: 'user_prompt', uiVisibility: 'visible' },
  metadata: { inputIntent: { inputOrigin: 'desktop', sourceCommandId: `command-${id}` } } }, parts: [{ type: 'text', text: 'hi222' }] });
const answer = (id = 'a1', parent = 'u1', finish: string | undefined = 'stop') => ({ info: { messageId: id, sessionId: 'sess_native', role: 'assistant', parentMessageId: parent,
  time: { created: 110, ...(finish ? { completed: 120 } : {}) }, ...(finish ? { finish } : {}), model: { providerId: 'tars', modelId: 'deepseek', options: { reasoningLevel: 'max' } } },
  parts: [{ type: 'text', text: 'hello' }] });
const project = (messages: any[]) => projectZcodeConversation({ session, messages });
it('projects desktop text, multi-step answers and tool results into one turn', () => {
  const step = answer('a1', 'u1', 'tool-calls');
  step.parts.push({ type: 'tool', callId: 'call', tool: 'Read', state: { status: 'completed', input: { path: 'file' }, output: 'result' } } as any);
  const snapshot = project([user(), step, answer('a2', 'a1')]);
  expect(snapshot).toMatchObject({ id: 'sess_native', cwd: '/project', name: 'AA-ZCode', archived: false });
  expect(snapshot.turns).toHaveLength(1);
  expect(snapshot.turns[0]).toMatchObject({ id: 'u1', input: 'hi222', bridge: false, createdAtMs: 100,
    state: { terminal: 'done', execution: { model: 'tars/deepseek', reasoningEffort: 'max' } } });
  expect(snapshot.turns[0]!.state.blocks).toContainEqual({ kind: 'tool', tool: { id: 'call', name: 'Read', input: { path: 'file' }, output: 'result', status: 'done' } });
});
it('ignores synthetic/model-only messages and parts, including answers to hidden inputs', () => {
  const hidden = user('hidden'); hidden.info.semantics.uiVisibility = 'hidden';
  const u = user(); u.parts.push({ type: 'text', text: 'secret', synthetic: true } as any);
  const a = answer(); a.parts.push({ type: 'text', text: 'secret', metadata: { visibility: 'model-only' } } as any);
  const result = project([u, hidden, answer('hidden-answer', 'hidden'), a]);
  expect(result.turns).toHaveLength(1); expect(JSON.stringify(result)).not.toContain('secret');
  expect(JSON.stringify(result)).not.toContain('hidden-answer');
});
it('requires native desktop or official remote admission and excludes bridge commands', () => {
  const info: any = user().info;
  expect(isZcodeNativeInput(info)).toBe(true);
  info.metadata.inputIntent.sourceCommandId = 'bridge-worker-run'; expect(isZcodeNativeInput(info)).toBe(false);
  info.metadata.inputIntent.sourceCommandId = 'native'; info.metadata.inputIntent.inputOrigin = 'mobile'; expect(isZcodeNativeInput(info)).toBe(true);
  info.metadata.inputIntent.sourceCommandId = 'bridge-worker-run'; expect(isZcodeNativeInput(info)).toBe(false);
  delete info.metadata; expect(isZcodeNativeInput(info)).toBe(false);
  const u = user(); u.parts[0]!.text = JSON.stringify(user().info.metadata);
  delete (u.info as any).metadata; expect(project([u]).turns[0]?.bridge).toBe(true);
});
it('projects official remote input as native while rejecting hidden or mismatched command records', () => {
  const u = user(); u.info.metadata.inputIntent.inputOrigin = 'mobile';
  expect(project([u, answer()]).turns[0]).toMatchObject({ bridge: false, state: { terminal: 'done' } });
  const info: any = u.info;
  info.metadata.conversationInputIntent = { ...info.metadata.inputIntent, sourceCommandId: 'another-command' };
  expect(isZcodeNativeInput(info)).toBe(false);
  delete info.metadata.conversationInputIntent;
  info.synthetic = true; expect(isZcodeNativeInput(info)).toBe(false);
});
it('fails closed when two native intent records disagree', () => {
  const info: any = user().info;
  info.metadata.conversationInputIntent = { ...info.metadata.inputIntent, inputOrigin: 'mobile' };
  expect(isZcodeNativeInput(info)).toBe(false);
});
it('keeps incomplete/tool-step native output running despite the detached CLI idle status', () => {
  const incomplete = answer(); delete (incomplete.info as any).finish; delete (incomplete.info.time as any).completed;
  expect(project([user(), incomplete]).turns[0]?.state.terminal).toBe('running');
  expect(project([user(), answer('a1', 'u1', 'tool-calls')]).turns[0]?.state.terminal).toBe('running');
  const a = answer(); (a.info as any).error = { name: 'AbortError', data: { message: 'secret provider detail' } };
  const result = project([user(), a]);
  expect(result.turns[0]?.state.terminal).toBe('interrupted'); expect(JSON.stringify(result)).not.toContain('secret provider');
});
it('does not guess assistant ownership on broken or cyclic parent references', () => {
  expect(project([user(), answer('a1', 'missing')]).turns[0]?.state.blocks).toEqual([]);
  expect(project([user(), answer('a1', 'a2'), answer('a2', 'a1')]).turns[0]?.state.blocks).toEqual([]);
});
it('rejects mixed-session messages and unsupported snapshot formats', () => {
  const u = user(); u.info.sessionId = 'sess_other';
  expect(() => project([u])).toThrow('身份不匹配');
  expect(() => projectZcodeConversation({ session: { ...session, sessionKind: 'subagent' }, messages: [] })).toThrow('格式不兼容');
});
