import { expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import { fixture } from './fixture';
import { wrapAuxiliaryPrompt } from '../../../src/bot/auxiliary-groups';
import { KiloSessionProvider } from '../../../src/tools/kilo-sessions';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { kiloBridgeTextPart, KiloNativeConversationReader } from '../../../src/agent/kilo/conversation';
import { startWorkerServer } from '../../../src/worker/server';
import { WorkerClient } from '../../../src/worker/client';
import { KiloClient } from '../../../src/agent/kilo/client';
import { readKiloModels } from '../../../src/agent/kilo/models';
async function collect(h: Awaited<ReturnType<typeof fixture>>, options: Record<string, unknown> = {}) {
  const run = h.agent.run({ runId: 'one', cwd: h.root, prompt: '原样 <tag>\n第二行', ...options });
  const events: AgentEvent[] = []; for await (const e of run.events) events.push(e);
  expect(await run.waitForExit(3000)).toBe(true); return events;
}
it('authenticates its loopback child, scopes streamed events to its own input, and sends direct text unchanged', async () => {
  const h = await fixture(); const events = await collect(h);
  expect(events.filter(e => e.type === 'text').map(e => e.delta).join('')).toBe('KILO_READY');
  expect(events).toContainEqual({ type: 'tool_result', id: 'tool_read', output: 'OK', isError: false });
  expect(events.at(-1)).toMatchObject({ type: 'done', sessionId: 'ses_created' });
  const calls = await h.read(); const sent = calls.find(r => r.path.endsWith('/prompt_async'));
  expect(sent.body.parts).toEqual([{ type: 'text', text: '原样 <tag>\n第二行', metadata: { 'lark-channel-bridge': { version: 1, origin: 'feishu' } } }]);
  expect(sent.body).not.toHaveProperty('system'); expect(calls.every(c => c.authenticated)).toBe(true);
  expect(calls.find(c => c.method === 'POST' && c.path === '/session').body.permission).toEqual([{ permission: '*', action: 'allow', pattern: '*' }]);
});
it('passes the group envelope intact', async () => {
  const h = await fixture(); const prompt = wrapAuxiliaryPrompt('检查', false, { chatId: 'oc_group' });
  await collect(h, { prompt });
  const sent = (await h.read()).find(r => r.path.endsWith('/prompt_async'));
  expect(sent.body.parts[0].text).toBe(prompt);
  expect(JSON.parse(sent.body.parts[0].text).context.chat_id).toBe('oc_group');
});
it('preserves the native provider and variant when resuming after the default changes', async () => {
  const h = await fixture(); const events = await collect(h, { sessionId: 'ses_source' });
  expect(events.at(-1)?.type).toBe('done');
  const calls = await h.read(), sent = calls.find(c => c.path.endsWith('/prompt_async'));
  expect(sent.body).toMatchObject({ model: { providerID: 'original', modelID: 'model/path' }, variant: 'native-level' });
  expect(calls.some(c => c.method === 'POST' && c.path === '/session')).toBe(false);
});
it('passes arbitrary native reasoning levels with the explicitly chosen model', async () => {
  const h = await fixture(); const events = await collect(h, { sessionId: 'ses_source', model: 'other/model', reasoningEffort: 'high' });
  expect(events).toContainEqual(expect.objectContaining({ type: 'system', reasoningEffort: 'high' }));
  expect((await h.read()).find(c => c.path.endsWith('/prompt_async')).body).toMatchObject({ model: { providerID: 'other', modelID: 'model' }, variant: 'high' });
  const reader = new KiloNativeConversationReader(h.options);
  try { expect((await reader.read('ses_source')).turns.at(-1)?.state.execution).toEqual({ model: 'other/model', reasoningEffort: 'high' }); }
  finally { await reader.close(); }
});
it.each(['busy', 'interaction', 'disconnect', 'rejected'])('reports %s without resubmission or automatic native approval', async kind => {
  const h = await fixture(kind); const events = await collect(h, { sessionId: 'ses_source' });
  expect(events.at(-1)?.type).toBe('error');
  const calls = await h.read(); expect(calls.filter(c => c.path.endsWith('/prompt_async')).length).toBe(kind === 'busy' ? 0 : 1);
  expect(calls.some(c => c.path.includes('/reply'))).toBe(false);
  if (kind === 'busy') expect(calls.some(c => c.method === 'PATCH')).toBe(false);
});
it('stops only its own run and never sends a second prompt', async () => {
  const h = await fixture('wait'); const run = h.agent.run({ runId: 'stop', cwd: h.root, prompt: 'wait', sessionId: 'ses_source' });
  const events: AgentEvent[] = [];
  for await (const event of run.events) { events.push(event); if (event.type === 'system') setTimeout(() => void run.stop(), 100); }
  expect(await run.waitForExit(3000)).toBe(true); expect(events.at(-1)).toMatchObject({ type: 'done', terminationReason: 'interrupted' });
  const calls = await h.read(); expect(calls.filter(c => c.path.endsWith('/prompt_async'))).toHaveLength(1);
  expect(calls.find(c => c.path.endsWith('/abort'))).toMatchObject({ path: '/session/ses_source/abort', query: { scope: 'session' } });
});
it('refuses deleted native models instead of falling back to another provider', async () => {
  const h = await fixture(); await h.update(s => { delete s.providers.all[0].models['model/path']; });
  const events = await collect(h, { sessionId: 'ses_source' }); expect(events.at(-1)?.type).toBe('error');
  expect((await h.read()).some(c => c.path.endsWith('/prompt_async'))).toBe(false);
});
it('keeps read-only execution restrictions in native permissions', async () => {
  const h = await fixture(); await collect(h, { accessMode: 'read-only' });
  const permission = (await h.read()).find(c => c.method === 'POST' && c.path === '/session').body.permission;
  expect(permission[0]).toEqual({ permission: '*', pattern: '*', action: 'deny' });
  expect(permission).toContainEqual({ permission: 'read', pattern: '*', action: 'allow' });
  expect(permission.some((p: any) => ['bash', 'edit'].includes(p.permission) && p.action === 'allow')).toBe(false);
});
it('dynamically reloads connected providers and per-model variants without exposing credentials', async () => {
  const h = await fixture(); const first = await h.agent.listModels({ cwd: h.root });
  expect(first.find(m => m.value === 'original/model/path')?.reasoningEfforts).toContainEqual({ value: 'native-level', label: 'native-level' });
  expect(first.find(m => m.value === 'other/model')?.reasoningEfforts).not.toContainEqual({ value: 'native-level', label: 'native-level' });
  expect(JSON.stringify(first)).not.toContain('NEVER_EXPOSE_KEY');
  expect(first.find(m => m.value === 'original/model/path')?.label).not.toBe(first.find(m => m.value === 'other/model')?.label);
  await h.update(s => { s.providers.all[0].models = { added: { id: 'added', name: 'Added', variants: { ultra: {} } } }; });
  const second = await h.agent.listModels({ cwd: h.root });
  expect(second.some(m => m.value === 'original/model/path')).toBe(false);
  expect(second.find(m => m.value === 'original/added')?.reasoningEfforts?.[0]?.value).toBe('ultra');
});
it('puts configured custom providers on the first model page ahead of a large gateway catalog', async () => {
  const h = await fixture();
  await h.update(s => {
    s.config = { provider: { custom: { options: { apiKey: 'CUSTOM_SECRET' } }, disconnected: {} } };
    s.providers = { connected: ['gateway', 'custom'], default: {}, all: [
      { id: 'gateway', name: 'Gateway', models: Object.fromEntries(Array.from({ length: 336 }, (_, i) => [`m${i}`, { id: `m${i}` }])) },
      { id: 'disconnected', name: 'Disconnected', models: { model: { id: 'model' } } },
      { id: 'custom', name: 'Custom', models: { first: { id: 'first' }, second: { id: 'second', variants: { high: {}, disabled: { disabled: true } } } } },
    ] };
    s.modelState = { recent: [], variant: {} };
  });
  const first = await h.agent.listModels({ cwd: h.root });
  expect(first.slice(1, 3).map(m => m.value)).toEqual(['custom/first', 'custom/second']);
  expect(first).toHaveLength(339);
  expect(first.some(m => m.value.startsWith('disconnected/'))).toBe(false);
  expect(first.find(m => m.value === 'custom/second')?.reasoningEfforts).toEqual([{ value: 'high', label: 'high' }]);
  expect(JSON.stringify(first)).not.toContain('CUSTOM_SECRET');
  // Re-read native configuration rather than caching provider priority.
  await h.update(s => { s.config.provider = { gateway: {} }; });
  expect((await h.agent.listModels({ cwd: h.root }))[1]?.value).toBe('gateway/m0');
});
it.each(['config', 'recent'] as const)('prioritizes the %s model while preserving its selection and reasoning', async source => {
  const h = await fixture();
  await h.update(s => {
    s.config = { provider: { original: {}, other: {} }, ...(source === 'config' ? { model: 'other/chosen' } : {}) };
    s.providers.all[1].models.chosen = { id: 'chosen', variants: { ultra: {} } };
    s.modelState = { recent: [{ providerID: source === 'config' ? 'original' : 'other', modelID: source === 'config' ? 'model/path' : 'chosen' }], variant: { 'other/chosen': 'ultra' } };
  });
  const client = new KiloClient(h.options, h.root);
  try {
    const models = await readKiloModels(client, h.root);
    expect(models).toMatchObject({ selected: 'other/chosen', variant: 'ultra' });
    expect(models.options.slice(1, 4).map(m => m.value)).toEqual(['other/chosen', 'other/model', 'original/model/path']);
    expect(models.options[0]?.reasoningEfforts).toEqual([{ value: 'ultra', label: 'ultra' }]);
    expect(models.catalog.all.map(p => p.id)).toEqual(['original', 'other']);
  } finally { await client.close(); }
});
it('reads source snapshots, renames, copies, and archives through the native API without prompting the source', async () => {
  const h = await fixture(); const sessions = new KiloSessionProvider(h.options, join(h.root, 'history'));
  const path = await sessions.historyPath('ses_source'); expect(JSON.parse(await readFile(path!, 'utf8')).session.id).toBe('ses_source');
  expect(await sessions.historyPath('../../secrets')).toBeUndefined();
  await sessions.rename('ses_source', 'AA-New'); expect((await sessions.listSessions())[0]?.name).toBe('AA-New');
  const copy = await sessions.fork('ses_source'); expect(copy).toMatchObject({ nativeId: 'ses_copy', cwd: h.root });
  await sessions.archive('ses_copy'); expect((await sessions.listSessions()).find(s => s.nativeId === 'ses_copy')?.archived).toBe(true);
  expect((await h.read()).some(c => c.path.endsWith('/prompt_async'))).toBe(false);
});

it('leaves native implicit default variants to Kilo instead of treating them as deleted explicit choices', async () => {
  const h = await fixture(); await h.update(s => { s.sessions.ses_source.model.variant = 'default'; });
  const events = await collect(h, { sessionId: 'ses_source' });
  expect(events.at(-1)?.type).toBe('done');
  expect(events).toContainEqual(expect.objectContaining({ type: 'system', reasoningEffort: 'default' }));
  expect((await h.read()).find(c => c.path.endsWith('/prompt_async')).body).not.toHaveProperty('variant');
  const reader = new KiloNativeConversationReader(h.options);
  try { expect((await reader.read('ses_source')).turns.at(-1)?.state.execution).toEqual({ model: 'original/model/path', reasoningEffort: 'default' }); }
  finally { await reader.close(); }
});
it('rejects an unavailable explicit variant before sending any input', async () => {
  const h = await fixture(); const events = await collect(h, { sessionId: 'ses_source', reasoningEffort: 'removed-variant' });
  expect(events.at(-1)).toMatchObject({ type: 'error', submissionStatus: 'rejected' });
  expect((await h.read()).some(c => c.path.endsWith('/prompt_async'))).toBe(false);
});

async function nativeTurnFixture(kind = 'busy') {
  const h = await fixture(kind);
  await h.update(s => { s.messages.ses_source = [{ info: { id: 'msg_native', role: 'user', time: { created: 10 } }, parts: [{ type: 'text', text: 'native question' }] }]; });
  return h;
}
it('exposes Kilo native turn stop through the common worker route without sending a prompt', async () => {
  const h = await nativeTurnFixture(), stateDir = join(h.root, 'worker');
  const server = await startWorkerServer({ stateDir, agent: h.agent, sourceId: h.root, botAppId: 'bot' });
  try {
    const client = new WorkerClient(stateDir, h.root, 'bot', 'kilo');
    expect((await client.capabilities())?.nativeTurnStop).toBe(true);
    expect(await client.stopNativeTurn('ses_source', 'msg_native', h.root)).toBe(true);
    const calls = await h.read();
    expect(calls.filter(c => c.path.endsWith('/abort'))).toEqual([expect.objectContaining({ path: '/session/ses_source/abort', query: { directory: h.root, scope: 'session' } })]);
    expect(calls.some(c => c.path.endsWith('/prompt_async'))).toBe(false);
  } finally { await server.close(); }
});
it.each(['cwd', 'turn', 'bridge', 'archived', 'completed'] as const)('refuses to stop when the native %s guard no longer matches', async guard => {
  const h = await nativeTurnFixture(guard === 'completed' ? 'normal' : 'busy');
  await h.update(s => {
    if (guard === 'bridge') s.messages.ses_source[0].parts = [kiloBridgeTextPart('from feishu')];
    if (guard === 'archived') s.sessions.ses_source.time.archived = 12;
    if (guard === 'completed') s.messages.ses_source.push({ info: { id: 'answer', role: 'assistant', parentID: 'msg_native', time: { created: 11, completed: 12 } }, parts: [] });
  });
  expect(await h.agent.stopNativeTurn('ses_source', guard === 'turn' ? 'msg_stale' : 'msg_native', guard === 'cwd' ? '/wrong/project' : h.root)).toBe(false);
  expect((await h.read()).some(c => c.path.endsWith('/abort') || c.path.endsWith('/prompt_async'))).toBe(false);
});
it.each(['success', 'false', 'error', 'legacy'] as const)('uses the selected worker stop path for %s without retrying an ambiguous mutation', async kind => {
  const h = await nativeTurnFixture();
  const workerStop = vi.fn(async () => { if (kind === 'error') throw Error('ack lost'); return kind === 'legacy' ? undefined : kind === 'success'; });
  const reader = new KiloNativeConversationReader(h.options, workerStop);
  try {
    if (kind === 'error') await expect(reader.stopTurn('ses_source', 'msg_native')).rejects.toThrow('ack lost');
    else expect(await reader.stopTurn('ses_source', 'msg_native')).toBe(kind !== 'false');
    expect(workerStop).toHaveBeenCalledOnce();
    expect(workerStop).toHaveBeenCalledWith('ses_source', 'msg_native', h.root);
    expect((await h.read()).filter(c => c.path.endsWith('/abort'))).toHaveLength(kind === 'legacy' ? 1 : 0);
  } finally { await reader.close(); }
});
