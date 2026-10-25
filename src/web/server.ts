import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { loadWebConfig, trustedWebPeer, webListenHosts, webAccessUrls, webHostAllowed, verifyWebCredential, webCredentialSignature, type WebConfig } from './config';
import { PersonalSessionService, WebError } from './service';
import { bridgeWebPage } from '../../apps/bridge-web/page';
import { bridgeConsolePage } from '../../apps/bridge-web/console';
import type { BridgeConsoleService } from './console';
import { GROUP_AVATAR_IMAGES } from '../bot/group-avatar-images';
import { log } from '../core/logger';

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new WebError(415, '仅接受 JSON');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { size += chunk.length; if (size > 80_000) throw new WebError(413, '请求过大'); chunks.push(chunk); }
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(); return v; }
  catch { throw new WebError(400, '无效 JSON'); }
}
const respond = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };

/** Direct trusted peers or cookie auth, same-origin writes and shared snapshots across listeners. */
export async function startBridgeWeb(options: { configPath: string; service: PersonalSessionService; consoleService?: BridgeConsoleService; config?: WebConfig; pollMs?: number }) {
  const initial = options.config ?? await loadWebConfig(options.configPath);
  if (!initial?.enabled) return;
  await options.service.load();
  let closed = false;
  const sessions = new Map<string, { owner: string; hash: string; expires: number }>();
  const failures = new Map<string, { count: number; until: number }>();
  const streams = new Map<ServerResponse, { token?: string; bearer?: string; local: boolean; id?: string; previous?: string }>();
  const cookie = (req: IncomingMessage) => /(?:^|;\s*)bridge_web=([A-Za-z0-9_-]{43})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
  const config = () => options.config ? Promise.resolve(options.config) : loadWebConfig(options.configPath);
  const hosts = webListenHosts(initial);
  const accessSignature = (c: WebConfig) => JSON.stringify([webListenHosts(c), c.port, c.trustedNetworks ?? []]);
  const initialAccess = accessSignature(initial);
  const sameAccess = (c: WebConfig | undefined): c is WebConfig => !!c?.enabled && accessSignature(c) === initialAccess;
  const localRequest = (req: IncomingMessage) => trustedWebPeer(initial, req.socket.remoteAddress);
  const authenticate = async (token?: string, local = false, bearer?: string) => {
    const c = await config(), session = token ? sessions.get(token) : undefined;
    if (!sameAccess(c)) throw new WebError(401, '网页入口已禁用或配置已变化');
    if (local) { options.service.ownerIdentity(); return; }
    if (bearer !== undefined) {
      if (!await verifyWebCredential(c, bearer, false)) throw new WebError(401, 'Token 无效');
      options.service.ownerIdentity(); return;
    }
    if (!session || session.expires <= Date.now() || session.hash !== webCredentialSignature(c)) throw new WebError(401, '请重新登录');
    if (session.owner !== options.service.ownerIdentity()) throw new WebError(401, '所有者已变化，请重新登录');
  };
  const handler = (req: IncomingMessage, res: ServerResponse) => { void (async () => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!webHostAllowed(initial, req.headers.host, req.socket.localAddress)) throw new WebError(403, '访问地址不匹配');
    const origin = 'http://' + req.headers.host;
    if (req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') throw new WebError(403, '禁止跨站访问');
    if (req.method === 'POST' && req.headers.origin !== origin) throw new WebError(403, '请求来源不匹配');
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname === '/' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(bridgeWebPage); return; }
    if (['/console', '/console/'].includes(url.pathname) && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(bridgeConsolePage); return; }
    const avatar = /^\/assets\/session-avatars\/([a-z0-9-]+)\.png$/.exec(url.pathname);
    if (avatar && req.method === 'GET') {
      const image = Object.hasOwn(GROUP_AVATAR_IMAGES, avatar[1]!) ? GROUP_AVATAR_IMAGES[avatar[1]! as keyof typeof GROUP_AVATAR_IMAGES] : undefined;
      if (!image) throw new WebError(404, '工具头像不存在');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
      res.end(Buffer.from(image, 'base64')); return;
    }
    const local = localRequest(req);
    if (url.pathname === '/api/access' && req.method === 'GET') { respond(res, 200, { loginRequired: !local }); return; }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      if (local) { await authenticate(undefined, true); respond(res, 200, { ok: true }); return; }
      const ip = req.socket.remoteAddress ?? '';
      const input = await body(req), c = await config();
      // Reserve before the asynchronous password hash so concurrent attempts
      // cannot bypass the existing per-source rate limit.
      if (failures.size > 1000) failures.clear();
      const failure = failures.get(ip);
      if (failure && failure.until > Date.now() && failure.count >= 8) throw new WebError(429, '登录尝试过多，请稍后重试');
      failures.set(ip, { count: failure && failure.until > Date.now() ? failure.count + 1 : 1, until: Date.now() + 60_000 });
      if (!sameAccess(c) || !await verifyWebCredential(c, input.secret)) {
        throw new WebError(401, '密码或 Token 无效');
      }
      const owner = options.service.ownerIdentity();
      failures.delete(ip);
      for (const [t, s] of sessions) if (s.expires < Date.now()) sessions.delete(t);
      if (sessions.size >= 64) sessions.delete(sessions.keys().next().value!);
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, { owner, hash: webCredentialSignature(c), expires: Date.now() + 12 * 60 * 60_000 });
      res.setHeader('Set-Cookie', `bridge_web=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
      respond(res, 200, { ok: true }); return;
    }
    const token = cookie(req), bearer = req.headers.authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
    await authenticate(token, local, bearer);
    if (url.pathname.startsWith('/api/console')) {
      const console = options.consoleService;
      if (!console) throw new WebError(503, '控制台尚未就绪');
      if (url.pathname === '/api/console' && req.method === 'GET') { respond(res, 200, await console.snapshot(url.searchParams.get('refresh') === '1')); return; }
      const item = /^\/api\/console\/items\/([a-f0-9]{64})$/.exec(url.pathname);
      if (item && req.method === 'GET') { respond(res, 200, await console.detail(item[1]!)); return; }
      if (url.pathname === '/api/console/action' && req.method === 'POST') {
        const input = await body(req);
        if (typeof input.action !== 'string' || [input.id, input.target].some(v => v !== undefined && (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)))) throw new WebError(400, '操作参数无效');
        respond(res, 200, await console.action(input.action, input.id as string | undefined, input.target as string | undefined)); return;
      }
      throw new WebError(404, '控制台接口不存在');
    }
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      sessions.delete(token!); res.setHeader('Set-Cookie', 'bridge_web=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); respond(res, 200, { ok: true }); return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') { respond(res, 200, await options.service.list()); return; }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      if (streams.size >= 32) throw new WebError(429, '连接数量过多');
      const id = url.searchParams.get('session') ?? undefined;
      if (id && !/^[a-f0-9]{64}$/.test(id)) throw new WebError(400, '会话 ID 无效');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 1500\n\n'); streams.set(res, { token, bearer, local, id });
      res.on('close', () => streams.delete(res)); void poll(); return;
    }
    const match = /^\/api\/sessions\/([a-f0-9]{64})(?:\/(send|rename|control|favorite|queue))?$/.exec(url.pathname);
    if (match && req.method === 'GET' && !match[2]) { respond(res, 200, await options.service.read(match[1]!)); return; }
    if (match && req.method === 'POST') {
      const input = await body(req);
      if (match[2] === 'queue' && typeof input.id === 'string') { respond(res, 200, await options.service.removeQueuedMessage(match[1]!, input.id)); return; }
      if (match[2] === 'send' && typeof input.requestId === 'string' && typeof input.text === 'string') { respond(res, 202, await options.service.send(match[1]!, input.requestId, input.text)); return; }
      if (match[2] === 'favorite' && typeof input.favorite === 'boolean') { respond(res, 200, await options.service.favorite(match[1]!, input.favorite)); return; }
      if (match[2] === 'rename' && typeof input.name === 'string') { respond(res, 200, await options.service.rename(match[1]!, input.name)); return; }
      if (match[2] === 'control' && typeof input.action === 'string') { respond(res, 200, await options.service.control(match[1]!, input.action, input.values)); return; }
      throw new WebError(400, '请求内容无效');
    }
    throw new WebError(404, '接口不存在');
  })().catch(e => {
    if (res.headersSent) { res.end(); return; }
    if (!(e instanceof WebError)) log.warn('web', 'request-failed', { method: req.method, path: req.url?.split('?')[0], err: e instanceof Error ? e.message : String(e) });
    respond(res, e instanceof WebError ? e.status : 503, { error: e instanceof WebError ? e.message : '桥接服务暂时不可用，请稍后重试' });
  }); };
  let running: Promise<void> | undefined;
  function poll(): Promise<void> {
    if (running) return running;
    if (closed || !streams.size) return Promise.resolve();
    running = (async () => {
      for (const [res, s] of streams) try { await authenticate(s.token, s.local, s.bearer); } catch (e) {
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
  const servers = hosts.map(() => createServer(handler));
  const closeListeners = async () => { await Promise.all(servers.map(server => new Promise<void>(accept => { server.close(() => accept()); server.closeIdleConnections(); }))); };
  try {
    for (const [index, server] of servers.entries()) await new Promise<void>((accept, reject) => {
      server.once('error', reject); server.listen(initial.port, hosts[index], () => { server.off('error', reject); accept(); });
    });
  } catch (error) { await closeListeners(); throw error; }
  const timer = setInterval(() => void poll(), options.pollMs ?? 1000); timer.unref();
  const urls = webAccessUrls(initial);
  return { url: urls[0]!, urls, async close() {
    closed = true; clearInterval(timer);
    for (const res of streams.keys()) res.end(); streams.clear();
    await closeListeners(); await running;
  } };
}
