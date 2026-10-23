import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { WebMarkdown } from '../../../src/web/markdown';
import { bridgeWebPage } from '../../../apps/bridge-web/page';

// Exercise the shipped browser script with controlled HTTP/SSE arrival order.
class Element {
  children: Element[] = [];
  textContent = '';
  className = '';
  hidden = false;
  value = '';
  name = '';
  disabled = false;
  clientHeight = 480;
  private top = 0;
  onclick?: (event?: { stopPropagation(): void }) => void | Promise<void>;
  onsubmit?: (event: { preventDefault(): void }) => Promise<void>;
  onkeydown?: (event: { key: string; preventDefault(): void }) => void;
  open = false;
  isConnected = true;
  style: Record<string, string> = {};
  checked = false;
  pointer?: number;
  setPointerCapture(id: number) { this.pointer = id; }
  hasPointerCapture(id: number) { return this.pointer === id; }
  releasePointerCapture() { this.pointer = undefined; }
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  offsetWidth = 176;
  offsetHeight = 128;
  classList = { remove() {}, toggle() {} };
  constructor(readonly tag = 'div', readonly id = '') {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); if (key.startsWith('data-')) this.dataset[key.slice(5)] = value; }
  getAttribute(key: string) { return this.attributes.get(key); }
  getBoundingClientRect() { return { right: 285, top: 150, bottom: 180 }; }
  contains(target: Element): boolean { return this === target || this.children.some(child => child.contains(target)); }
  addEventListener() {}
  close() { this.open = false; }
  showModal() { this.open = true; }
  focus() {}
  get scrollHeight(): number { return this.id === 'messages' ? Math.max(480, (this.children[0]?.children.length ?? 0) * 240) : 480; }
  get scrollTop() { return Math.min(this.top, this.scrollHeight - this.clientHeight); }
  set scrollTop(value: number) { this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
  querySelectorAll(selector: string): Element[] { const match = (child: Element) => selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : selector === 'button:not(:disabled)' ? child.tag === 'button' && !child.disabled : selector === 'input[name],select[name]' ? ['input', 'select'].includes(child.tag) && !!child.name : child.tag === selector; return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(tag: string) { return this.querySelectorAll(tag)[0]; }
  get text(): string { return this.textContent + this.children.map(child => child.text).join(''); }
}

function harness(preferences?: unknown, count = 2, savedStorage?: Map<string, string>, updatedAtMs?: number[]) {
  const ids = [...bridgeWebPage.matchAll(/id="([^"]+)"/g)].map(match => match[1]!);
  const elements = new Map(ids.map(id => [id, new Element('div', id)]));
  const node = (id: string) => elements.get(id)!;
  node('app').style.setProperty = ((key: string, value: string) => { node('app').style[key] = value; }) as any;
  node('session-menu').hidden = true; node('session-menu').append(node('session-rename'), node('session-archive'), node('session-copy'));
  for (const action of ['stop', 'refresh']) { const button = new Element('button'); button.setAttribute('data-control', action); node('session-controls').append(button); }
  const rows = Array.from({ length: count }, (_, i) => String.fromCharCode(97 + i)).map((id, index) => ({ id: id.repeat(64), toolId: index ? 'another' : 'generic', tool: index ? 'Other' : 'Tool', favorite: false, updatedAtMs: updatedAtMs?.[index] ?? count - index,
    project: 'project', cwd: '/project', scope: 'oc_' + id, name: '会话' + index, online: true, canSend: true, canRename: true }));
  const conversation = (index: number, answer = '回答', count = 12) => ({ session: rows[index], turns: Array.from({ length: count }, (_, i) => ({
    id: String(i), input: '问题' + i, answer, status: 'completed', origin: 'native', createdAtMs: 1,
  })) });
  const requests: { id: string; path: string; data?: any; resolve(value: unknown): void; reject(error: Error): void }[] = [];
  class Stream {
    static all: Stream[] = [];
    listeners = new Map<string, (event: { data: string }) => void>();
    closed = false;
    constructor(readonly url: string) { Stream.all.push(this); }
    addEventListener(name: string, listener: (event: { data: string }) => void) { this.listeners.set(name, listener); }
    close() { this.closed = true; }
    emit(name: string, data: unknown) { this.listeners.get(name)?.({ data: JSON.stringify(data) }); }
  }
  const response = (value: unknown) => ({ ok: true, json: async () => value });
  const storage = savedStorage ?? new Map(preferences === undefined ? [] : [['bridge-web-preferences', JSON.stringify(preferences)]]);
  const browserWindow = { innerWidth: 1280, innerHeight: 900, addEventListener() {} };
  runInNewContext(bridgeWebPage.match(/<script>([\s\S]*?)<\/script>/)![1]!, {
    document: { getElementById: node, createElement: (tag: string) => new Element(tag), createElementNS: (_ns: string, tag: string) => new Element(tag), body: new Element('body'), addEventListener() {} },
    window: browserWindow,
    fetch: async (path: string, options?: { body?: string }) => {
      if (path === '/api/access') return response({ loginRequired: false });
      if (path === '/api/sessions') return response(rows);
      // Deliberately allow a response after abort to check the selection guard.
      return new Promise((resolve, reject) => requests.push({ id: path.split('/').at(-1)!, path, data: options?.body ? JSON.parse(options.body) : undefined, resolve: value => resolve(response(value)), reject }));
    },
    EventSource: Stream, AbortController, crypto: webcrypto, localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
  });
  const ready = () => vi.waitFor(() => expect(requests).toHaveLength(1));
  const choose = (index: number) => { void node('tree').querySelectorAll('button').find(button => button.textContent === rows[index]!.name)!.onclick!(); };
  const menu = (index: number) => node('tree').querySelectorAll('button').find(button => button.getAttribute('aria-label') === rows[index]!.name + '的会话选项')!.onclick!({ stopPropagation() {} });
  const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  const snapshot = (index: number, answer?: string, count?: number) => Stream.all.at(-1)!.emit('snapshot', { sessions: rows, conversation: conversation(index, answer, count) });
  return { node, rows, requests, ready, choose, menu, settle, snapshot, conversation, streams: Stream.all, storage, browserWindow };
}

it.each([true, false])('opens the most recently updated session on entry when recent visibility is %s and preserves later selections', async showRecent => {
  const h = harness({ showRecent }, 3, undefined, [10, 30, 20]); await h.ready();
  expect(h.requests[0]!.path).toBe('/api/sessions/' + h.rows[1]!.id);
  expect(h.node('title').textContent).toBe(h.rows[1]!.name);
  if (showRecent) expect(h.node('tree').children[1]!.querySelector('.session')?.text).toBe(h.rows[1]!.name);
  h.requests[0]!.resolve(h.conversation(1)); await h.settle();
  h.choose(0); h.requests[1]!.resolve(h.conversation(0)); await h.settle();
  h.rows[2]!.updatedAtMs = 40;
  h.streams.at(-1)!.emit('snapshot', { sessions: h.rows });
  expect(h.node('title').textContent).toBe(h.rows[0]!.name); expect(h.requests).toHaveLength(2);
});

it('reuses cached content without another history request and restores each session scroll position', async () => {
  const h = harness(); await h.ready(); h.requests[0]!.resolve(h.conversation(0)); await h.settle();
  const box = h.node('messages'), content = box.children[0];
  expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight);
  box.scrollTop = 310;
  h.choose(1); h.requests[1]!.resolve(h.conversation(1)); await h.settle();
  h.choose(0);
  expect(h.requests).toHaveLength(2);
  expect(box.children[0]).toBe(content);
  expect(box.scrollTop).toBe(310);
  expect(box.text).not.toContain('正在读取会话');
  const connections = h.streams.length; h.choose(0); expect(h.streams).toHaveLength(connections);
});

