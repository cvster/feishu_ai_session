import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { fixture } from './fixture';
import { KiloAdapter } from '../../../src/agent/kilo/adapter';
import { KiloSessionProvider } from '../../../src/tools/kilo-sessions';
import { KiloClient } from '../../../src/agent/kilo/client';
const discovery = vi.hoisted(() => ({ find: vi.fn() }));
vi.mock('../../../src/agent/kilo/editor-server', () => ({ findKiloEditorServer: discovery.find }));
const clean: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of clean.splice(0).reverse()) await f(); discovery.find.mockReset(); });
async function editor(kind = 'normal') {
  const h = await fixture(kind), password = 'test-only-editor-password';
  const child = spawn(process.execPath, [h.options.args[0]!], { env: { ...process.env, KILO_SERVER_PASSWORD: password }, stdio: ['ignore', 'pipe', 'ignore'] });
  clean.push(async () => { const done = new Promise<void>(done => child.once('close', () => done())); child.kill(); await done; });
  const url = await new Promise<string>((accept, reject) => {
    let text = ''; const timer = setTimeout(() => reject(Error('editor startup timeout')), 5000);
    child.stdout.on('data', chunk => { text += chunk; const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(text); if (m) { clearTimeout(timer); accept(m[1]!); } });
    child.once('error', reject);
  });
  const authorization = 'Basic '+Buffer.from('kilo:'+password).toString('base64');
  discovery.find.mockResolvedValue({ url, authorization, pid: child.pid });
  const agent = new KiloAdapter({ binary: '/nonexistent/should-not-spawn-kilo' });
  return { ...h, child, url, authorization, agent };
}
it('uses the editor event bus so both the editor and bridge receive messages, and leaves the editor alive', async () => {
  const h = await editor(); const editorEvents: any[] = [];
  const req = request(h.url+'/global/event', { headers: { Authorization: h.authorization } });
  clean.push(async () => { req.destroy(); });
  await new Promise<void>(done => { req.once('response', res => { let buffer = ''; res.on('data', raw => {
    buffer += raw.toString(); let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) { const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (frame.startsWith('data: ')) editorEvents.push(JSON.parse(frame.slice(6))); }
  }); res.once('data', () => done()); }); req.end(); });
  const run = h.agent.run({ runId: 'shared', cwd: h.root, sessionId: 'ses_source', prompt: 'from Feishu' });
  let text = ''; for await (const event of run.events) if (event.type === 'text') text += event.delta;
  expect(await run.waitForExit(3000)).toBe(true); expect(text).toBe('KILO_READY');
  expect(editorEvents.some(e => e.directory === h.root && e.payload?.type === 'message.part.updated')).toBe(true);
  expect(editorEvents.some(e => e.payload?.type === 'message.updated' && e.payload.properties.info.role === 'assistant')).toBe(true);
  expect(h.child.exitCode).toBeNull(); expect(h.child.killed).toBe(false);
  const client = new KiloClient({ binary: '/nonexistent/should-not-spawn-kilo' }, h.root);
  try { expect(await client.request('GET', '/config', undefined, h.root)).toEqual({ model: 'other/model' }); } finally { await client.close(); }
  expect(h.child.killed).toBe(false);
});
it('stops only its submitted session on an attached editor and preserves the editor process', async () => {
  const h = await editor('wait'); const run = h.agent.run({ runId: 'stop', cwd: h.root, sessionId: 'ses_source', prompt: 'wait' });
  for await (const event of run.events) if (event.type === 'system') setTimeout(() => void run.stop(), 100);
  expect(await run.waitForExit(3000)).toBe(true);
  expect((await h.read()).find(c => c.path.endsWith('/abort'))).toMatchObject({ path: '/session/ses_source/abort', query: { scope: 'session' } });
  expect(h.child.killed).toBe(false);
});
it('rejects an editor-busy session without prompting it or spawning a second server', async () => {
  const h = await editor('busy'); const run = h.agent.run({ runId: 'busy', cwd: h.root, sessionId: 'ses_source', prompt: 'must not run' });
  const events = []; for await (const e of run.events) events.push(e);
  expect(events.at(-1)).toMatchObject({ type: 'error' }); expect(await run.waitForExit(3000)).toBe(true);
  expect((await h.read()).some(c => c.path.endsWith('/prompt_async'))).toBe(false); expect(h.child.killed).toBe(false);
});
it('does not fall back to another server after editor discovery fails', async () => {
  discovery.find.mockRejectedValue(Error('editor unavailable'));
  const client = new KiloClient({ binary: '/nonexistent/should-not-spawn-kilo' }, '/workspace');
  try { await expect(client.request('GET', '/config')).rejects.toThrow('editor unavailable'); } finally { await client.close(); }
  const run = new KiloAdapter({ binary: '/nonexistent/should-not-spawn-kilo' }).run({ runId: 'failed', cwd: '/workspace', prompt: 'must not run' });
  const events = []; for await (const event of run.events) events.push(event);
  expect(events.at(-1)).toMatchObject({ type: 'error', message: 'editor unavailable', submissionStatus: 'rejected' });
  expect(await run.waitForExit(3000)).toBe(true);
});

