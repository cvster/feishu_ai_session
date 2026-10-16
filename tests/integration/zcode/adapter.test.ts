import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ZcodeAdapter } from '../../../src/agent/zcode/adapter';
import { ZcodeSessionProvider } from '../../../src/tools/zcode-sessions';
import { ZcodeClient } from '../../../src/agent/zcode/client';
import type { AgentEvent } from '../../../src/agent/types';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(kind = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'zcode-protocol-')); roots.push(root);
  const path = join(root, 'cli.cjs'), calls = join(root, 'calls.jsonl');
  await writeFile(path, `
    const fs = require('node:fs');
    if (process.argv.includes('--version')) { console.log('zcode 0.16.5'); process.exit(); }
    const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
    const snapshot = { session: { sessionId: 'sess_test', title: 'AA-zcode', sessionKind: 'interactive', workspace: { workspacePath: ${JSON.stringify(root)} }, createdAt: 1, updatedAt: 2, status: ${JSON.stringify(kind === 'busy' ? 'running' : 'idle')} }, messages: [{ role: 'user', parts: [{ type: 'text', text: 'latest context' }] }] };
    let inputId, seq = 0;
    const event = (type, payload, sessionId = 'sess_test') => send({ method: 'session/event', params: { type, payload, sessionId, seq: ++seq, turnId: 'turn-a' } });
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const r = JSON.parse(line); fs.appendFileSync(${JSON.stringify(calls)}, line+'\\n');
      if (r.method === 'session/list') return send({ id: r.id, result: { sessions: [snapshot.session] } });
      if (r.method === 'session/create' || r.method === 'session/resume') { send({ id: 'prefs', method: 'session/requestRuntimePreferences', params: {} }); return send({ id: r.id, result: snapshot }); }
      if (r.method === 'session/send') {
        inputId = r.params.inputId;
        send({ id: r.id, result: { accepted: true, sessionId: 'sess_test' } });
        if (${JSON.stringify(kind)} === 'disconnect') return process.exit();
        event('turn.started', { inputId });
        event('turn.completed', { resultType: 'success', response: 'foreign' }, 'sess_other');
        if (${JSON.stringify(kind)} === 'interaction') return send({ id: 'permission', method: 'interaction/requestPermission', params: {} });
        if (${JSON.stringify(kind)} === 'wait') return;
        event('model.streaming', { kind: 'text_delta', delta: 'ZCODE_' });
        event('tool.updated', { kind: 'scheduled', toolCallId: 'tool-1', toolName: 'Read', input: { path: 'test' } });
        event('tool.updated', { kind: 'result', toolCallId: 'tool-1', result: { content: 'ok', success: true } });
        event('model.streaming', { kind: 'text_delta', delta: 'READY' });
        event('turn.completed', { inputId, response: 'ZCODE_READY', resultType: 'success' });
        return;
      }
      if (r.method === 'session/stop') { send({ id: r.id, result: {} }); event('turn.completed', { inputId, resultType: 'cancelled' }); return; }
      if (r.id === 'permission' || r.id === 'prefs') return;
      send({ id: r.id, result: {} });
    });
  `);
  await writeFile(join(root, 'config.json'), JSON.stringify({ model: { main: 'test/model' }, provider: { test: { kind: 'openai', models: { model: {} } } } }));
  const options = { binary: process.execPath, args: [path], dataDir: root };
  const agent = new ZcodeAdapter(options);
  const read = async () => (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { root, agent, options, read };
}
it('creates, streams and completes the actual protocol without submitting to another session', async () => {
  const h = await fixture();
  const run = h.agent.run({ runId: 'one', cwd: h.root, prompt: 'hello', accessMode: 'read-only' });
  const events: AgentEvent[] = []; for await (const event of run.events) events.push(event);
  expect(events.filter(e => e.type === 'text').map(e => e.delta).join('')).toBe('ZCODE_READY');
  expect(events.at(-1)).toMatchObject({ type: 'done', sessionId: 'sess_test' });
  expect(events).toContainEqual({ type: 'tool_result', id: 'tool-1', output: 'ok', isError: false });
  expect(await run.waitForExit(3000)).toBe(true);
  const calls = await h.read();
  expect(calls[0]).toMatchObject({ method: 'session/create', params: { mode: 'plan' } });
  expect(calls.find(c => c.method === 'session/send').params).toMatchObject({ inputId: 'bridge-one', sessionId: 'sess_test' });
  expect(calls.every(c => !Object.hasOwn(c, 'jsonrpc'))).toBe(true);
  expect(calls.find(c => c.id === 'prefs').result).toMatchObject({ askUserQuestionAutoResolutionEnabled: false });
});
it('resumes an opaque ZCode ID and stops only the submitted session', async () => {
  const h = await fixture('wait'), run = h.agent.run({ runId: 'two', cwd: h.root, prompt: 'hello', sessionId: 'sess_test', accessMode: 'full' });
  const events: AgentEvent[] = [];
  for await (const e of run.events) { events.push(e); if (e.type === 'system') setTimeout(() => { void run.stop(); }, 50); }
  expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
  expect(await run.waitForExit(3000)).toBe(true);
  const calls = await h.read(); expect(calls[0].method).toBe('session/resume');
  expect(calls.some(c => c.method === 'session/create')).toBe(false);
  expect(calls.find(c => c.method === 'session/stop').params.sessionId).toBe('sess_test');
});
it.each(['busy', 'disconnect', 'interaction'])('fails safely on %s and never resubmits or auto-approves', async kind => {
  const h = await fixture(kind), run = h.agent.run({ runId: 'error', cwd: h.root, prompt: 'hello' });
  const events: AgentEvent[] = []; for await (const e of run.events) events.push(e);
  expect(events.at(-1)?.type).toBe('error'); expect(await run.waitForExit(3000)).toBe(true);
  const calls = await h.read(); expect(calls.filter(c => c.method === 'session/send').length).toBe(kind === 'busy' ? 0 : 1);
  expect(calls.some(c => c.result?.decision === 'allow')).toBe(false);
});
it('reads fresh history and durable bridge labels through session operations without sending source input', async () => {
  const h = await fixture();
  const provider = new ZcodeSessionProvider(h.options, join(h.root, 'state'));
  expect((await provider.listSessions())[0]).toMatchObject({ nativeId: 'sess_test', name: 'AA-zcode', cwd: h.root });
  const path = await provider.historyPath('sess_test'); expect(await readFile(path!, 'utf8')).toContain('latest context');
  await provider.rename('sess_test', 'FF-zcode');
  expect((await new ZcodeSessionProvider(h.options, join(h.root, 'state')).listSessions())[0]?.name).toBe('FF-zcode');
  expect((await h.read()).some(c => c.method === 'session/send')).toBe(false);
  expect(await provider.historyPath('../../file')).toBeUndefined();
});

it('sets the native thought level before sending and carries it in the per-turn runtime model', async () => {
  const h = await fixture();
  const run = h.agent.run({ runId: 'effort', cwd: h.root, prompt: 'hello', reasoningEffort: 'native-level' });
  for await (const _event of run.events) { /* drain */ }
  expect(await run.waitForExit(3000)).toBe(true);
  const calls = await h.read();
  const setIndex = calls.findIndex(c => c.method === 'session/setThoughtLevel');
  const sendIndex = calls.findIndex(c => c.method === 'session/send');
  expect(setIndex).toBeGreaterThan(0); expect(setIndex).toBeLessThan(sendIndex);
  expect(calls[setIndex].params).toEqual({ sessionId: 'sess_test', thoughtLevel: 'native-level' });
  expect(calls[sendIndex].params.runtimeModel.thoughtLevel).toBe('native-level');
});