it('keeps the stop label on completion and restores its active state when new input or running work appears', async () => {
  const h = harness(); await h.ready(); h.requests[0]!.resolve(h.conversation(0)); await h.settle();
  const stop = h.node('session-controls').querySelectorAll('button')[0]!;
  expect(stop.textContent).toBe('■ 停止'); expect(stop.dataset.completed).toBe('true'); expect(stop.disabled).toBe(true);
  const requests = h.requests.length; stop.onclick!(); expect(h.requests).toHaveLength(requests);
  for (const status of ['running', 'interrupted', 'error', 'waiting_input', 'queued', 'unknown']) {
    const c = h.conversation(0, '回答', 1); c.turns[0]!.status = status;
    h.streams.at(-1)!.emit('snapshot', { sessions: h.rows, conversation: c });
    expect(stop.textContent).toBe('■ 停止'); expect(stop.dataset.completed).toBe('false'); expect(stop.disabled).toBe(false);
  }
  h.snapshot(0, '完成', 1); expect(stop.disabled).toBe(true);
  h.node('input').value = '新消息';
  const sending = h.node('composer').onsubmit!({ preventDefault() {} });
  expect(stop.textContent).toBe('■ 停止'); expect(stop.disabled).toBe(false);
  h.requests.at(-1)!.resolve({ status: 'queued' }); await sending;
  expect(stop.textContent).toBe('■ 停止'); expect(stop.disabled).toBe(false);
});

