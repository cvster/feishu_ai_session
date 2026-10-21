import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexThreadReader } from '../../src/session/codex-thread-reader.js';

describe('CodexThreadReader', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('reuses one app-server process for multiple thread reads', async () => {
    const fake = await createFakeCodex();
    cleanup.push(fake.dir);
    const reader = new CodexThreadReader({
      binary: fake.path,
      profileStateDir: fake.dir,
      inheritCodexHome: true,
      timeoutMs: 2_000,
    });

    await expect(reader.readThread('thread-a')).resolves.toMatchObject({
      id: 'thread-a',
      turns: [{ id: 'turn-thread-a', status: 'completed' }],
    });
    await expect(reader.readThread('thread-b')).resolves.toMatchObject({
      id: 'thread-b',
      turns: [{ id: 'turn-thread-b', status: 'completed' }],
    });
    await expect(reader.listRecentThreads()).resolves.toEqual([
      { id: 'thread-b', updatedAtMs: 12_000 },
    ]);
    await reader.stop();

    const starts = (await readFile(fake.startsPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
    expect(starts).toHaveLength(1);
  });

  it('queries all archived pages through public read-only RPC without resuming a thread', async () => {
    const fake = await createFakeCodex(); cleanup.push(fake.dir);
    const reader = new CodexThreadReader({ binary: fake.path, profileStateDir: fake.dir, inheritCodexHome: true, timeoutMs: 2_000 });
    try { await expect(reader.listArchivedThreadIds()).resolves.toEqual(['archived-a', 'archived-b']); }
    finally { await reader.stop(); }
    const requests = (await readFile(fake.requestsPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const lists = requests.filter((r) => r.method === 'thread/list');
    expect(lists.map((r) => r.params.cursor ?? null)).toEqual([null, 'page-2']);
    expect(lists.every((r) => r.params.archived === true && r.params.useStateDbOnly === true)).toBe(true);
    expect(lists.every((r) => JSON.stringify(r.params.sourceKinds) === JSON.stringify(['cli', 'vscode', 'exec', 'appServer', 'unknown']))).toBe(true);
    expect(requests.some((r) => ['thread/resume', 'thread/start', 'turn/start'].includes(r.method))).toBe(false);
  });

  it('isolates a damaged history RPC rejection from concurrent archive lookup and healthy thread reads', async () => {
    const fake = await createFakeCodex(null, true); cleanup.push(fake.dir);
    const reader = new CodexThreadReader({ binary: fake.path, profileStateDir: fake.dir, inheritCodexHome: true, timeoutMs: 2_000 });
    try {
      await reader.connect();
      const [bad, archives, healthy] = await Promise.allSettled([
        reader.readThread('damaged-history'), reader.listArchivedThreadIds(), reader.readThread('healthy-thread'),
      ]);
      expect(bad).toMatchObject({ status: 'rejected', reason: { message: 'invalid paginated history lineage: source rollout is not paginated' } });
      expect(archives).toEqual({ status: 'fulfilled', value: ['archived-a', 'archived-b'] });
      expect(healthy).toMatchObject({ status: 'fulfilled', value: { id: 'healthy-thread' } });
      await expect(reader.listArchivedThreadIds()).resolves.toEqual(['archived-a', 'archived-b']);
    } finally { await reader.stop(); }
    expect((await readFile(fake.startsPath, 'utf8')).trim().split(/\r?\n/)).toHaveLength(1);
  });

  it('isolates a recent-list RPC rejection without resetting concurrent read-only requests', async () => {
    const fake = await createFakeCodex(null, true); cleanup.push(fake.dir);
    const reader = new CodexThreadReader({ binary: fake.path, profileStateDir: fake.dir, inheritCodexHome: true, timeoutMs: 2_000 });
    try {
      await reader.connect();
      const [list, archives] = await Promise.allSettled([reader.listRecentThreads(1), reader.listArchivedThreadIds()]);
      expect(list).toMatchObject({ status: 'rejected', reason: { message: 'thread list rejected' } });
      expect(archives).toEqual({ status: 'fulfilled', value: ['archived-a', 'archived-b'] });
    } finally { await reader.stop(); }
    expect((await readFile(fake.startsPath, 'utf8')).trim().split(/\r?\n/)).toHaveLength(1);
  });

  it('still resets and recovers the owned reader after a transport timeout', async () => {
    const fake = await createFakeCodex(); cleanup.push(fake.dir);
    const reader = new CodexThreadReader({ binary: fake.path, profileStateDir: fake.dir, inheritCodexHome: true, timeoutMs: 150 });
    try {
      await reader.connect();
      await expect(reader.readThread('timeout-thread')).rejects.toThrow('timed out');
      await expect(reader.listArchivedThreadIds()).resolves.toEqual(['archived-a', 'archived-b']);
    } finally { await reader.stop(); }
    expect((await readFile(fake.startsPath, 'utf8')).trim().split(/\r?\n/)).toHaveLength(2);
  });

  it.each(['AA-test (8)', null, 'AA-test'])('forks through app-server and preserves or completes its name: %s', async (name) => {
    const fake = await createFakeCodex(name);
    cleanup.push(fake.dir);
    const reader = new CodexThreadReader({ binary: fake.path, profileStateDir: fake.dir, inheritCodexHome: true, timeoutMs: 2_000 });
    try {
      await expect(reader.forkThread('source')).resolves.toEqual({
        threadId: 'fork', name: name === 'AA-test (8)' ? name : 'AA-test (3)', cwd: fake.dir,
      });
    } finally { await reader.stop(); }
    const requests = (await readFile(fake.requestsPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(requests.find((request) => request.method === 'thread/fork')?.params)
      .toEqual({ threadId: 'source', excludeTurns: true, deferGoalContinuation: true });
    expect(requests.some((request) => request.method === 'thread/resume' || request.method === 'turn/interrupt')).toBe(false);
    const rename = requests.find((request) => request.method === 'thread/name/set');
    if (name === 'AA-test (8)') expect(rename).toBeUndefined();
    else expect(rename?.params).toEqual({ threadId: 'fork', name: 'AA-test (3)' });
  });
});

async function createFakeCodex(forkName: string | null = null, delaySuccess = false): Promise<{ dir: string; path: string; startsPath: string; requestsPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'codex-thread-reader-'));
  const startsPath = join(dir, 'starts.txt');
  const requestsPath = join(dir, 'requests.jsonl');
  const scriptPath = join(dir, 'fake-app-server.mjs');
  const path = process.platform === 'win32' ? join(dir, 'codex.cmd') : scriptPath;
  const script = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
appendFileSync(${JSON.stringify(startsPath)}, process.pid + '\\n');
const send = (value) => {
  const write = () => process.stdout.write(JSON.stringify(value) + '\\n');
  if (${delaySuccess} && !value.error) setTimeout(write, 20); else write();
};
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const request = JSON.parse(line);
  appendFileSync(${JSON.stringify(requestsPath)}, line + '\\n');
  if (request.method === 'initialize') {
    send({ id: request.id, result: { userAgent: 'fake' } });
    return;
  }
  if (request.method === 'thread/read') {
    const threadId = request.params.threadId;
    if (threadId === 'timeout-thread') return;
    if (threadId === 'damaged-history') {
      send({ id: request.id, error: { code: -32000, message: 'invalid paginated history lineage: source rollout is not paginated' } });
      return;
    }
    send({ id: request.id, result: { thread: {
      id: threadId,
      name: 'AA-test', cwd: ${JSON.stringify(dir)},
      turns: [{ id: 'turn-' + threadId, status: 'completed', items: [] }]
    } } });
    return;
  }
  if (request.method === 'thread/list') {
    if (!request.params.archived && request.params.limit === 1) {
      send({ id: request.id, error: { code: -32000, message: 'thread list rejected' } });
      return;
    }
    if (request.params.archived && !request.params.searchTerm) {
      send({ id: request.id, result: request.params.cursor
        ? { data: [{ id: 'archived-b' }], nextCursor: null }
        : { data: [{ id: 'archived-a' }], nextCursor: 'page-2' } });
      return;
    }
    send({ id: request.id, result: { data: request.params.searchTerm
      ? [{ name: request.params.archived ? 'AA-test (2)' : 'AA-test (1)' }]
      : [{ id: 'thread-b', updatedAt: 12 }] } });
  }
  if (request.method === 'thread/fork') {
    send({ id: request.id, result: { thread: { id: 'fork', name: ${JSON.stringify(forkName)}, cwd: ${JSON.stringify(dir)} } } });
  }
  if (request.method === 'thread/name/set') {
    send({ id: request.id, result: {} });
  }
});
`;
  await writeFile(scriptPath, script, 'utf8');
  if (process.platform === 'win32') {
    await writeFile(path, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
  } else {
    await chmod(path, 0o755);
  }
  return { dir, path, startsPath, requestsPath };
}
