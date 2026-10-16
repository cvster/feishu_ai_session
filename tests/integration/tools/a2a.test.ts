import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CardActionEvent, LarkChannel } from '@larksuite/channel';
import type { Controls } from '../../../src/commands';
import { AuxiliaryGroups } from '../../../src/bot/auxiliary-groups';
import { AuxiliaryApprovals } from '../../../src/bot/auxiliary-approvals';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { ToolRegistry } from '../../../src/tools/types';
import { SessionStore } from '../../../src/session/store';
import { SessionCatalog } from '../../../src/session/catalog';
import { WorkspaceStore } from '../../../src/workspace/store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { RunExecutor } from '../../../src/runtime/run-executor';
import { ActiveRuns } from '../../../src/bot/active-runs';
import { ProcessPool } from '../../../src/bot/process-pool';
import { NativeSessionLocks } from '../../../src/tools/locks';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { defaultAlias, loadA2AConfig, mintKey, saveA2AConfig, setAlias, type A2AConfig } from '../../../src/a2a/config';
import { startA2AServer, parseSend } from '../../../src/a2a/server';
import { createA2ARunner } from '../../../src/a2a/runner';
import { A2ATaskStore } from '../../../src/a2a/store';

const roots: string[] = [], cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0)) await f(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const shared = 'aux_11111111-1111-4111-8111-111111111111';
const originalId = '22222222-2222-4222-8222-222222222222';
const nativeId = '33333333-3333-4333-8333-333333333333';
async function freePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(r => { resolve = r; }), release: () => resolve() }; }
async function setup(toolId: 'codex' | 'claude' | 'zcode' = 'codex') {
  const root = await mkdtemp(join(tmpdir(), 'ff-a2a-')); roots.push(root);
  const history = join(root, 'source.jsonl'); await writeFile(history, '原会话记录');
  const bindings = new ToolBindingStore(join(root, 'bindings.json')); await bindings.load();
  bindings.set(shared, { toolId, sourceId: root, name: 'FF-C系列', nativeId, nativeCreated: true,
    linkedSource: { toolId, sourceId: root, nativeId: originalId, historyPath: history } });
  bindings.linkAuxiliary('oc_group', shared); await bindings.flush();
  const sessions = new SessionStore(join(root, 'sessions.json')); await sessions.load();
  const catalog = new SessionCatalog(join(root, 'catalog.json')); await catalog.load();
  const workspaces = new WorkspaceStore(join(root, 'workspaces.json')); await workspaces.load();
  const send = vi.fn(async () => ({ messageId: 'om_receipt' }));
  const create = vi.fn(async (..._args: unknown[]) => ({ code: 0, data: { message_id: 'om_approval' } }));
  const cards: any[] = [];
  const channel = { send, createCard: vi.fn(async card => { cards.push(card); return { cardId: 'card_1' }; }),
    updateCardById: vi.fn(async () => {}), getChatMode: vi.fn(async () => 'p2p'), rawClient: { im: { v1: { message: { create } } } } } as unknown as LarkChannel;
  const agent = new FakeAgentAdapter({ id: toolId, events: [
    { type: 'system', ...(toolId === 'codex' ? { threadId: nativeId } : { sessionId: nativeId }), cwd: root },
    { type: 'text', delta: '检查完成。' }, { type: 'done', terminationReason: 'normal' },
  ] });
  // Existing Claude FF title lookup is unrelated to API transport in this fixture.
  if (toolId === 'claude') {
    const historyRoot = join(root, 'projects', '-project'); await mkdir(historyRoot, { recursive: true });
    await writeFile(join(historyRoot, `${nativeId}.jsonl`), '');
  }
  const tools = new ToolRegistry(); tools.register({ id: toolId, sourceId: root, label: toolId, agent, listSessions: async () => [], ...(toolId === 'zcode' ? { sessions: { historyMode: 'snapshot' as const, historyPath: async () => history, rename: async () => {}, archive: async () => {} } } : {}) });
  await writeFile(join(root, 'aux.json'), JSON.stringify({ version: 1, appId: 'cli_test', groups: {
    oc_group: { chatId: 'oc_group', ownerId: 'ou_owner', generation: 'g1', status: 'active', name: 'C系列讨论', cwd: root,
      source: bindings.get(shared)!.linkedSource },
  } }));
  let owner = 'ou_owner';
  const auxiliary = new AuxiliaryGroups({ path: join(root, 'aux.json'), appId: 'cli_test', channel, tools, bindings, sessions, catalog, workspaces,
    ownerId: () => owner, refreshOwner: async () => {}, cancelPending: async () => {} }); await auxiliary.load();
  let service: Awaited<ReturnType<typeof startA2AServer>>;
  const approvals = new AuxiliaryApprovals({ path: join(root, 'approvals.json'), channel, auxiliary, bindings, ownerId: () => owner,
    validateApi: scope => service!.validScope(scope), resume: r => service!.resume(r) }); await approvals.load();
  const profileConfig = createDefaultProfileConfig({ agentKind: toolId, codex: { binaryPath: 'codex', codexHome: root },
    accounts: { app: { id: 'cli_test', secret: 's', tenant: 'feishu' } } });
  const activeRuns = new ActiveRuns();
  const executor = new RunExecutor({ agent, pool: new ProcessPool(() => 2), activeRuns,
    sessionNameForScope: scope => bindings.get(scope)?.name, nativeSessionLocks: new NativeSessionLocks(), nativeSessionKey: id => id });
  const controls = { profileConfig, cfg: profileConfig, profile: 'test', auxiliary, auxiliaryApprovals: approvals, toolBindings: bindings,
    toolRegistry: tools, executorForTool: () => executor } as unknown as Controls;
  const issued = mintKey('alice', owner), second = mintKey('bob', owner);
  const config: A2AConfig = { version: 1, enabled: true, host: '127.0.0.1', port: await freePort(), namespace: 'LennoxGao',
    endpoints: { [shared]: { enabled: true, alias: 'c-series', keys: [issued.key, second.key] } } };
  const configPath = join(root, 'a2a.json'), tasksPath = join(root, 'tasks.json'); await saveA2AConfig(configPath, config);
  const deps = { configPath, tasksPath, auxiliary, approvals, ownerId: () => owner, execute: createA2ARunner({ controls, sessions, sessionCatalog: catalog, workspaces }) };
  service = await startA2AServer(deps);
  const origin = `http://127.0.0.1:${config.port}/LennoxGao/agents/`;
  async function request(path: string, body?: unknown, token = issued.token, alias = 'c-series', headers: Record<string, string> = {}) {
    const response = await fetch(`${origin}${alias}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'A2A-Version': '1.0', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  }
  const ask = (text = '检查联调环境', messageId = 'request-1') => ({ message: { messageId, role: 'ROLE_USER', parts: [{ text }] }, configuration: { returnImmediately: true } });
  async function finished(id: string) {
    let result: any;
    await vi.waitFor(async () => { result = await request(`/tasks/${id}`); expect(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']).not.toContain(result.body.status.state); }, { timeout: 5000 });
    return result;
  }
  cleanup.push(async () => { await service?.close(); await activeRuns.disconnectAll(); await Promise.all([auxiliary.flush(), bindings.flush(), approvals.flush(), sessions.flush(), catalog.flush(), workspaces.flush()]); });
  return { root, config, configPath, tasksPath, bindings, auxiliary, approvals, agent, channel, send, create, cards, request, ask, finished, deps,
    owner: (id: string) => { owner = id; }, issued, second, shared,
    restart: async () => { await service?.close(); service = await startA2AServer(deps); },
  };
}

it.each(['codex', 'claude', 'zcode'] as const)('runs %s in the shared FF with both aliases, owner-bound member keys and no IM delivery', async toolId => {
  const h = await setup(toolId);
  const accepted = await h.request('/message:send', h.ask()); expect(accepted.status).toBe(200);
  const id = accepted.body.task.id, result = await h.finished(id);
  expect(result.body.status.state).toBe('TASK_STATE_COMPLETED'); expect(result.body.artifacts[0].parts[0].text).toBe('检查完成。');
  const throughDefault = await h.request(`/tasks/${id}`, undefined, h.issued.token, defaultAlias(shared));
  expect(throughDefault.body.id).toBe(id);
  expect(h.agent.runOptions[0]).toMatchObject(toolId === 'codex' ? { threadId: nativeId } : { sessionId: nativeId });
  const prompt = JSON.parse(h.agent.runOptions[0]!.prompt);
  expect(prompt.context).toMatchObject({ channel: 'a2a', actor: 'member' }); expect(prompt.context.chat_id).toBeUndefined();
  expect(prompt.rules.delivery).toContain('不通过飞书'); expect(prompt.rules.permissions).toContain('不修改项目源码');
  expect(h.send).not.toHaveBeenCalled(); expect(h.create).not.toHaveBeenCalled();
  expect((await stat(h.tasksPath)).mode & 0o777).toBe(0o600);
  expect((await h.request(`/tasks/${id}`, undefined, h.second.token)).status).toBe(404);
  expect((await h.request('/tasks', undefined, h.second.token)).body.tasks).toEqual([]);
});

it('publishes a versioned capability card without secrets or internal IDs and rejects model-style input', async () => {
  const h = await setup(), result = await h.request('/agent-card.json');
  expect(result.body.supportedInterfaces[0]).toMatchObject({ protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' });
  expect(result.body.capabilities.extensions[0].params.aliases).toEqual([defaultAlias(shared), 'c-series']);
  expect(result.body.securityRequirements).toEqual([{ schemes: { bearer: { list: [] } } }]);
  expect(result.body).not.toHaveProperty('security'); expect(result.body).not.toHaveProperty('metadata');
  expect(JSON.stringify(result.body)).not.toContain(h.issued.token); expect(JSON.stringify(result.body)).not.toContain(originalId);
  expect((await h.request('/agent-card.json', undefined, 'wrong')).status).toBe(401);
  expect((await h.request('/message:send', { model: 'x', input: 'hello' })).status).toBe(400);
  expect((await h.request('/message:send', h.ask(), h.issued.token, 'c-series', { 'A2A-Version': '' })).body.error.details[0].reason).toBe('VERSION_NOT_SUPPORTED');
  expect((await h.request('/message:stream', h.ask())).status).toBe(400);
});

it('deduplicates across aliases and restarts and rejects changed content or contexts without a second execution', async () => {
  const h = await setup();
  const [a, b] = await Promise.all([h.request('/message:send', h.ask()), h.request('/message:send', h.ask(), h.issued.token, defaultAlias(shared))]);
  expect(a.body.task.id).toBe(b.body.task.id); await h.finished(a.body.task.id);
  await h.restart();
  expect((await h.request('/message:send', h.ask())).body.task.id).toBe(a.body.task.id);
  expect((await h.request('/message:send', h.ask('另一件事'))).status).toBe(409);
  const forged = h.ask(); Object.assign(forged.message, { contextId: 'someone-elses-context' });
  expect((await h.request('/message:send', forged)).status).toBe(400);
  expect(h.agent.runOptions).toHaveLength(1);
});

it('returns full growing artifacts, serializes shared requests, and cancels only the selected task', async () => {
  const h = await setup(), gate = deferred(); cleanup.unshift(async () => gate.release());
  let stopped = false;
  const stop = vi.fn(async () => { stopped = true; gate.release(); });
  h.agent.run = vi.fn(opts => ({ runId: opts.runId, stop, waitForExit: async () => true,
    events: { async *[Symbol.asyncIterator]() {
      yield { type: 'system' as const, threadId: nativeId }; yield { type: 'text' as const, delta: '第一段' };
      await gate.promise; if (stopped) { yield { type: 'done' as const, terminationReason: 'interrupted' as const }; return; }
      yield { type: 'text' as const, delta: '第二段' }; yield { type: 'done' as const, terminationReason: 'normal' as const };
    } },
  }));
  const a = await h.request('/message:send', h.ask()), id = a.body.task.id;
  await vi.waitFor(async () => expect((await h.request(`/tasks/${id}`)).body.artifacts[0]?.parts[0].text).toBe('第一段'));
  const second = await h.request('/message:send', h.ask('另一个任务', 'req-2'));
  await h.request(`/tasks/${second.body.task.id}:cancel`, {});
  expect(h.agent.run).toHaveBeenCalledOnce();
  const progress = await h.request(`/tasks/${id}`); expect(progress.body.artifacts[0].parts[0].text).toBe('第一段');
  gate.release(); const final = await h.finished(id); expect(final.body.artifacts[0].parts[0].text).toBe('第一段第二段');
  expect((await h.request(`/tasks/${second.body.task.id}`)).body.status.state).toBe('TASK_STATE_CANCELED');
  expect(stop).not.toHaveBeenCalled(); expect(h.agent.run).toHaveBeenCalledOnce();
});

it('routes permission review privately to the owner, resumes exactly once, and keeps the grant scoped', async () => {
  const h = await setup();
  h.agent.setEvents([
    [{ type: 'system', threadId: nativeId }, { type: 'text', delta: JSON.stringify({ type: 'ff_permission_request', action: '修改 src/a.ts', reason: '需要改源码' }) }, { type: 'done', terminationReason: 'normal' }],
    [{ type: 'system', threadId: nativeId }, { type: 'text', delta: '已完成本次确认的修改。' }, { type: 'done', terminationReason: 'normal' }],
  ]);
  const initial = await h.request('/message:send', h.ask()), id = initial.body.task.id;
  expect((await h.finished(id)).body.status.state).toBe('TASK_STATE_AUTH_REQUIRED');
  expect(h.create.mock.calls[0]?.[0]).toMatchObject({ params: { receive_id_type: 'open_id' }, data: { receive_id: 'ou_owner' } });
  expect(JSON.stringify(h.cards[0])).toContain('API：alice');
  const value = h.cards[0].body.elements.at(-1).columns[0].elements[0].behaviors[0].value;
  const event = { chatId: 'oc_owner_dm', messageId: 'om_approval', operator: { openId: 'ou_owner' }, action: { value } } as CardActionEvent;
  await h.approvals.action({ ...event, operator: { openId: 'ou_intruder' } }); expect(h.agent.runOptions).toHaveLength(1);
  await Promise.all([h.approvals.action(event), h.approvals.action(event)]);
  await vi.waitFor(async () => expect((await h.request(`/tasks/${id}`)).body.status.state).toBe('TASK_STATE_COMPLETED'));
  expect(h.agent.runOptions).toHaveLength(2); expect(h.send).not.toHaveBeenCalled();
  const prompt = JSON.parse(h.agent.runOptions[1]!.prompt);
  expect(prompt.context.actor).toBe('member'); expect(prompt.context.approval.action).toBe('修改 src/a.ts');
  expect(prompt.rules.permissions).toContain('仅对context.approval.action');
  await h.restart(); await h.approvals.recover(); expect(h.agent.runOptions).toHaveLength(2);
});

it('revokes queued and approval execution after key revocation, owner changes or FF archive', async () => {
  const h = await setup();
  h.config.endpoints[shared]!.keys[0]!.revoked = true; await saveA2AConfig(h.configPath, h.config);
  expect((await h.request('/message:send', h.ask())).status).toBe(401);
  h.config.endpoints[shared]!.keys[0]!.revoked = false; await saveA2AConfig(h.configPath, h.config);
  h.owner('ou_new'); expect((await h.request('/message:send', h.ask())).status).toBe(401);
  h.owner('ou_owner'); h.bindings.archive('codex', h.root, nativeId);
  expect((await h.request('/message:send', h.ask())).status).toBe(410); expect(h.agent.runOptions).toHaveLength(0);
});

it('cancels an active API run without stopping or delivering to other scopes', async () => {
  const h = await setup(), gate = deferred(); cleanup.unshift(async () => gate.release());
  const stop = vi.fn(async () => gate.release());
  h.agent.run = vi.fn(opts => ({ runId: opts.runId, stop, waitForExit: async () => true,
    events: { async *[Symbol.asyncIterator]() { yield { type: 'system' as const, threadId: nativeId };
      yield { type: 'text' as const, delta: '进行中' }; await gate.promise;
      yield { type: 'done' as const, terminationReason: 'interrupted' as const }; } },
  }));
  const id = (await h.request('/message:send', h.ask())).body.task.id;
  await vi.waitFor(async () => expect((await h.request(`/tasks/${id}`)).body.status.state).toBe('TASK_STATE_WORKING'));
  const result = await h.request(`/tasks/${id}:cancel`, {}); expect(result.body.status.state).toBe('TASK_STATE_CANCELED');
  expect(stop).toHaveBeenCalledOnce(); expect(h.send).not.toHaveBeenCalled();
  expect((await h.request(`/tasks/${id}:cancel`, {})).body.status.state).toBe('TASK_STATE_CANCELED');
});

it.each(['deny', 'revoke', 'archive'] as const)('does not continue a permission task after %s, including stale owner callbacks', async mode => {
  const h = await setup();
  h.agent.setEvents([{ type: 'system', threadId: nativeId }, { type: 'text', delta: JSON.stringify({ type: 'ff_permission_request', action: '改源码', reason: '需要授权' }) }, { type: 'done', terminationReason: 'normal' }]);
  const id = (await h.request('/message:send', h.ask())).body.task.id; await h.finished(id);
  const value = { ...h.cards[0].body.elements.at(-1).columns[0].elements[0].behaviors[0].value, decision: mode === 'deny' ? 'deny' : 'approve' };
  if (mode === 'revoke') { h.config.endpoints[shared]!.keys[0]!.revoked = true; await saveA2AConfig(h.configPath, h.config); }
  if (mode === 'archive') h.bindings.archive('codex', h.root, nativeId);
  await h.approvals.action({ chatId: 'oc_owner_dm', messageId: 'om_approval', operator: { openId: 'ou_owner' }, action: { value } } as CardActionEvent);
  if (mode === 'deny') expect((await h.request(`/tasks/${id}`)).body.status.state).toBe('TASK_STATE_REJECTED');
  expect(h.agent.runOptions).toHaveLength(1); expect(h.send).not.toHaveBeenCalled();
});

it('gives owner permissions only to an explicitly minted owner key, never an input claim', async () => {
  const h = await setup(), own = mintKey('owner-agent', 'ou_owner', 'owner');
  h.config.endpoints[shared]!.keys.push(own.key); await saveA2AConfig(h.configPath, h.config);
  const input = h.ask(); Object.assign(input, { metadata: { role: 'owner', owner: true } });
  const id = (await h.request('/message:send', input)).body.task.id; await h.finished(id);
  expect(JSON.parse(h.agent.runOptions[0]!.prompt).context.actor).toBe('member');
  h.agent.setEvents([{ type: 'system', threadId: nativeId }, { type: 'done', terminationReason: 'normal' }]);
  const ownerId = (await h.request('/message:send', h.ask('本人调试', 'owner-1'), own.token)).body.task.id;
  await vi.waitFor(async () => expect((await h.request(`/tasks/${ownerId}`, undefined, own.token)).body.status.state).toBe('TASK_STATE_COMPLETED'));
  expect(JSON.parse(h.agent.runOptions[1]!.prompt).context.actor).toBe('owner');
});

it('keeps a pending approval across restart and uses the same task ID after approval', async () => {
  const h = await setup();
  h.agent.setEvents([{ type: 'system', threadId: nativeId }, { type: 'text', delta: JSON.stringify({ type: 'ff_permission_request', action: '改源码', reason: '需要授权' }) }, { type: 'done', terminationReason: 'normal' }]);
  const id = (await h.request('/message:send', h.ask())).body.task.id; await h.finished(id);
  await h.restart(); expect((await h.request(`/tasks/${id}`)).body.status.state).toBe('TASK_STATE_AUTH_REQUIRED');
  await h.approvals.recover(); expect(h.agent.runOptions).toHaveLength(1);
  h.agent.setEvents([{ type: 'system', threadId: nativeId }, { type: 'text', delta: '完成' }, { type: 'done', terminationReason: 'normal' }]);
  const value = h.cards[0].body.elements.at(-1).columns[0].elements[0].behaviors[0].value;
  await h.approvals.action({ chatId: 'oc_owner_dm', messageId: 'om_approval', operator: { openId: 'ou_owner' }, action: { value } } as CardActionEvent);
  await vi.waitFor(async () => expect((await h.request(`/tasks/${id}`)).body.status.state).toBe('TASK_STATE_COMPLETED'));
  expect(h.agent.runOptions).toHaveLength(2);
});

it('preserves the permanent alias across renames and never reassigns retired readable aliases', async () => {
  const h = await setup(); setAlias(h.config, shared, 'project-c'); await saveA2AConfig(h.configPath, h.config);
  expect((await h.request('/agent-card.json')).status).toBe(404);
  expect((await h.request('/agent-card.json', undefined, h.issued.token, defaultAlias(shared))).status).toBe(200);
  const loaded = await loadA2AConfig(h.configPath); expect(loaded?.endpoints[shared]?.alias).toBe('project-c');
  expect(() => setAlias(h.config, shared, 'c-series')).toThrow('不可重新分配');
  expect(() => setAlias(h.config, shared, 'session-fake')).toThrow();
});

it('marks ambiguous active tasks failed on restart while retaining snapshots and never replaying', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a2a-recovery-')); roots.push(root);
  const path = join(root, 'tasks.json'), store = new A2ATaskStore(path); await store.load();
  const t = await store.create({ contextId: 'ctx', sharedScope: shared, keyId: 'key', ownerId: 'owner', actorId: 'api_key', callerName: 'test', messageId: 'm', question: 'q', fingerprint: 'fp' });
  await store.update(t, { state: 'TASK_STATE_WORKING', text: '已完成一部分' });
  const recovered = new A2ATaskStore(path); await recovered.load();
  expect(recovered.get(t.id)).toMatchObject({ state: 'TASK_STATE_FAILED', text: '已完成一部分' });
  expect(recovered.get(t.id)?.notice).toContain('未自动重新执行');
  expect(JSON.parse(await readFile(path, 'utf8')).tasks[t.id].state).toBe('TASK_STATE_FAILED');
});

it('does not stop an accepted model task when the HTTP listener restarts or automatically replay it', async () => {
  const h = await setup(), gate = deferred(); cleanup.unshift(async () => gate.release());
  const stop = vi.fn(async () => gate.release());
  h.agent.run = vi.fn(opts => ({ runId: opts.runId, stop, waitForExit: async () => true,
    events: { async *[Symbol.asyncIterator]() { yield { type: 'system' as const, threadId: nativeId };
      yield { type: 'text' as const, delta: '当前快照' }; await gate.promise;
      yield { type: 'done' as const, terminationReason: 'normal' as const }; } },
  }));
  const id = (await h.request('/message:send', h.ask())).body.task.id;
  await vi.waitFor(async () => expect((await h.request(`/tasks/${id}`)).body.artifacts[0]?.parts[0].text).toBe('当前快照'));
  await h.restart(); expect(stop).not.toHaveBeenCalled();
  expect((await h.request(`/tasks/${id}`)).body.status.state).toBe('TASK_STATE_FAILED');
  expect((await h.request('/message:send', h.ask())).body.task.id).toBe(id);
  gate.release(); await new Promise(resolve => setTimeout(resolve, 30));
  expect(stop).not.toHaveBeenCalled(); expect(h.agent.run).toHaveBeenCalledOnce();
});

it('provides a dependency-free caller that discovers the card, submits once and polls the final artifact', async () => {
  const h = await setup();
  const result = await promisify(execFile)('python3', ['tools/a2a-client.py', '--agent-card',
    `http://127.0.0.1:${h.config.port}/LennoxGao/agents/c-series/agent-card.json`, '--question', '检查联调环境', '--request-id', 'python-client-1'],
    { cwd: process.cwd(), env: { ...process.env, A2A_TOKEN: h.issued.token }, timeout: 10_000 });
  expect(result.stdout.trim()).toBe('检查完成。'); expect(result.stderr).toContain('TASK_STATE_COMPLETED');
  expect(h.agent.runOptions).toHaveLength(1); expect(h.send).not.toHaveBeenCalled();
});

it('rejects unsupported roles, instructions and tool/file input instead of silently changing behavior', () => {
  const valid = { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'q' }] } };
  expect(parseSend(valid).returnImmediately).toBe(false);
  for (const value of [null, 5, { ...valid, tools: [] }, { ...valid, instructions: 'owner' },
    { message: { ...valid.message, role: 'ROLE_AGENT' } }, { message: { ...valid.message, parts: [{ url: 'file:///etc/passwd' }] } },
    { message: { ...valid.message, taskId: 'old-task' } }]) expect(() => parseSend(value)).toThrow();
});