it('renders each shared sender name beside its original message as text', async () => {
  const h = harness(); await h.ready();
  const conversation = h.conversation(0, '共享回复', 1);
  Object.assign(conversation.turns[0]!, { input: '问题一\n\n问题二', origin: 'bridge', inputMessages: [
    { senderName: 'Nick Yang', text: '问题一' }, { senderName: '<img src=x onerror=alert(1)>', text: '问题二' },
  ] });
  h.requests[0]!.resolve(conversation); await h.settle();
  expect(h.node('messages').text).toContain('来自共享群');
  expect(h.node('messages').querySelectorAll('.user').map(el => el.textContent)).toEqual(['Nick Yang：\n问题一', '<img src=x onerror=alert(1)>：\n问题二']);
  expect(h.node('messages').querySelectorAll('img')).toHaveLength(0);
  expect(h.node('messages').text).toContain('共享回复');
});

it('keeps the reading position on live updates and follows new replies only when already near the bottom', async () => {
  const h = harness(); await h.ready(); h.requests[0]!.resolve(h.conversation(0)); await h.settle();
  const box = h.node('messages'); box.scrollTop = 400;
  h.snapshot(0, '新回答', 13); expect(box.scrollTop).toBe(400);
  box.scrollTop = box.scrollHeight;
  h.snapshot(0, '后续回答', 14); expect(box.scrollTop).toBe(box.scrollHeight - box.clientHeight);
  expect(bridgeWebPage).not.toContain('scroll-behavior:smooth');
});

it('ignores late HTTP and closed-stream responses after switching sessions', async () => {
  const h = harness(); await h.ready(); const oldStream = h.streams[0]!;
  h.choose(1); h.requests[1]!.resolve(h.conversation(1, '当前回答')); await h.settle();
  const box = h.node('messages'); box.scrollTop = 100;
  h.requests[0]!.resolve(h.conversation(0, '过期回答')); await h.settle();
  oldStream.emit('snapshot', { sessions: h.rows, conversation: h.conversation(0, '过期推送') });
  expect(box.text).toContain('当前回答'); expect(box.text).not.toContain('过期'); expect(box.scrollTop).toBe(100);
});

it('does not overwrite a newer live snapshot with the initial HTTP response', async () => {
  const h = harness(); await h.ready(); h.snapshot(0, '实时新回答');
  h.node('messages').scrollTop = 250;
  h.requests[0]!.resolve(h.conversation(0, '旧历史')); await h.settle();
  expect(h.node('messages').text).toContain('实时新回答');
  expect(h.node('messages').text).not.toContain('旧历史'); expect(h.node('messages').scrollTop).toBe(250);
});

it('removes cached history for revoked bindings and clears visible content on authentication changes', async () => {
  const h = harness(); await h.ready(); h.requests[0]!.resolve(h.conversation(0)); await h.settle();
  h.streams.at(-1)!.emit('snapshot', { sessions: [h.rows[1]], conversation: h.conversation(0, '撤销后的回答') });
  expect(h.node('messages').text).toBe(''); expect(h.node('composer').hidden).toBe(true);
  h.streams.at(-1)!.emit('snapshot', { sessions: h.rows }); h.choose(0);
  expect(h.requests).toHaveLength(2); h.requests[1]!.resolve(h.conversation(0)); await h.settle();
  h.menu(1); h.node('session-rename').onclick!();
  expect(h.node('rename-dialog').open).toBe(true);
  h.streams.at(-1)!.emit('auth', {});
  expect(h.node('messages').text).toBe(''); expect(h.node('composer').hidden).toBe(true);
  expect(h.node('rename-dialog').open).toBe(false); expect(h.node('session-menu').hidden).toBe(true);
});


