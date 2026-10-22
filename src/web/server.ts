import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loadWebConfig, webSecretHash, type WebConfig } from './config';
import { PersonalSessionService, WebError } from './service';
import { bridgeWebPage } from '../../apps/bridge-web/page';

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new WebError(415, '仅接受 JSON');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 80_000) throw new WebError(413, '请求过大'); chunks.push(chunk); }
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(); return v; }
  catch { throw new WebError(400, '无效 JSON'); }
}
const respond = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };

/** Cookie auth, writes over HTTP, shared read-only snapshots over SSE. */
export async function startBridgeWeb(options: { configPath: string; service: PersonalSessionService; config?: WebConfig; pollMs?: number }) {
  const initial = options.config ?? await loadWebConfig(options.configPath);
  if (!initial?.enabled) return;
  await options.service.load();
  let closed = false;
  const sessions = new Map<string, { owner: string; hash: string; expires: number }>();
  const failures = new Map<string, { count: number; until: number }>();
  const streams = new Map<ServerResponse, { token: string; id?: string; previous?: string }>();
  const cookie = (req: IncomingMessage) => /(?:^|;\s*)bridge_web=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
  const config = () => options.config ? Promise.resolve(options.config) : loadWebConfig(options.configPath);
  const authenticate = async (token?: string) => {
    const c = await config(), session = token ? sessions.get(token) : undefined;
    if (!c?.enabled || c.host !== initial.host || c.port !== initial.port || !session || session.expires <= Date.now() || session.hash !== c.secretHash) throw new WebError(401, '请重新登录');
    if (session.owner !== options.service.ownerIdentity()) throw new WebError(401, '所有者已变化，请重新登录');
  };
  const server = createServer((req, res) => { void (async () => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const expected = initial.host + ':' + initial.port;
    const allowedHost = req.headers.host === expected || initial.host === '127.0.0.1' && req.headers.host === 'localhost:' + initial.port;
    if (!allowedHost) throw new WebError(403, '访问地址不匹配');
    const origin = 'http://' + req.headers.host;
    if (req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') throw new WebError(403, '禁止跨站访问');
    if (req.method === 'POST' && req.headers.origin !== origin) throw new WebError(403, '请求来源不匹配');
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname === '/' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(bridgeWebPage); return; }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress ?? '', failure = failures.get(ip);
      if (failure && failure.until > Date.now() && failure.count >= 8) throw new WebError(429, '登录尝试过多，请稍后重试');
      const input = await body(req), c = await config();
      const value = typeof input.secret === 'string' && input.secret.length <= 200 ? webSecretHash(input.secret) : '';
      if (!c?.enabled || c.host !== initial.host || c.port !== initial.port || !value || !timingSafeEqual(Buffer.from(value), Buffer.from(c.secretHash))) {
        if (failures.size > 1000) failures.clear();
        failures.set(ip, { count: failure && failure.until > Date.now() ? failure.count + 1 : 1, until: Date.now() + 60_000 });
        throw new WebError(401, '登录码无效');
      }
      const owner = options.service.ownerIdentity();
      failures.delete(ip);
      for (const [t, s] of sessions) if (s.expires < Date.now()) sessions.delete(t);
      if (sessions.size >= 64) sessions.delete(sessions.keys().next().value!);
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { owner, hash: c.secretHash, expires: Date.now() + 12 * 60 * 60_000 });
      res.setHeader('Set-Cookie', `bridge_web=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
      respond(res, 200, { ok: true }); return;
    }
    const token = cookie(req); await authenticate(token);
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      sessions.delete(token!); res.setHeader('Set-Cookie', 'bridge_web=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); respond(res, 200, { ok: true }); return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') { respond(res, 200, await options.service.list()); return; }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      if (streams.size >= 32) throw new WebError(429, '连接数量过多');
      const id = url.searchParams.get('session') ?? undefined;
      if (id && !/^[a-f0-9]{64}$/.test(id)) throw new WebError(400, '会话 ID 无效');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 1500\n\n'); streams.set(res, { token: token!, id });
      res.on('close', () => streams.delete(res)); void poll(); return;
    }
    const match = /^\/api\/sessions\/([a-f0-9]{64})(?:\/(send|rename))?$/.exec(url.pathname);
    if (match && req.method === 'GET' && !match[2]) { respond(res, 200, await options.service.read(match[1]!)); return; }
    if (match && req.method === 'POST') {
      const input = await body(req);
      if (match[2] === 'send' && typeof input.requestId === 'string' && typeof input.text === 'string') { respond(res, 202, await options.service.send(match[1]!, input.requestId, input.text)); return; }
      if (match[2] === 'rename' && typeof input.name === 'string') { respond(res, 200, await options.service.rename(match[1]!, input.name)); return; }
      throw new WebError(400, '请求内容无效');
    }
    throw new WebError(404, '接口不存在');
  })().catch(e => {
    if (res.headersSent) { res.end(); return; }
    respond(res, e instanceof WebError ? e.status : 503, { error: e instanceof WebError ? e.message : '桥接服务暂时不可用，请稍后重试' });
  }); });
  let running: Promise<void> | undefined;
  function poll(): Promise<void> {
    if (running) return running;
    if (closed || !streams.size) return Promise.resolve();
    running = (async () => {
      for (const [res, s] of streams) try { await authenticate(s.token); } catch (e) {
        if (e instanceof WebError && e.status === 401) { res.write('event: auth\ndata: {}\n\n'); res.end(); streams.delete(res); }
        else { res.write('event: unavailable\ndata: {}\n\n'); return; }
      }
      if (!streams.size) return;
      const rows = await options.service.list();
      const snapshots = new Map<string, unknown>();
      await Promise.all([...new Set([...streams.values()].flatMap(s => s.id ? [s.id] : []))].map(async id => {
        try { snapshots.set(id, await options.service.read(id)); }
        catch (e) { snapshots.set(id, { unavailable: true, error: e instanceof WebError ? e.message : '会话暂不可用' }); }
      }));
      for (const [res, s] of streams) {
        if (res.writableLength > 1024 * 1024) { res.end(); streams.delete(res); continue; }
        const data = JSON.stringify({ sessions: rows, ...(s.id ? { conversation: snapshots.get(s.id) } : {}) });
        if (data !== s.previous) { res.write(`event: snapshot\ndata: ${data}\n\n`); s.previous = data; }
        else res.write(': keepalive\n\n');
      }
    })().catch(() => { for (const res of streams.keys()) res.write('event: unavailable\ndata: {}\n\n'); }).finally(() => { running = undefined; });
    return running;
  }
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(initial.port, initial.host, () => { server.off('error', reject); accept(); }); });
  const timer = setInterval(() => void poll(), options.pollMs ?? 1000); timer.unref();
  return { url: `http://${initial.host}:${initial.port}`, async close() {
    closed = true; clearInterval(timer);
    for (const res of streams.keys()) res.end(); streams.clear();
    const closing = new Promise<void>(accept => server.close(() => accept()));
    server.closeIdleConnections(); await closing; await running;
  } };
}
