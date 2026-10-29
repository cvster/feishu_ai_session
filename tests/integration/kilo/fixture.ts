import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach } from 'vitest';
import { KiloAdapter } from '../../../src/agent/kilo/adapter';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
export async function fixture(kind = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'kilo-protocol-')); roots.push(root);
  const path = join(root, 'cli.cjs'), calls = join(root, 'calls.jsonl'), state = join(root, 'state.json');
  const seeded: any = { sessions: { ses_source: { id: 'ses_source', title: 'AA-Kilo', directory: root,
    time: { created: 1, updated: 2 }, model: { providerID: 'original', id: 'model/path', variant: 'native-level' } } }, messages: {},
    config: { model: 'other/model' }, providers: { connected: ['original', 'other'], default: { original: 'model/path', other: 'model' }, all: [
      { id: 'original', name: 'Provider', options: { apiKey: 'NEVER_EXPOSE_KEY' }, models: { 'model/path': { id: 'model/path', name: 'Model', variants: { 'native-level': {}, low: {} } } } },
      { id: 'other', name: 'Provider', models: { model: { id: 'model', name: 'Model', variants: { high: {} } } } },
    ] } };
  // 'busy': another entry really runs a turn; 'stale-busy': the status entry outlived its
  // finished turn; 'abandoned': the turn died mid-flight long ago; 'queued': running now but
  // ending while the bridge waits.
  const now = Date.now();
  const running = (age = 2000) => [{ info: { id: 'msg_foreign_user', role: 'user', sessionID: 'ses_source', time: { created: now - age } }, parts: [] }];
  const finished = [...running(), { info: { id: 'msg_foreign_answer', role: 'assistant', sessionID: 'ses_source', parentID: 'msg_foreign_user',
    modelID: 'model/path', providerID: 'original', time: { created: now - 1500, completed: now - 1000 } }, parts: [] }];
  if (kind === 'busy') seeded.messages.ses_source = running();
  if (kind === 'abandoned') seeded.messages.ses_source = running(20 * 60_000);
  if (kind === 'stale-busy') seeded.messages.ses_source = finished;
  if (kind === 'queued') seeded.messages.ses_source = running();
  await writeFile(state, JSON.stringify(seeded));
  await writeFile(path, `
    const fs = require('node:fs'), http = require('node:http');
    if (process.argv.includes('--version')) { console.log('7.8.8'); process.exit(); }
    const statePath = ${JSON.stringify(state)}, callsPath = ${JSON.stringify(calls)}, kind = ${JSON.stringify(kind)};
    const load = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const save = value => fs.writeFileSync(statePath, JSON.stringify(value));
    let streams = [], seq = 0, statusReads = 0;
    const emit = (type, properties, id) => {
      const payload = { id: id || 'evt_'+(++seq), type, properties };
      for (const stream of streams) stream.write('data: '+JSON.stringify(stream.globalEvent ? { directory: ${JSON.stringify(root)}, payload } : payload)+'\\n\\n');
    };
    const server = http.createServer(async (req, res) => {
      if (req.headers.authorization !== 'Basic '+Buffer.from('kilo:'+process.env.KILO_SERVER_PASSWORD).toString('base64')) { res.writeHead(401); res.end(); return; }
      const url = new URL(req.url, 'http://localhost'), pathname = url.pathname;
      let body = ''; for await (const c of req) body += c;
      body = body ? JSON.parse(body) : undefined;
      fs.appendFileSync(callsPath, JSON.stringify({ method: req.method, path: pathname, query: Object.fromEntries(url.searchParams), body, authenticated: true })+'\\n');
      const s = load(), reply = value => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(value)); };
      if (pathname === '/event' || pathname === '/global/event') { res.globalEvent = pathname === '/global/event'; res.writeHead(200, { 'Content-Type':'text/event-stream' }); res.write('data: {"type":"server.connected"}\\n\\n'); streams.push(res); req.on('close', () => streams = streams.filter(r => r !== res)); return; }
      if (pathname === '/provider') return reply(s.providers);
      if (pathname === '/config') return reply(s.config);
      if (pathname === '/config/model-state') return reply(s.modelState || { recent: [], model: {}, variant: {} });
      if (pathname === '/session/status') {
        if (kind === 'stale-busy' || kind === 'abandoned') return reply({ ses_source: { type: 'busy' } });
        if (kind === 'busy') return reply({ ses_source: { type: 'retry', attempt: 3, next: Date.now() + 60000 } });
        if (kind === 'queued') {
          if (++statusReads <= 2) return reply({ ses_source: { type: 'busy' } });
          const rows = s.messages.ses_source = s.messages.ses_source || [];
          if (rows.at(-1)?.info?.role === 'user') rows.push({ info: { id: 'msg_foreign_answer', role: 'assistant', sessionID: 'ses_source', parentID: rows.at(-1).info.id,
            modelID: 'model/path', providerID: 'original', time: { created: Date.now() - 1000, completed: Date.now() } }, parts: [] });
          save(s); return reply({});
        }
        return reply({});
      }
      if (pathname === '/experimental/session') return reply(Object.values(s.sessions));
      if (pathname === '/session') {
        if (req.method === 'GET') return reply(Object.values(s.sessions));
        const session = { id: 'ses_created', title: body.title, directory: url.searchParams.get('directory'), time: { created: 3, updated: 4 }, ...(body.metadata ? { metadata: body.metadata } : {}) };
        s.sessions[session.id] = session; save(s); return reply(session);
      }
      const match = /^\\/session\\/(ses_[\\w-]+)(.*)$/.exec(pathname);
      if (!match || !s.sessions[match[1]]) { res.writeHead(404); res.end('{}'); return; }
      const id = match[1], suffix = match[2];
      if (!suffix) {
        if (req.method === 'PATCH') { Object.assign(s.sessions[id], body); save(s); }
        return reply(s.sessions[id]);
      }
      if (suffix === '/message') return reply(s.messages[id] || []);
      if (suffix === '/fork') {
        const copy = { ...s.sessions[id], id: 'ses_copy', title: s.sessions[id].title+' (fork)' };
        if (kind === 'fork-without-metadata') delete copy.metadata;
        s.sessions[copy.id] = copy; s.messages[copy.id] = s.messages[id] || []; save(s); return reply(copy);
      }
      if (suffix === '/abort') return reply(true);
      if (suffix === '/prompt_async') {
        if (kind === 'rejected') { res.writeHead(400); return res.end('{}'); }
        res.writeHead(204); res.end();
        const model = body.model || { providerID: 'original', modelID: 'model/path' };
        s.sessions[id].model = { providerID: model.providerID, id: model.modelID, variant: body.variant };
        const user = { id: body.messageID, role: 'user', sessionID: id, model: { ...model, ...(body.variant ? { variant: body.variant } : {}) }, time: { created: 4 } };
        const info = { id: 'msg_answer', role: 'assistant', sessionID: id, parentID: body.messageID, modelID: model.modelID, providerID: model.providerID, ...(body.variant ? { variant: body.variant } : {}), time: { created: 5 } };
        const part = { id: 'prt_answer', type: 'text', sessionID: id, messageID: info.id, text: 'KILO_READY' };
        s.messages[id] = [...(s.messages[id] || []), { info: user, parts: body.parts }, { info, parts: [part] }]; save(s);
        if (kind === 'disconnect') { for (const r of streams) r.destroy(); return; }
        emit('message.updated', { info: { ...info, id: 'msg_foreign', parentID: 'msg_someone_else' } });
        emit('message.part.updated', { sessionID: id, part: { ...part, messageID: 'msg_foreign', text: 'FOREIGN' } });
        emit('session.idle', { sessionID: 'ses_unrelated' });
        emit('message.updated', { sessionID: id, info });
        if (kind === 'interaction') return emit('permission.asked', { sessionID: id, permission: 'bash', id: 'per_request' });
        if (kind === 'wait') return;
        emit('message.part.updated', { sessionID: id, part: { ...part, text: '' } });
        const delta = { sessionID: id, messageID: info.id, partID: part.id, field: 'text', delta: 'KILO_' };
        emit('message.part.delta', delta, 'evt_duplicate'); emit('message.part.delta', delta, 'evt_duplicate');
        emit('message.part.updated', { sessionID: id, part });
        const tool = { id: 'prt_tool', type: 'tool', sessionID: id, messageID: info.id, callID: 'tool_read', tool: 'read', state: { status: 'running', input: { path: 'test' } } };
        emit('message.part.updated', { sessionID: id, part: tool });
        emit('message.part.updated', { sessionID: id, part: { ...tool, state: { status: 'completed', output: 'OK' } } });
        emit('session.turn.close', { sessionID: id, reason: 'completed' });
        return;
      }
      res.writeHead(404); res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => console.log('kilo server listening on http://127.0.0.1:'+server.address().port));
  `);
  const options = { binary: process.execPath, args: [path], dataHome: join(root, 'data') };
  const agent = new KiloAdapter(options);
  const read = async () => (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const update = async (change: (value: any) => void) => { const value = JSON.parse(await readFile(state, 'utf8')); change(value); await writeFile(state, JSON.stringify(value)); };
  return { root, agent, options, read, update };
}