it('renames the sidebar menu target without loading or editing the displayed conversation', async () => {
  const h = harness(); await h.ready(); h.requests[0]!.resolve(h.conversation(0)); await h.settle();
  h.menu(1); expect(h.node('session-menu').hidden).toBe(false); expect(h.requests).toHaveLength(1);
  h.node('session-rename').onclick!(); expect(h.node('new-name').value).toBe(h.rows[1]!.name);
  h.node('new-name').value = '修改的第二个会话';
  const saving = h.node('rename-form').onsubmit!({ preventDefault() {} });
  expect(h.requests[1]).toMatchObject({ path: '/api/sessions/' + h.rows[1]!.id + '/rename', data: { name: '修改的第二个会话' } });
  h.requests[1]!.resolve({ name: '修改的第二个会话', pendingSync: true }); await saving;
  expect(h.rows[0]!.name).toBe('会话0'); expect(h.rows[1]!.name).toBe('修改的第二个会话');
  expect(h.node('title').textContent).toBe('会话0'); expect(h.node('rename-dialog').open).toBe(false);
  expect(h.node('notice').hidden).toBe(false);
  expect(h.node('notice').textContent).toBe('群名已修改，会话名等待工具可用后自动同步');
});

it.each(['session-archive', 'session-copy'])('keeps %s confirmation callbacks tied to an unselected sidebar target', async button => {
  const h = harness(); await h.ready(); h.requests[0]!.resolve(h.conversation(0)); await h.settle();
  h.menu(1); h.node(button).onclick!();
  expect(h.requests[1]).toMatchObject({ path: '/api/sessions/' + h.rows[1]!.id + '/control', data: { action: button === 'session-archive' ? 'finish' : 'fork' } });
  h.requests[1]!.resolve({ elements: [{ kind: 'button', text: '确认', action: 'signed-target-choice', danger: true }] }); await h.settle();
  expect(h.node('controls-title').textContent).toContain('会话1'); expect(h.node('title').textContent).toBe('会话0');
  h.node('controls-body').querySelector('button')!.onclick!();
  expect(h.requests[2]).toMatchObject({ path: '/api/sessions/' + h.rows[1]!.id + '/control', data: { action: 'signed-target-choice' } });
  h.requests[2]!.resolve({ elements: [{ kind: 'text', text: '完成' }] }); await h.settle();
});

it('shows the default copy name with its label and submits edits for the sidebar target', async () => {
  const h = harness(); await h.ready(); h.requests[0]!.resolve(h.conversation(0)); await h.settle();
  h.menu(1); h.node('session-copy').onclick!();
  h.requests[1]!.resolve({ elements: [
    { kind: 'input', name: 'new_session_name', label: '新会话名字', value: '会话1-2' },
    { kind: 'button', text: '复制', action: 'signed-copy-choice' },
  ] }); await h.settle();
  const input = h.node('controls-body').querySelector('input')!;
  expect(input.value).toBe('会话1-2'); expect(input.getAttribute('aria-label')).toBe('新会话名字');
  expect(h.node('controls-body').querySelector('label')?.text).toBe('新会话名字');
  input.value = '自定义名字'; h.node('controls-body').querySelector('button')!.onclick!();
  expect(h.requests[2]).toMatchObject({ path: '/api/sessions/' + h.rows[1]!.id + '/control', data: { action: 'signed-copy-choice', values: { new_session_name: '自定义名字' } } });
  h.requests[2]!.resolve({ elements: [{ kind: 'text', text: '完成' }] }); await h.settle();
});

it('drops late menu results after a session switch and re-enables other session menus after archival', async () => {
  const h = harness(); await h.ready(); h.requests[0]!.resolve(h.conversation(0)); await h.settle();
  h.menu(1); h.node('session-archive').onclick!(); h.choose(1);
  h.requests[2]!.resolve(h.conversation(1)); await h.settle();
  h.requests[1]!.resolve({ elements: [{ kind: 'button', text: '过期确认', action: 'old-choice' }] }); await h.settle();
  expect(h.node('controls-dialog').open).toBe(false); expect(h.node('controls-body').text).not.toContain('过期确认');
  h.menu(1); h.node('session-archive').onclick!();
  h.streams.at(-1)!.emit('snapshot', { sessions: [h.rows[0]], conversation: h.conversation(1) });
  h.requests[3]!.resolve({ elements: [{ kind: 'text', text: '已归档' }] }); await h.settle();
  expect(h.node('tree').querySelectorAll('.session-more').every(button => !button.disabled)).toBe(true);
});

