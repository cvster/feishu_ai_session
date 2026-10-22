import { expect, it } from 'vitest';
import { projectClaudeConversation } from '../../../src/agent/claude/conversation';
import { projectDshConversation } from '../../../src/agent/dsh/conversation';

it('reads Claude visible turns and durable terminal status; SDK/unknown provenance never broadcasts', () => {
  const row = (uuid: string, type: string, content: any, extra = {}) => ({ sessionId: 'session', cwd: '/project', uuid, type, timestamp: '2026-10-22T00:00:00Z', userType: 'external', entrypoint: 'claude-vscode', message: { content }, ...extra });
  const snapshot = projectClaudeConversation('session', [
    row('native', 'user', 'native input'), row('thought', 'assistant', [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'tool_use', input: 'private tool args' }]),
    row('answer', 'assistant', [{ type: 'text', text: 'visible answer' }], { message: { content: [{ type: 'text', text: 'visible answer' }], stop_reason: 'end_turn' } }),
    row('tool-result', 'user', [{ type: 'tool_result', content: 'private output' }]),
    row('bridge', 'user', 'SDK input', { entrypoint: 'sdk-cli' }), row('sidechain', 'user', 'sidechain', { isSidechain: true }),
    row('unknown', 'user', 'unknown input', { entrypoint: undefined }),
  ], '/project', 'AA-Claude');
  expect(snapshot.turns).toHaveLength(3); expect(snapshot.turns[0]).toMatchObject({ id: 'native', bridge: false, state: { terminal: 'done', blocks: [{ kind: 'text', content: 'visible answer' }] } });
  expect(snapshot.turns[1]).toMatchObject({ bridge: true }); expect(snapshot.turns[2]).toMatchObject({ bridge: true, state: { terminal: 'running' } });
  expect(JSON.stringify(snapshot)).not.toContain('private');
});

it('reads Dsh native source metadata, deduplicates durable records and requires idle confirmation for the latest completion', () => {
  const event = (seq: number, type: string, data: any) => ({ type: 'event', event: { seq, type, data, time: seq + 10 } });
  const snapshot = { header: { id: 'session', cwd: '/project' }, records: [
    event(1, 'user/message', { id: 'native', content: [{ type: 'text', text: 'native input' }], source: { kind: 'user', rpcId: 'native-uuid' } }),
    event(2, 'assistant/message', { message: { content: [{ type: 'text', text: 'answer' }, { type: 'reasoning', text: 'secret' }] } }),
    event(2, 'assistant/message', { message: { content: [{ type: 'text', text: 'duplicate' }] } }),
    event(3, 'turn/end', { reason: { kind: 'completed' } }),
  ] };
  const row = { sessionId: 'session', cwd: '/project', running: true };
  expect(projectDshConversation(snapshot, row, false).turns[0]).toMatchObject({ bridge: false, state: { terminal: 'running' } });
  row.running = false; const result = projectDshConversation(snapshot, row, false); expect(result.turns[0]?.state.terminal).toBe('done'); expect(JSON.stringify(result)).not.toMatch(/secret|duplicate/);
  snapshot.records.push(event(4, 'user/message', { id: 'bridge', content: [{ type: 'text', text: 'bridge input' }], source: { kind: 'user', rpcId: 'bridge-job-id' } }),
    event(5, 'turn/end', { reason: { kind: 'error', error: { message: 'CREDENTIAL_SECRET' } } }));
  expect(projectDshConversation(snapshot, row, true)).toMatchObject({ archived: true, turns: [{ bridge: false }, { bridge: true, state: { terminal: 'error' } }] });
  expect(JSON.stringify(projectDshConversation(snapshot, row, false))).not.toContain('CREDENTIAL_SECRET');
});
