import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ZcodeAdapter } from '../../../src/agent/zcode/adapter';
import { ZcodeSessionProvider } from '../../../src/tools/zcode-sessions';
import { ZcodeClient } from '../../../src/agent/zcode/client';
import { buildDirectUserPrompt } from '../../../src/agent/prompt';
import { wrapAuxiliaryPrompt } from '../../../src/bot/auxiliary-groups';
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
    const snapshot = { session: { sessionId: 'sess_test', title: 'AA-zcode', sessionKind: 'interactive', workspace: { workspacePath: ${JSON.stringify(root)} }, createdAt: 1, updatedAt: 2, status: ${JSON.stringify(kind === 'busy' ? 'running' : 'idle')}, model: { providerId: 'original', modelId: 'model' } }, lastError: ${JSON.stringify(kind === 'missing-model' ? { type: 'ZCODE_RUNTIME_MODEL_UNAVAILABLE' } : null)}, messages: [{ info: { role: 'assistant', messageId: 'msg_latest' }, role: 'assistant', parts: [{ type: 'text', text: 'latest context' }] }] };
    let inputId, seq = 0;
    const event = (type, payload, sessionId = 'sess_test') => send({ method: 'session/event', params: { type, payload, sessionId, seq: ++seq, turnId: 'turn-a' } });
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const r = JSON.parse(line); fs.appendFileSync(${JSON.stringify(calls)}, line+'\\n');
      if (r.method === 'session/list') return send({ id: r.id, result: { sessions: [snapshot.session] } });
      if (r.method === 'session/create' || r.method === 'session/resume') { send({ id: 'prefs', method: 'session/requestRuntimePreferences', params: {} }); return send({ id: r.id, result: snapshot }); }
      if (r.method === 'session/fork') return send({ id: r.id, result: { forkedSessionId: 'sess_copy', snapshot: { session: { sessionId: 'sess_copy' } } } });
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
  expect(calls[0].method).toBe('workspace/updateProviderRegistry');
  expect(calls.find(c => c.method === 'session/create')).toMatchObject({ params: { mode: 'plan' } });
  expect(calls.find(c => c.method === 'session/send').params).toMatchObject({ inputId: 'bridge-one', sessionId: 'sess_test', content: 'hello' });
  expect(calls.every(c => !Object.hasOwn(c, 'jsonrpc'))).toBe(true);
  expect(calls.find(c => c.id === 'prefs').result).toMatchObject({ askUserQuestionAutoResolutionEnabled: false });
});
it('resumes an opaque ZCode ID and stops only the submitted session', async () => {
  const h = await fixture('wait'), run = h.agent.run({ runId: 'two', cwd: h.root, prompt: 'hello', sessionId: 'sess_test', accessMode: 'full' });
  const events: AgentEvent[] = [];
  for await (const e of run.events) { events.push(e); if (e.type === 'system') setTimeout(() => { void run.stop(); }, 50); }
  expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
  expect(await run.waitForExit(3000)).toBe(true);
  const calls = await h.read(); expect(calls[0].method).toBe('workspace/updateProviderRegistry');
  expect(calls.find(c => c.method === 'session/resume').params).not.toHaveProperty('runtimeModel');
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
it('uses native titles in paired mode and delegates renames with the original project directory', async () => {
  const h=await fixture();const state=join(h.root,'state');
  await new ZcodeSessionProvider(h.options,state).rename('sess_test','outdated bridge label');
  const calls:unknown[]=[];
  const provider=new ZcodeSessionProvider({...h.options,remoteControlFile:'/private/pair.link'},state,
    async(...args)=>{calls.push(args);});
  expect((await provider.listSessions())[0]?.name).toBe('AA-zcode');
  await provider.rename('sess_test','AA-new');
  expect(calls).toEqual([['sess_test','AA-new',h.root]]);
  expect((await h.read()).some(c=>c.method==='session/send')).toBe(false);
});
it('reads current desktop session_ IDs as well as legacy sess_ IDs',async()=>{
  const h=await fixture();const cli=join(h.root,'cli.cjs');
  await writeFile(cli,(await readFile(cli,'utf8')).replaceAll("'sess_test'","'session_desktop'"));
  const provider=new ZcodeSessionProvider(h.options,join(h.root,'state'));
  const path=await provider.historyPath('session_desktop');
  expect(await readFile(path!,'utf8')).toContain('latest context');
  expect((await h.read()).some(c=>c.method==='session/send')).toBe(false);
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

it('preserves the resumed provider and all its models instead of selecting the new default', async () => {
  const h = await fixture();
  await writeFile(join(h.root, 'config.json'), JSON.stringify({ model: 'default-provider/model', provider: {
    original: { name: 'Original', kind: 'openai', models: { model: {}, another: {} } },
    'default-provider': { name: 'Default', kind: 'openai', models: { model: {} } },
  } }));
  const run = h.agent.run({ runId: 'keep-original', cwd: h.root, sessionId: 'sess_test', prompt: 'continue' });
  const events: AgentEvent[] = []; for await (const event of run.events) events.push(event);
  expect(await run.waitForExit(3000)).toBe(true);
  expect(events).toContainEqual(expect.objectContaining({ type: 'system', model: 'original/model' }));
  const calls = await h.read();
  expect(calls[0].params.registry.providers.map((p: any) => [p.providerId, p.models.map((m: any) => m.modelId)])).toEqual([
    ['original', ['model', 'another']], ['default-provider', ['model']],
  ]);
  for (const call of calls.filter(c => ['session/resume', 'session/send'].includes(c.method))) expect(call.params).not.toHaveProperty('runtimeModel');
  expect(calls.some(c => c.method === 'session/setModel')).toBe(false);
});
it('blocks missing original models, while explicit model changes are applied before reasoning settings', async () => {
  const h = await fixture('missing-model');
  const run = h.agent.run({ runId: 'missing', cwd: h.root, sessionId: 'sess_test', prompt: 'must not run' });
  const events: AgentEvent[] = []; for await (const event of run.events) events.push(event);
  expect(await run.waitForExit(3000)).toBe(true);
  expect(events.at(-1)).toMatchObject({ type: 'error', submissionStatus: 'rejected' });
  expect((await h.read()).some(c => c.method === 'session/send')).toBe(false);
  const next = h.agent.run({ runId: 'explicit', cwd: h.root, sessionId: 'sess_test', model: 'test/model', reasoningEffort: 'high', prompt: 'switch' });
  for await (const _event of next.events) { /* drain */ }
  expect(await next.waitForExit(3000)).toBe(true);
  const calls = await h.read(), set = calls.findIndex(c => c.method === 'session/setModel');
  expect(set).toBeGreaterThan(0); expect(set).toBeLessThan(calls.findIndex(c => c.method === 'session/setThoughtLevel'));
  expect(calls[set].params.model).toEqual({ providerId: 'test', modelId: 'model' });
});

it('copies the native checkpoint through the provider without sending a prompt or changing the source', async () => {
  const h = await fixture();
  const provider = new ZcodeSessionProvider(h.options, join(h.root, 'bridge-labels'));
  const copy = await provider.fork('sess_test');
  expect(copy).toEqual({ nativeId: 'sess_copy', name: 'AA-zcode (1)', cwd: h.root });
  const calls = await h.read();
  expect(calls.find(c => c.method === 'session/fork').params).toEqual({ sessionId: 'sess_test', target: { kind: 'message', messageId: 'msg_latest' } });
  expect(calls.some(c => ['session/send', 'session/setModel', 'session/stop'].includes(c.method))).toBe(false);
  expect(calls.findIndex(c => c.method === 'workspace/updateProviderRegistry')).toBeLessThan(calls.findIndex(c => c.method === 'session/resume'));
});
it('refuses native copy while a task is running', async () => {
  const h = await fixture('busy');
  const provider = new ZcodeSessionProvider(h.options, join(h.root, 'bridge-labels'));
  await expect(provider.fork('sess_test')).rejects.toThrow('先停止');
  expect((await h.read()).some(c => c.method === 'session/fork')).toBe(false);
});

it.each(['direct', 'full', 'brief'] as const)('preserves %s input without a global bridge prefix on fresh and resumed sessions', async kind => {
  const h = await fixture();
  const prompt = kind === 'direct' ? '你好 <tag>\n请继续' : wrapAuxiliaryPrompt(
    { toolId: 'zcode', nativeId: 'source' }, '/history', '检查', false, { mode: kind, chatId: 'oc_target' },
  );
  for (const resumed of [false, true]) {
    const run = h.agent.run({ runId: `prompt-${kind}-${resumed}`, cwd: h.root, prompt,
      ...(resumed ? { sessionId: 'sess_test' } : {}),
    });
    for await (const _event of run.events) { /* drain */ }
    expect(await run.waitForExit(3000)).toBe(true);
    const sends = (await h.read()).filter(call => call.method === 'session/send');
    expect(sends.at(-1).params.content).toBe(prompt);
  }
});

it.each(['direct', 'full'] as const)('keeps attachment context inside the %s prompt without appending text outside FF JSON', async kind => {
  const h = await fixture();
  const path = join(h.root, '调试 report.png');
  const input = buildDirectUserPrompt({ userInput: '看图', attachments: [
    { path, kind: 'image', decision: 'accepted' },
  ] });
  const prompt = kind === 'direct' ? input : wrapAuxiliaryPrompt(
    { toolId: 'zcode', nativeId: 'source' }, '/history', input, false, { mode: kind, chatId: 'oc_target' },
  );
  const run = h.agent.run({ runId: 'attachment', cwd: h.root, prompt, attachmentPaths: [path] });
  for await (const _event of run.events) { /* drain */ }
  expect(await run.waitForExit(3000)).toBe(true);
  const content = (await h.read()).find(call => call.method === 'session/send').params.content;
  expect(content).toBe(prompt);
  expect(content).not.toContain('按外传限制使用');
  expect(kind === 'full' ? JSON.parse(content).user_input : content).toContain(path);
});