it('renders tool icons and favorites across tools under one project, without loading conversation history', async () => {
  const h = harness(); await h.ready(); h.requests[0]!.resolve(h.conversation(0)); await h.settle();
  const root = h.node('tree'), favorite = (name: string) => root.querySelectorAll('.session-favorite').find(b => b.getAttribute('aria-label') === name + '的收藏')!;
  expect(root.children[0]!.querySelector('summary')!.text).toBe('收藏0');
  expect(root.querySelectorAll('.tool-icon').map(e => e.getAttribute('aria-label'))).toEqual(['Tool', 'Other', 'Tool', 'Other']);
  favorite(h.rows[1]!.name).onclick!({ stopPropagation() {} });
  expect(h.requests[1]).toMatchObject({ path: '/api/sessions/' + h.rows[1]!.id + '/favorite', data: { favorite: true } });
  expect(favorite(h.rows[1]!.name).disabled).toBe(true);
  h.requests[1]!.resolve({ favorite: true }); await h.settle();
  favorite(h.rows[0]!.name).onclick!({ stopPropagation() {} }); h.requests[2]!.resolve({ favorite: true }); await h.settle();
  const saved = root.children[0]!;
  expect(saved.querySelector('summary')!.text).toBe('收藏2');
  expect(saved.querySelectorAll('details')).toHaveLength(1);
  expect(saved.querySelectorAll('.session')).toHaveLength(2);
  expect(root.querySelectorAll('.session-favorite').every(b => b.getAttribute('aria-pressed') === 'true' && b.className.includes('favorited') && b.querySelector('svg'))).toBe(true);
  expect(h.node('title').textContent).toBe(h.rows[0]!.name); expect(h.requests).toHaveLength(3);
  favorite(h.rows[1]!.name).onclick!({ stopPropagation() {} }); h.requests[3]!.resolve({ favorite: false }); await h.settle();
  expect(root.children[0]!.querySelectorAll('.session')).toHaveLength(1);
  expect(favorite(h.rows[1]!.name).getAttribute('aria-pressed')).toBe('false');
});

it('limits recent updates before search, groups projects, and follows SSE timestamps without reading history', async () => {
  const h = harness(undefined, 12, undefined, Array.from({ length: 12 }, (_, i) => i + 1)); await h.ready();
  const recent = () => h.node('tree').children[1]!;
  expect(recent().querySelector('summary')!.text).toBe('最近更新9');
  expect(recent().querySelectorAll('.session').map(e => e.text)).toEqual(Array.from({ length: 9 }, (_, i) => '会话' + (11 - i)));
  h.rows[0]!.updatedAtMs = 20;
  h.streams.at(-1)!.emit('snapshot', { sessions: h.rows });
  expect(recent().querySelectorAll('.session')[0]!.text).toBe('会话0');
  h.node('search').value = '会话1'; (h.node('search') as any).oninput();
  expect(recent().querySelectorAll('.session').map(e => e.text)).toEqual(['会话11', '会话10']);
  expect(h.requests).toHaveLength(1);
});

it('persists recent visibility and count, validates settings, and cancels unsaved changes', async () => {
  const h = harness(undefined, 12); await h.ready();
  h.node('settings').onclick!();
  expect(h.node('show-recent').checked).toBe(true); expect(h.node('recent-count').value).toBe('9');
  h.node('recent-count').value = '0'; await h.node('settings-form').onsubmit!({ preventDefault() {} });
  expect(h.node('settings-dialog').open).toBe(true); expect(h.storage.size).toBe(0);
  h.node('recent-count').value = '3'; await h.node('settings-form').onsubmit!({ preventDefault() {} });
  expect(h.node('tree').children[1]!.querySelector('summary')!.text).toBe('最近更新3');
  expect(h.node('settings-dialog').open).toBe(false);
  h.node('settings').onclick!(); h.node('show-recent').checked = false; (h.node('show-recent') as any).onchange();
  expect(h.node('recent-count').disabled).toBe(true);
  await h.node('settings-form').onsubmit!({ preventDefault() {} });
  expect(h.node('tree').children.some(e => e.querySelector('summary')!.text.startsWith('最近更新'))).toBe(false);
  const saved = JSON.parse(h.storage.get('bridge-web-preferences')!);
  const restored = harness(saved); await restored.ready();
  restored.node('settings').onclick!(); expect(restored.node('show-recent').checked).toBe(false); expect(restored.node('recent-count').value).toBe('3');
  restored.node('show-recent').checked = true; restored.node('cancel-settings').onclick!();
  expect(restored.node('tree').children.some(e => e.querySelector('summary')!.text.startsWith('最近更新'))).toBe(false);
  expect(h.requests).toHaveLength(1);
});