it('creates fresh desktop sessions with native workspace metadata and routes existing runs by source ID', async () => {
  const h = await editor();
  const metadata = { 'kilo-desktop': { workspaceId: 'desktop-workspace', workspaceFolders: [{ path: h.root }] } };
  discovery.find.mockResolvedValue({ url: h.url, authorization: h.authorization, pid: h.child.pid, client: 'desktop', sessionMetadata: metadata });
  const run = h.agent.run({ runId: 'desktop-fresh', cwd: h.root, prompt: 'from Feishu' });
  const events = []; for await (const event of run.events) events.push(event);
  expect(events.at(-1)).toMatchObject({ type: 'done', sessionId: 'ses_created' });
  expect((await h.read()).find(c => c.method === 'POST' && c.path === '/session').body.metadata).toEqual(metadata);
  const resumed = h.agent.run({ runId: 'desktop-resume', cwd: h.root, sessionId: 'ses_created', prompt: 'again' });
  for await (const _ of resumed.events) { /* consume */ }
  expect(discovery.find).toHaveBeenLastCalledWith('/nonexistent/should-not-spawn-kilo', h.root, undefined, {}, 'ses_created', undefined);
  expect(h.child.killed).toBe(false);
});
it('rejects new desktop sessions without a native workspace instead of creating an invisible conversation', async () => {
  const h = await editor();
  discovery.find.mockResolvedValue({ url: h.url, authorization: h.authorization, pid: h.child.pid, client: 'desktop' });
  const run = h.agent.run({ runId: 'desktop-missing-workspace', cwd: h.root, prompt: 'must not run' });
  const events = []; for await (const event of run.events) events.push(event);
  expect(events.at(-1)).toMatchObject({ type: 'error', submissionStatus: 'rejected', message: expect.stringContaining('桌面 App') });
  expect((await h.read()).some(c => c.method === 'POST' && (c.path === '/session' || c.path.endsWith('/prompt_async')))).toBe(false);
  expect(h.child.killed).toBe(false);
});
it('scopes desktop rename/archive events to the native project and preserves workspace metadata on copies', async () => {
  const h = await editor('fork-without-metadata');
  const metadata = { 'kilo-desktop': { workspaceId: 'desktop-workspace', workspaceFolders: [{ path: h.root }] } };
  await h.update(s => { s.sessions.ses_source.metadata = metadata; });
  discovery.find.mockResolvedValue({ url: h.url, authorization: h.authorization, pid: h.child.pid, client: 'desktop', sessionMetadata: metadata });
  const sessions = new KiloSessionProvider({ binary: '/nonexistent/should-not-spawn-kilo' }, h.root);
  await sessions.rename('ses_source', 'AA-renamed');
  const copy = await sessions.fork('ses_source'); expect(copy.nativeId).toBe('ses_copy');
  await sessions.archive(copy.nativeId);
  const calls = await h.read(), changes = calls.filter(c => c.method === 'PATCH');
  expect(changes.length).toBe(3); expect(changes.every(c => c.query.directory === h.root)).toBe(true);
  expect(changes.find(c => c.body.metadata)?.body.metadata).toEqual(metadata);
  expect(calls.some(c => c.path.endsWith('/prompt_async'))).toBe(false);
  expect(h.child.killed).toBe(false);
});

it('passes the configured client preference through native connection discovery', async () => {
  const h = await editor();
  const client = new KiloClient({ binary: '/nonexistent/should-not-spawn-kilo', preferredClient: 'desktop' }, h.root);
  try {
    await client.request('GET', '/config');
    expect(discovery.find).toHaveBeenCalledWith('/nonexistent/should-not-spawn-kilo', h.root, undefined, {}, undefined, 'desktop');
  } finally { await client.close(); }
  expect(h.child.killed).toBe(false);
});
