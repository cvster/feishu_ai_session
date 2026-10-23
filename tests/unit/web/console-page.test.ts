import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { bridgeConsolePage } from '../../../apps/bridge-web/console';

class Element {
  children: Element[] = []; textContent = ''; hidden = false; disabled = false; value = ''; className = ''; open = false;
  dataset: Record<string, string> = {}; handlers: Record<string, () => void> = {};
  onclick?: () => Promise<void> | void;
  onsubmit?: (event: { preventDefault(): void }) => Promise<void> | void;
  constructor(readonly tag = 'div') {}
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren(...nodes: Element[]) { this.children = nodes; }
  setAttribute() {}
  addEventListener(name: string, handler: () => void) { this.handlers[name] = handler; }
  showModal() { this.open = true; } close() { this.open = false; }
  get text(): string { return this.textContent + this.children.map(n => n.text).join(''); }
  set innerHTML(_: string) { throw Error('API payload must be rendered as text'); }
}
function harness(loginRequired = true, authorized = true) {
  const nodes = new Map([...bridgeConsolePage.matchAll(/id="([^"]+)"/g)].map(m => [m[1]!, new Element()]));
  const get = (id: string) => nodes.get(id)!;
  const nav = ['overview', 'queue', 'bindings', 'shared', 'logs'].map(page => { const e = new Element('button'); e.dataset.page = page; return e; });
  const snapshot = { at: Date.now(), bridge: { connection: 'connected', uptimeSeconds: 120 },
    summary: { online: 1, workers: 1, pending: 1, active: 1, failed: 0 }, canDiscover: true, canSync: true,
    workers: [{ id: 'generic', label: '<script>Tool</script>', online: true, checkedAt: Date.now(), capabilities: { jobs: { submit: true }, sessions: { archive: true } }, sessions: 2, active: 1, pending: 1 }],
    bindings: [{ id: 'b', tool: 'Tool', groupName: '群', sessionName: '会话', kind: '个人 AI 群', cwd: '/project', issues: ['群名与会话名不一致'], canSync: true }],
    sharedGroups: [{ id: 'shared', chatId: 'oc_shared', name: '<群>', kind: '共享群', sessionName: '会话', tool: 'Tool', cwd: '/project', status: 'active', active: true, targetId: 'current', canBind: true, canLeave: true, issues: [] },
      { id: 'private', chatId: 'oc_private', name: '私聊群', kind: '私聊群', sessionName: '会话', tool: 'Tool', cwd: '/project', status: 'active', active: true, canBind: false, canLeave: true, issues: [] }],
    sharedTargets: [{ id: 'current', name: '会话', tool: 'Tool', cwd: '/project' }, { id: 'next', name: '<新会话>', tool: 'Other', cwd: '/next' }],
    items: [{ id: 'pending', toolId: 'generic', tool: 'Tool', name: '会话', sender: 'Nick', text: '<img src=x onerror=attack()>', status: 'pending', createdAt: Date.now(), canRetry: true },
      { id: 'accepted', toolId: 'generic', tool: 'Tool', name: '会话', sender: 'Nick', text: '已提交消息', status: 'running', createdAt: Date.now(), canRetry: false }] };
  const requests: { path: string; body?: any }[] = [];
  runInNewContext(bridgeConsolePage.match(/<script>([\s\S]*?)<\/script>/)![1]!, {
    document: { getElementById: get, createElement: (tag: string) => new Element(tag), querySelectorAll: () => nav, hidden: false },
    window: { addEventListener() {} }, location: { hash: '' }, setInterval() {}, setTimeout, clearTimeout,
    fetch: async (path: string, options: { body?: string }) => {
      const body = options.body ? JSON.parse(options.body) : undefined; requests.push({ path, body });
      const value = path === '/api/access' ? { loginRequired } : path.startsWith('/api/console/logs') ? [] : path === '/api/console/action' ? { ok: true } : snapshot;
      const ok = authorized || path === '/api/access';
      return { ok, status: ok ? 200 : 401, json: async () => ok ? value : { error: '请重新登录' } };
    },
  });
  return { get, nav, snapshot, requests, ready: async () => { await vi.waitFor(() => expect(requests.some(r => r.path === '/api/console')).toBe(true)); await new Promise(r => setTimeout(r, 0)); } };
}

it('reuses the existing authenticated cookie on password-protected peers and renders tool labels as text', async () => {
  const h = harness(); await h.ready(); expect(h.get('login').hidden).toBe(true); expect(h.get('app').hidden).toBe(false);
  expect(h.get('workers').text).toContain('<script>Tool</script>'); expect(h.get('metrics').text).toContain('未发送消息');
  expect(h.requests.some(r => r.path === '/api/login')).toBe(false);
});
it('requires login when a peer has neither trust nor a valid cookie', async () => {
  const h = harness(true, false); await h.ready(); expect(h.get('login').hidden).toBe(false); expect(h.get('app').hidden).toBe(true);
});
it('filters the message queue and exposes retry only on unsent input', async () => {
  const h = harness(false); await h.ready(); await h.nav[1]!.onclick!();
  expect(h.get('queue-list').text).toContain('<img src=x onerror=attack()>');
  const buttons = (node: Element): Element[] => node.children.flatMap(c => [...(c.tag === 'button' ? [c] : []), ...buttons(c)]);
  const retries = buttons(h.get('queue-list')).filter(b => b.textContent === '重试'); expect(retries).toHaveLength(1);
  await retries[0]!.onclick!(); await vi.waitFor(() => expect(h.requests.some(r => r.body?.action === 'retry')).toBe(true));
  expect(h.requests.find(r => r.body?.action === 'retry')?.body.id).toBe('pending');
  h.get('queue-status').value = 'active'; h.get('queue-status').handlers.change!();
  expect(h.get('queue-list').text).toContain('已提交消息'); expect(h.get('queue-list').text).not.toContain('onerror');
});

it('opens shared management dialogs and submits only after confirmation with the selected target', async () => {
  const h = harness(false); await h.ready(); await h.nav[3]!.onclick!();
  const buttons = (node: Element): Element[] => node.children.flatMap(c => [...(c.tag === 'button' ? [c] : []), ...buttons(c)]);
  const all = buttons(h.get('shared-list')); const change = all.find(b => b.textContent === '换会话')!;
  expect(h.get('shared-list').text).toContain('<群>'); expect(all.filter(b => b.textContent === '换会话')).toHaveLength(1);
  await change.onclick!(); expect(h.get('shared-dialog').open).toBe(true);
  expect(h.get('shared-target').text).toContain('<新会话>'); expect(h.requests.some(r => r.body?.action === 'shared-bind')).toBe(false);
  h.get('shared-target').value = 'next'; await h.get('shared-form').onsubmit!({ preventDefault() {} });
  expect(h.requests.find(r => r.body?.action === 'shared-bind')?.body).toEqual({ action: 'shared-bind', id: 'shared', target: 'next' });
  expect(h.get('shared-dialog').open).toBe(false);
  const leave = buttons(h.get('shared-list')).find(b => b.textContent === '机器人退出群')!;
  await leave.onclick!(); expect(h.get('shared-submit').className).toBe('danger');
  expect(h.get('shared-description').text).toContain('未发送消息将取消');
  expect(h.requests.some(r => r.body?.action === 'shared-leave')).toBe(false);
  await h.get('shared-form').onsubmit!({ preventDefault() {} });
  expect(h.requests.find(r => r.body?.action === 'shared-leave')?.body).toEqual({ action: 'shared-leave', id: 'shared' });
});