it('clamps and persists mouse and keyboard sidebar resizing, restores cancellation, and ignores mobile dragging', async () => {
  const h = harness(); await h.ready(); const handle = h.node('sidebar-resizer') as any;
  const down = (clientX = 325) => handle.onpointerdown({ button: 0, clientX, pointerId: 1, preventDefault() {} });
  const move = (clientX: number) => handle.onpointermove({ clientX, pointerId: 1 });
  expect(h.node('app').style['--sidebar-width']).toBe('325px');
  down(); move(410); expect(h.node('app').style['--sidebar-width']).toBe('410px');
  handle.onpointerup({ pointerId: 1 });
  expect(JSON.parse(h.storage.get('bridge-web-preferences')!).sidebarWidth).toBe(410);
  down(410); move(900); expect(handle.getAttribute('aria-valuenow')).toBe('520'); handle.onpointercancel({ pointerId: 1 });
  expect(h.node('app').style['--sidebar-width']).toBe('410px');
  handle.onkeydown({ key: 'Home', preventDefault() {} }); expect(h.node('app').style['--sidebar-width']).toBe('240px');
  handle.ondblclick(); expect(h.node('app').style['--sidebar-width']).toBe('325px');
  const restored = harness({ ...JSON.parse(h.storage.get('bridge-web-preferences')!), sidebarWidth: 410 }); await restored.ready();
  expect(restored.node('app').style['--sidebar-width']).toBe('410px');
  h.browserWindow.innerWidth = 500; down(); move(1000); expect(h.node('app').style['--sidebar-width']).toBe('325px');
});

it('updates thought and tool count summaries through SSE as plain non-expandable text', async () => {
  const h = harness(); await h.ready();
  const view = h.conversation(0, 'public answer', 1);
  const snapshot = { ...view, turns: [{ ...view.turns[0]!, progress: ['🧠 思考中', '🧰 2 个工具调用（进行中）'] }] };
  h.requests[0]!.resolve(snapshot); await h.settle();
  const summary = () => h.node('messages').querySelector('.progress')!;
  expect(summary().text).toBe('🧠 思考中🧰 2 个工具调用（进行中）');
  expect(summary().children.every(e => e.tag === 'span' && !e.onclick)).toBe(true);
  expect(summary().querySelectorAll('button')).toHaveLength(0); expect(summary().querySelectorAll('details')).toHaveLength(0);
  snapshot.turns[0]!.progress = ['🧠 思考完成', '🧰 2 个工具调用（已完成）'];
  h.streams.at(-1)!.emit('snapshot', { sessions: h.rows, conversation: snapshot });
  expect(summary().text).toBe('🧠 思考完成🧰 2 个工具调用（已完成）');
  expect(h.requests).toHaveLength(1);
});

it('shows a sending bubble and clears the composer before HTTP completes, then replaces it by the confirmed turn', async () => {
  const h = harness(); await h.ready(); h.requests[0]!.resolve(h.conversation(0)); await h.settle();
  h.node('messages').scrollTop = 200; h.node('input').value = '立即显示的消息';
  const submit = h.node('composer').onsubmit!({ preventDefault() {} });
  expect(h.node('input').value).toBe(''); expect(h.node('send').disabled).toBe(true);
  expect(h.node('messages').querySelectorAll('.user').filter(e => e.text === '立即显示的消息')).toHaveLength(1);
  expect(h.node('messages').querySelector('.sending')!.text).toBe('发送中…');
  expect(h.node('messages').scrollTop).toBe(h.node('messages').scrollHeight - h.node('messages').clientHeight);
  const requestId = h.requests[1]!.data.requestId;
  h.requests[1]!.resolve({ requestId, status: 'queued' }); await submit;
  expect(h.node('messages').querySelector('.queued')!.text).toContain('已排队');
  expect(h.node('send').disabled).toBe(false); expect(h.node('send').textContent).toBe('发送');
  const view = h.conversation(0);
  h.streams.at(-1)!.emit('snapshot', { sessions: h.rows, conversation: { ...view, turns: [...view.turns, {
    id: 'job:server', input: '立即显示的消息', answer: '实时回答', requestIds: [requestId], status: 'running', origin: 'bridge', createdAtMs: Date.now(),
  }] } });
  expect(h.node('messages').querySelectorAll('.user').filter(e => e.text === '立即显示的消息')).toHaveLength(1);
  expect(h.node('messages').text).toContain('实时回答'); expect(h.node('messages').querySelectorAll('.queued')).toHaveLength(0);
});

