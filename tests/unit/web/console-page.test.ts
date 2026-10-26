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
  const nav = ['overview', 'bindings', 'shared'].map(page => { const e = new Element('button'); e.dataset.page = page; return e; });
  const snapshot = { at: Date.now(), bridge: { connection: 'connected', uptimeSeconds: 120 },
    summary: { online: 1, workers: 1, pending: 1, active: 1, failed: 0 }, canDiscover: true, canSync: true,
    workers: [{ id: 'generic', label: '<script>Tool</script>', online: true, checkedAt: Date.now(), capabilities: { jobs: { submit: true }, sessions: { archive: true } }, sessions: 2, active: 1, pending: 1 }],
    bindings: [{ id: 'b', tool: 'Tool', groupName: '群', sessionName: '会话', kind: '个人 AI 群', cwd: '/project', issues: ['群名与会话名不一致'], canSync: true, groupState: 'active', sessionState: 'active', canDissolve: false, canArchive: false },
      { id: 'dissolve', tool: 'Tool', groupName: '待解散群', sessionName: '已归档会话', issues: [], groupState: 'active', sessionState: 'archived', canDissolve: true, canArchive: false },
      { id: 'archive', tool: 'Tool', groupName: '已解散群', sessionName: '待归档会话', issues: [], groupState: 'dissolved', sessionState: 'active', canDissolve: false, canArchive: true }],
    sharedGroups: [{ id: 'shared', chatId: 'oc_shared', name: '<群>', kind: '共享群', sessionName: '会话', tool: 'Tool', cwd: '/project', status: 'active', active: true, associationId: 'current' as string | undefined, targetId: 'current', canBind: true, canLeave: true, issues: [] },
      { id: 'private', chatId: 'oc_private', name: '私聊群', kind: '私聊群', sessionName: '会话', tool: 'Tool', cwd: '/project', status: 'active', active: true, associationId: 'current' as string | undefined, canBind: false, canLeave: true, issues: [] }],
    sharedTargets: [{ id: 'current', name: '会话', toolId: 'generic', tool: 'Tool', cwd: '/project' }, { id: 'next', name: '<新会话>', toolId: 'other', tool: 'Other', cwd: '/next' }],
    items: [{ id: 'pending', toolId: 'generic', tool: 'Tool', name: '会话', sender: 'Nick', text: '<img src=x onerror=attack()>', status: 'pending', createdAt: Date.now(), canRetry: true },
      { id: 'accepted', toolId: 'generic', tool: 'Tool', name: '会话', sender: 'Nick', text: '已提交消息', status: 'running', createdAt: Date.now(), canRetry: false }] };
  const requests: { path: string; body?: any }[] = [];
  runInNewContext(bridgeConsolePage.match(/<script>([\s\S]*?)<\/script>/)![1]!, {
    document: { getElementById: get, createElement: (tag: string) => new Element(tag), querySelectorAll: () => nav, hidden: false },
    window: { addEventListener() {} }, location: { hash: '' }, setInterval() {}, setTimeout, clearTimeout,
    fetch: async (path: string, options: { body?: string }) => {
      const body = options.body ? JSON.parse(options.body) : undefined; requests.push({ path, body });
      const value = path === '/api/access' ? { loginRequired } : path === '/api/console/action' ? { ok: true } : snapshot;
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
it('opens shared management dialogs and submits only after confirmation with the selected target', async () => {
  const h = harness(false); await h.ready(); await h.nav[2]!.onclick!();
  const buttons = (node: Element): Element[] => node.children.flatMap(c => [...(c.tag === 'button' ? [c] : []), ...buttons(c)]);
  const all = buttons(h.get('shared-list')); const change = all.find(b => b.textContent === '换会话')!;
  expect(h.get('shared-list').text).toContain('<群>'); expect(all.filter(b => b.textContent === '换会话')).toHaveLength(1);
  await change.onclick!(); expect(h.get('shared-dialog').open).toBe(true);
  expect(h.get('shared-tool').text).toContain('Other');
  expect(h.get('shared-project').disabled).toBe(true);
  h.get('shared-tool').value = 'other'; h.get('shared-tool').handlers.change!();
  expect(h.get('shared-project').text).toContain('/next');
  h.get('shared-project').value = '/next'; h.get('shared-project').handlers.change!();
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


it('shows only the mismatch management buttons and requires confirmation before closing either side', async () => {
  const h = harness(false); await h.ready(); await h.nav[1]!.onclick!();
  expect(bridgeConsolePage).not.toContain('诊断日志'); expect(h.get('heading').textContent).toBe('AI会话群管理');
  const buttons = (node: Element): Element[] => node.children.flatMap(c => [...(c.tag === 'button' ? [c] : []), ...buttons(c)]);
  const controls = buttons(h.get('binding-list'));
  expect(controls.map(b => b.textContent)).toEqual(['解散群', '归档会话']);
  await controls[0]!.onclick!(); expect(h.get('group-dialog').open).toBe(true);
  expect(h.get('group-description').textContent).toContain('群聊无法恢复');
  expect(h.requests.some(r => r.body?.action === 'personal-dissolve')).toBe(false);
  await h.get('group-form').onsubmit!({ preventDefault() {} });
  expect(h.requests.find(r => r.body?.action === 'personal-dissolve')?.body).toEqual({ action: 'personal-dissolve', id: 'dissolve' });
  await buttons(h.get('binding-list')).find(b => b.textContent === '归档会话')!.onclick!();
  await h.get('group-form').onsubmit!({ preventDefault() {} });
  expect(h.requests.find(r => r.body?.action === 'personal-archive')?.body).toEqual({ action: 'personal-archive', id: 'archive' });
});

it('cascades tools, full project paths and session choices without retaining a hidden target', async () => {
  const h = harness(false); await h.ready();
  h.snapshot.sharedTargets.push({ id: 'third', name: '同名项目会话', toolId: 'other', tool: 'Other', cwd: '/else/next' },
    { id: 'fourth', name: '另一工具会话', toolId: 'generic', tool: 'Tool', cwd: '/next' });
  await h.nav[2]!.onclick!();
  const buttons = (node: Element): Element[] => node.children.flatMap(c => [...(c.tag === 'button' ? [c] : []), ...buttons(c)]);
  await buttons(h.get('shared-list')).find(b => b.textContent === '换会话')!.onclick!();
  h.get('shared-tool').value = 'other'; h.get('shared-tool').handlers.change!();
  expect(h.get('shared-project').children.map(e => e.value)).toEqual(['', '/next', '/else/next']);
  h.get('shared-project').value = '/next'; h.get('shared-project').handlers.change!();
  expect(h.get('shared-target').children.map(e => e.value)).toEqual(['', 'next']);
  h.get('shared-target').value = 'next';
  h.get('shared-tool').value = 'generic'; h.get('shared-tool').handlers.change!();
  expect(h.get('shared-target').value).toBe(''); expect(h.get('shared-project').value).toBe('');
  await h.get('shared-form').onsubmit!({ preventDefault() {} });
  expect(h.requests.some(r => r.body?.action === 'shared-bind')).toBe(false);
});

it('groups multiple shared and private chats under the real session identity, separates same names and pending chats, and preserves expansion', async () => {
  const h = harness(false); await h.ready();
  h.snapshot.sharedGroups.push({ ...h.snapshot.sharedGroups[0]!, id: 'same-name', chatId: 'oc_other', name: '同名会话的其他群', associationId: 'different-worker-session', canLeave: false, canBind: false },
    { ...h.snapshot.sharedGroups[0]!, id: 'pending', chatId: 'oc_pending', name: '待绑定的群', associationId: undefined, targetId: undefined, status: 'pending', sessionName: '尚未关联' });
  await h.nav[2]!.onclick!();
  const panels = h.get('shared-list').children;
  expect(panels).toHaveLength(3); expect(panels.map(p => p.tag)).toEqual(['details', 'details', 'details']);
  expect(panels[0]!.children[0]!.text).toContain('2 个群');
  expect(panels[0]!.text).toContain('<群>'); expect(panels[0]!.text).toContain('私聊群');
  expect(panels[0]!.text).not.toContain('同名会话的其他群');
  expect(panels[1]!.text).toContain('同名会话的其他群');
  expect(panels[2]!.children[0]!.text).toContain('待关联'); expect(panels[2]!.text).toContain('待绑定的群');
  panels[0]!.open = false; panels[0]!.handlers.toggle!();
  h.get('shared-search').value = '私聊群'; h.get('shared-search').handlers.input!();
  expect(h.get('shared-list').children).toHaveLength(1);
  expect(h.get('shared-list').children[0]!.open).toBe(false);
  expect(h.get('shared-list').children[0]!.text).not.toContain('<群>');
  h.get('shared-search').value = ''; h.get('shared-search').handlers.input!();
  expect(h.get('shared-list').children[0]!.open).toBe(false);
});

it('shows tool support and inspection results separately from the last confirmed state', async () => {
  const h = harness(false); await h.ready();
  h.snapshot.bindings.push({ id: 'unsupported', groupName: '旧会话群', sessionName: '历史会话', tool: 'Tool', cwd: '/project',
    sessionState: 'unsupported', groupState: 'active', issues: ['工具不支持'], sessionInspection: { result: 'ok', checkedAt: 100 }, groupInspection: { result: 'ok', checkedAt: 100 } } as any,
    { id: 'offline', groupName: '离线群', sessionName: '原会话', tool: 'Tool', cwd: '/project', sessionState: 'active', groupState: 'active',
      issues: ['Worker 离线'], sessionInspection: { result: 'offline', checkedAt: 100 }, groupInspection: { result: 'ok', checkedAt: 100 } } as any);
  await h.nav[1]!.onclick!();
  const text = h.get('binding-list').text;
  expect(text).toContain('会话：工具不支持'); expect(text).toContain('会话：正常'); expect(text).toContain('会话检查：Worker 离线');
  expect(text).toContain('会话确认于'); expect(text).not.toContain('未确认');
  h.get('binding-status').value = 'unsupported'; h.get('binding-status').handlers.change!();
  expect(h.get('binding-list').text).toContain('旧会话群'); expect(h.get('binding-list').text).not.toContain('离线群');
});
