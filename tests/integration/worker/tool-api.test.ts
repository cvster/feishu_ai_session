import { readFile, writeFile, truncate, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { fixture } from '../../helpers/worker-fixture';
import type { WorkerSessionService } from '../../../src/worker/protocol';
import { WorkerClient, WorkerRequestError } from '../../../src/worker/client';
import { WorkerSessionClient } from '../../../src/worker/session-client';
import { exportWorkerHistory } from '../../../src/worker/sessions';
import { DurableAgentAdapter } from '../../../src/worker/adapter';
import { ZcodeAdapter } from '../../../src/agent/zcode/adapter';

const session = { nativeId: 'opaque:id_1', name: 'AA-native', cwd: '/project', createdAtMs: 1, updatedAtMs: 2 };
function service(): WorkerSessionService {
  return { list: vi.fn(async () => [session]),
    history: vi.fn(async id => ({ nativeId: id, format: 'jsonl' as const, content: '{"type":"user"}\n' })),
    rename: vi.fn(async () => {}), archive: vi.fn(async () => {}),
    fork: vi.fn(async () => ({ nativeId: 'copy:id', name: 'AA-copy', cwd: session.cwd })) };
}
async function endpoint(stateDir: string) {
  const e = JSON.parse(await readFile(join(stateDir, 'endpoint.json'), 'utf8'));
  return { url: e.url as string, headers: { Authorization: `Bearer ${e.token}`, 'Content-Type': 'application/json' } };
}

it.each(['claude', 'kilo', 'zcode', 'dsh'] as const)('uses the same model/session/task contract for %s without provider-ID assumptions', async tool => {
  const sessions = service(), h = await fixture(tool, sessions);
  const listModels = vi.fn(async () => [{ value: 'native:model', label: 'Native' }]);
  const stopNativeTurn = vi.fn(async () => true);
  Object.assign(h.raw, { listModels, stopNativeTurn });
  const caps = await h.client.capabilities();
  expect(caps).toEqual({ apiVersion: 2, jobs: { submit: true, read: true, stop: true, eventCursor: true },
    models: true, sessions: { list: true, history: true, rename: true, archive: true, fork: true }, nativeTurnStop: true });
  const e = await endpoint(h.stateDir);
  expect(await (await fetch(`${e.url}/capabilities`, { headers: e.headers })).json()).toEqual(caps);
  expect(await h.adapter.listModels({ cwd: h.dir })).toEqual([{ value: 'native:model', label: 'Native' }]);
  expect(listModels).toHaveBeenCalledWith({ cwd: h.dir });
  expect(await h.client.listSessions()).toEqual([session]);
  expect(await h.client.sessionHistory(session.nativeId)).toMatchObject({ nativeId: session.nativeId, format: 'jsonl' });
  await h.client.renameSession(session.nativeId, 'AA-renamed');
  await h.client.archiveSession(session.nativeId);
  expect(await h.client.forkSession(session.nativeId)).toMatchObject({ nativeId: 'copy:id' });
  expect(await h.client.stopNativeTurn(session.nativeId, 'turn:1', h.dir)).toBe(true);
  expect(sessions.rename).toHaveBeenCalledWith(session.nativeId, 'AA-renamed', undefined);
  expect(sessions.archive).toHaveBeenCalledWith(session.nativeId);
  expect(stopNativeTurn).toHaveBeenCalledWith(session.nativeId, 'turn:1', h.dir);
  expect(h.calls).toHaveLength(0);
});

it('reports unsupported operations consistently and never invokes an adapter', async () => {
  const h = await fixture('dsh'), e = await endpoint(h.stateDir);
  expect((await h.client.capabilities())?.sessions).toEqual({ list: false, history: false, rename: false, archive: false, fork: false });
  for (const [method, path, body] of [['GET', '/models'], ['GET', '/sessions'], ['GET', '/sessions/id/history'],
    ['POST', '/sessions/id/archive', {}], ['POST', '/sessions/id/fork', {}], ['POST', '/sessions/id/rename', { name: 'new' }],
    ['POST', '/sessions/id/turn-stop', { turnId: 'turn', cwd: h.dir }]] as const) {
    const r = await fetch(`${e.url}${path}`, { method, headers: e.headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(r.status).toBe(501);
    expect(await r.json()).toMatchObject({ code: 'unsupported-operation', retryable: false });
  }
  await expect(h.client.archiveSession('id')).rejects.toMatchObject({ status: 501, code: 'unsupported-operation' });
  expect(h.calls).toHaveLength(0);
});

it('requires authentication and validates request bodies before invoking metadata operations', async () => {
  const sessions = service(), h = await fixture('claude', sessions), e = await endpoint(h.stateDir);
  expect((await fetch(`${e.url}/sessions`)).status).toBe(401);
  for (const body of ['{', 'null', '[]', '{"name":""}', '{"name":"n","cwd":false}']) {
    const r = await fetch(`${e.url}/sessions/id/rename`, { method: 'POST', headers: e.headers, body });
    expect(r.status).toBe(400); expect(await r.json()).toMatchObject({ code: 'invalid-request', retryable: false });
  }
  const malformedJob = await fetch(`${e.url}/jobs`, { method: 'POST', headers: e.headers, body: '{' });
  expect(malformedJob.status).toBe(400);
  expect(sessions.rename).not.toHaveBeenCalled(); expect(h.calls).toHaveLength(0);
  await expect(new WorkerClient(h.stateDir, 'wrong', 'cli_test', 'claude').listSessions()).rejects.toThrow('不匹配');
  expect(sessions.list).not.toHaveBeenCalled();
});

it('blocks mutations of a newly discovered active native session but permits history and other sessions', async () => {
  const sessions = service(), h = await fixture('kilo', sessions);
  const job = await h.client.submit({ requestKey: 'fresh', options: { ...h.options, initialSessionId: undefined } });
  await vi.waitFor(async () => expect((await h.client.snapshot(job.id)).events.some(row => row.event.type === 'system')).toBe(true));
  await expect(h.client.renameSession('native', 'changed')).rejects.toMatchObject({ status: 429, code: 'busy', retryable: true });
  await expect(h.client.archiveSession('native')).rejects.toMatchObject({ status: 429 });
  await expect(h.client.forkSession('native')).rejects.toMatchObject({ status: 429 });
  expect(await h.client.sessionHistory('native')).toMatchObject({ nativeId: 'native' });
  await h.client.renameSession('other', 'changed');
  expect(sessions.rename).toHaveBeenCalledOnce(); expect(h.stop).not.toHaveBeenCalled();
  await h.client.stop(job.id); h.finish();
});

it('keeps paired execution connections intact while allowing independent history reads', async () => {
  const sessions = service(), h = await fixture('zcode', sessions);
  Object.assign(h.raw, { desktopRemoteEnabled: true, listModels: vi.fn(async () => []) });
  const job = await h.client.submit({ requestKey: 'paired', options: h.options });
  await vi.waitFor(() => expect(h.calls).toHaveLength(1));
  await expect(h.client.renameSession('other', 'changed')).rejects.toMatchObject({ status: 429 });
  await expect(h.client.models(h.dir)).rejects.toMatchObject({ status: 429 });
  expect(await h.client.sessionHistory('native')).toMatchObject({ nativeId: 'native' });
  expect(await h.client.listSessions()).toEqual([session]);
  expect(h.stop).not.toHaveBeenCalled(); expect(sessions.rename).not.toHaveBeenCalled();
  await h.client.stop(job.id); h.finish();
});

it('does not fall back or repeat a mutation after its acknowledgement is lost', async () => {
  const sessions = service(), h = await fixture('zcode', sessions);
  const originalFetch = globalThis.fetch;
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const response = await originalFetch(input, init);
    if (String(input).endsWith('/rename')) return new Response(JSON.stringify({ error: 'ack lost', code: 'unavailable' }), { status: 503 });
    return response;
  });
  try {
    await expect(h.client.renameSession('native', 'new')).rejects.toMatchObject({ status: 503 });
    expect(sessions.rename).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/session-name'))).toBe(false);
  } finally { fetchMock.mockRestore(); }
});

it('keeps paired-transport validation before unified models and session writes', async () => {
  const sessions = service(), h = await fixture('zcode', sessions);
  Object.assign(h.raw, { listModels: vi.fn(async () => []) });
  const adapter = new DurableAgentAdapter(h.client, new ZcodeAdapter({ remoteControlFile: '/private/pair.link' }));
  await expect(adapter.listModels({ cwd: h.dir })).rejects.toThrow('桌面配对模式与配置不一致');
  const legacy = { historyPath: async () => undefined, rename: async () => {}, archive: async () => {} };
  const proxy = new WorkerSessionClient(h.client, async () => [], legacy, join(h.dir, 'cache'), () => adapter.prepareRun());
  await expect(proxy.rename('native', 'new')).rejects.toThrow('桌面配对模式与配置不一致');
  await expect(proxy.archive('native')).rejects.toThrow('桌面配对模式与配置不一致');
  expect(h.raw.listModels).not.toHaveBeenCalled(); expect(sessions.rename).not.toHaveBeenCalled(); expect(sessions.archive).not.toHaveBeenCalled();
});

it('exports bounded native history without accepting file paths or partial JSONL tails', async () => {
  const h = await fixture();
  const path = join(h.dir, 'records.jsonl'); await writeFile(path, '{"type":"user"}\n{"partial"');
  const provider = { historyMode: 'file' as const, historyPath: vi.fn(async () => path), rename: async () => {}, archive: async () => {} };
  expect(await exportWorkerHistory(provider, 'native')).toEqual({ nativeId: 'native', format: 'jsonl', content: '{"type":"user"}\n' });
  await truncate(path, 32 * 1024 * 1024 + 1);
  await expect(exportWorkerHistory(provider, 'native')).rejects.toMatchObject({ status: 413 });
  const link = join(h.dir, 'symlink'); await symlink(path, link);
  provider.historyPath.mockResolvedValue(link);
  await expect(exportWorkerHistory(provider, 'native')).rejects.toThrow();
});

it('uses worker session APIs and caches validated records for existing consumers', async () => {
  const sessions = service(), h = await fixture('claude', sessions);
  const legacy = { historyMode: 'file' as const, historyPath: vi.fn(async () => undefined), rename: vi.fn(async () => {}),
    archive: vi.fn(async () => {}), fork: vi.fn(async () => ({ nativeId: 'legacy-copy', name: 'copy', cwd: h.dir })) };
  const list = vi.fn(async () => []);
  const client = new WorkerSessionClient(h.client, list, legacy, join(h.dir, 'cache'));
  expect(await client.listSessions()).toEqual([session]);
  const path = await client.historyPath(session.nativeId); expect(await readFile(path!, 'utf8')).toBe('{"type":"user"}\n');
  await client.rename(session.nativeId, 'new'); await client.archive(session.nativeId);
  expect(await client.fork!(session.nativeId)).toMatchObject({ nativeId: 'copy:id' });
  expect(list).not.toHaveBeenCalled(); expect(legacy.rename).not.toHaveBeenCalled(); expect(legacy.archive).not.toHaveBeenCalled();
  vi.mocked(sessions.history).mockResolvedValue({ nativeId: 'wrong', format: 'jsonl', content: 'secret' });
  await expect(client.historyPath(session.nativeId)).rejects.toThrow('incompatible');
});

it('chooses old-worker compatibility before writes and retains catalog-only archival', async () => {
  const h = await fixture('zcode');
  vi.spyOn(h.client, 'health').mockResolvedValue({ zcodeSessionNames: true });
  const legacy = { nativeArchive: false, historyPath: vi.fn(async () => undefined),
    rename: vi.fn(async () => {}), archive: vi.fn(async () => {}) };
  const list = vi.fn(async () => [session]);
  const proxy = new WorkerSessionClient(h.client, list, legacy, join(h.dir, 'cache'));
  expect(await proxy.listSessions()).toEqual([session]);
  await proxy.rename('native', 'new'); await proxy.archive('native');
  expect(legacy.rename).toHaveBeenCalledOnce(); expect(legacy.archive).toHaveBeenCalledOnce();
  const request = vi.spyOn(globalThis, 'fetch');
  try {
    await expect(h.client.renameSession('native', 'new', h.dir)).rejects.toBeInstanceOf(WorkerRequestError);
    expect(request.mock.calls.filter(([path]) => String(path).endsWith('/session-name'))).toHaveLength(1);
    expect(request.mock.calls.some(([path]) => String(path).endsWith('/rename'))).toBe(false);
  } finally { request.mockRestore(); }
});