it('deduplicates by request identity for identical inputs and when a batch confirms multiple optimistic messages', async () => {
  const h = harness(); await h.ready(); const history = h.conversation(0, '', 1); history.turns[0]!.input = 'same';
  h.requests[0]!.resolve(history); await h.settle();
  h.node('input').value = 'same'; const first = h.node('composer').onsubmit!({ preventDefault() {} });
  expect(h.node('messages').querySelectorAll('.user').filter(e => e.text === 'same')).toHaveLength(2);
  const firstId = h.requests[1]!.data.requestId; h.requests[1]!.resolve({ status: 'queued' }); await first;
  h.node('input').value = 'same'; const second = h.node('composer').onsubmit!({ preventDefault() {} });
  const secondId = h.requests[2]!.data.requestId;
  expect(firstId).not.toBe(secondId); expect(h.node('messages').querySelectorAll('.user')).toHaveLength(3);
  h.streams.at(-1)!.emit('snapshot', { sessions: h.rows, conversation: { ...history, turns: [...history.turns, {
    id: 'job:batch', input: 'same\n\nsame', answer: '', requestIds: [firstId, secondId], status: 'running', origin: 'bridge', createdAtMs: Date.now(),
  }] } });
  h.requests[2]!.resolve({ status: 'queued' }); await second;
  expect(h.node('messages').querySelectorAll('.user').map(e => e.text)).toEqual(['same', 'same\n\nsame']);
  expect(h.node('messages').querySelectorAll('.sending')).toHaveLength(0);
  expect(h.node('messages').querySelectorAll('.queued')).toHaveLength(0);
});

it('keeps a failed send across reload and reuses its request ID and bubble on retry', async () => {
  const h = harness(); await h.ready(); h.requests[0]!.resolve(h.conversation(0, '', 0)); await h.settle();
  h.node('input').value = '重试消息'; const submit = h.node('composer').onsubmit!({ preventDefault() {} });
  const data = h.requests[1]!.data;
  h.requests[1]!.reject(new Error('network unavailable')); await submit;
  expect(h.node('messages').querySelector('.send_unknown')!.text).toContain('发送未确认');
  expect(h.node('send').textContent).toBe('重试');
  const restored = harness(undefined, 2, h.storage); await restored.ready();
  restored.requests[0]!.resolve(restored.conversation(0, '', 0)); await restored.settle();
  expect(restored.node('messages').text).toContain('重试消息');
  const retry = restored.node('composer').onsubmit!({ preventDefault() {} });
  expect(restored.requests[1]!.data).toEqual(data);
  expect(restored.node('messages').querySelectorAll('.user')).toHaveLength(1);
  restored.requests[1]!.resolve({ status: 'queued' }); await retry;
  expect(restored.node('messages').querySelectorAll('.user')).toHaveLength(1);
  expect(restored.storage.has('bridge-web-draft:' + restored.rows[0]!.id)).toBe(false);
});

it('accepts SSE confirmation before a lost HTTP acknowledgement without reverting a real turn to a failed bubble', async () => {
  const h = harness(); await h.ready(); h.requests[0]!.resolve(h.conversation(0, '', 0)); await h.settle();
  h.node('input').value = '已确认消息'; const submit = h.node('composer').onsubmit!({ preventDefault() {} });
  h.streams.at(-1)!.emit('snapshot', { sessions: h.rows, conversation: { session: h.rows[0], turns: [{
    id: 'receipt:known', input: '已确认消息', answer: '', requestIds: [h.requests[1]!.data.requestId], status: 'queued', origin: 'bridge', createdAtMs: Date.now(),
  }] } });
  h.requests[1]!.reject(new Error('lost acknowledgement')); await submit;
  expect(h.node('messages').querySelectorAll('.user')).toHaveLength(1);
  expect(h.node('messages').querySelectorAll('.send_unknown')).toHaveLength(0);
  expect(h.node('message-error').textContent).toBe(''); expect(h.node('send').textContent).toBe('发送');
});

it('retains an optimistic message when the initial history arrives later', async () => {
  const h = harness(); await h.ready();
  h.node('input').value = '历史加载中的新消息'; const submit = h.node('composer').onsubmit!({ preventDefault() {} });
  expect(h.node('messages').text).toContain('历史加载中的新消息');
  h.requests[0]!.resolve(h.conversation(0, '原有历史', 1)); await h.settle();
  expect(h.node('messages').text).toContain('原有历史');
  expect(h.node('messages').text).toContain('历史加载中的新消息');
  h.requests[1]!.resolve({ status: 'queued' }); await submit;
});

it('isolates late send results on session switches and clears optimistic content on binding revocation and auth changes', async () => {
  const h = harness(); await h.ready(); h.requests[0]!.resolve(h.conversation(0, '', 0)); await h.settle();
  h.node('input').value = '第一会话的消息'; const submit = h.node('composer').onsubmit!({ preventDefault() {} });
  h.choose(1); h.requests[2]!.resolve(h.conversation(1, '', 0)); await h.settle();
  h.node('input').value = '第二会话的草稿'; h.requests[1]!.reject(new Error('late failure')); await submit;
  expect(h.node('messages').text).not.toContain('第一会话的消息'); expect(h.node('input').value).toBe('第二会话的草稿');
  expect(h.node('message-error').textContent).toBe('');
  h.choose(0); expect(h.node('messages').text).toContain('第一会话的消息');
  const retry = h.node('composer').onsubmit!({ preventDefault() {} });
  h.streams.at(-1)!.emit('snapshot', { sessions: [h.rows[1]], conversation: h.conversation(0, '', 0) });
  h.requests[3]!.resolve({ status: 'queued' }); await retry;
  expect(h.node('messages').text).toBe(''); expect(h.node('composer').hidden).toBe(true);
  h.streams.at(-1)!.emit('auth', {}); expect(h.node('messages').text).toBe('');
});


it('renders rich Markdown and separates answer messages without losing streaming or cache updates', async () => {
  const h = harness(); await h.ready();
  const md = new WebMarkdown(), c = h.conversation(0, '', 1);
  const sections = (final: string) => [{ nodes: md.parse('正在检查。') }, { nodes: md.parse(final) }];
  const final = '## 结果\n\n| 工具 | 状态 |\n| -- | -- |\n| **Worker** | `正常` |\n\n[文档](https://example.com)\n\n3. 已修复\n4. 已验证\n\n<script>alert(1)</script>';
  Object.assign(c.turns[0]!, { answer: '正在检查。\n\n' + final, answerSections: sections('**进行中') });
  h.requests[0]!.resolve(c); await h.settle();
  expect(h.node('messages').querySelectorAll('.answer-section')).toHaveLength(2);
  Object.assign(c.turns[0]!, { answerSections: sections(final) });
  h.streams.at(-1)!.emit('snapshot', { sessions: h.rows, conversation: c });
  const box = h.node('messages'), content = box.children[0];
  expect(box.querySelectorAll('h2').map(n => n.text)).toEqual(['结果']);
  expect(box.querySelectorAll('td').map(n => n.text)).toEqual(['Worker', '正常']);
  expect(box.querySelector('.table-scroll')?.getAttribute('tabindex')).toBe('0');
  expect(box.querySelector('ol')?.getAttribute('start')).toBe('3');
  const link = box.querySelector('a')!;
  expect(link.getAttribute('href')).toBe('https://example.com');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  expect(box.querySelectorAll('script')).toHaveLength(0); expect(box.text).toContain('<script>alert(1)</script>');
  expect(box.querySelectorAll('.answer-section').map(n => n.text.startsWith('正在检查。'))).toEqual([true, false]);
  h.choose(1); h.requests[1]!.resolve(h.conversation(1)); await h.settle(); h.choose(0);
  expect(box.children[0]).toBe(content); expect(h.requests).toHaveLength(2);
});
