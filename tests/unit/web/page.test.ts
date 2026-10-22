import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';
import { bridgeWebPage } from '../../../apps/bridge-web/page';

// Exercise the shipped browser script with controlled HTTP/SSE arrival order.
class Element {
  children: Element[] = [];
  textContent = '';
  className = '';
  hidden = false;
  value = '';
  disabled = false;
  clientHeight = 480;
  private top = 0;
  onclick?: (event?: { stopPropagation(): void }) => void | Promise<void>;
  onsubmit?: (event: { preventDefault(): void }) => Promise<void>;
  onkeydown?: (event: { key: string; preventDefault(): void }) => void;
  open = false;
  isConnected = true;
  style: Record<string, string> = {};
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
  querySelectorAll(selector: string): Element[] { const match = (child: Element) => selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : selector === 'button:not(:disabled)' ? child.tag === 'button' && !child.disabled : child.tag === selector; return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(tag: string) { return this.querySelectorAll(tag)[0]; }
  get text(): string { return this.textContent + this.children.map(child => child.text).join(''); }
}

function harness() {
  const ids = [...bridgeWebPage.matchAll(/id="([^"]+)"/g)].map(match => match[1]!);
  const elements = new Map(ids.map(id => [id, new Element('div', id)]));
  const node = (id: string) => elements.get(id)!;
  node('session-menu').hidden = true; node('session-menu').append(node('session-rename'), node('session-archive'), node('session-copy'));
  for (const action of ['stop', 'refresh']) { const button = new Element('button'); button.setAttribute('data-control', action); node('session-controls').append(button); }
  const rows = ['a', 'b'].map((id, index) => ({ id: id.repeat(64), toolId: 'generic', tool: 'Tool',
    project: 'project', cwd: '/project', scope: 'oc_' + id, name: '会话' + index, online: true, canSend: true, canRename: true }));
  const conversation = (index: number, answer = '回答', count = 12) => ({ session: rows[index], turns: Array.from({ length: count }, (_, i) => ({
    id: String(i), input: '问题' + i, answer, status: 'completed', origin: 'native', createdAtMs: 1,
  })) });
  const requests: { id: string; path: string; data?: any; resolve(value: unknown): void }[] = [];
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
  runInNewContext(bridgeWebPage.match(/<script>([\s\S]*?)<\/script>/)![1]!, {
    document: { getElementById: node, createElement: (tag: string) => new Element(tag), body: new Element('body'), addEventListener() {} },
    window: { innerWidth: 1280, innerHeight: 900, addEventListener() {} },
    fetch: async (path: string, options?: { body?: string }) => {
      if (path === '/api/access') return response({ loginRequired: false });
      if (path === '/api/sessions') return response(rows);
      // Deliberately allow a response after abort to check the selection guard.
      return new Promise(resolve => requests.push({ id: path.split('/').at(-1)!, path, data: options?.body ? JSON.parse(options.body) : undefined, resolve: value => resolve(response(value)) }));
    },
    EventSource: Stream, AbortController, localStorage: { getItem: () => null },
  });
  const ready = () => vi.waitFor(() => expect(requests).toHaveLength(1));
  const choose = (index: number) => { void node('tree').querySelectorAll('button').find(button => button.textContent === rows[index]!.name)!.onclick!(); };
  const menu = (index: number) => node('tree').querySelectorAll('button').find(button => button.getAttribute('aria-label') === rows[index]!.name + '的会话选项')!.onclick!({ stopPropagation() {} });
  const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  const snapshot = (index: number, answer?: string, count?: number) => Stream.all.at(-1)!.emit('snapshot', { sessions: rows, conversation: conversation(index, answer, count) });
  return { node, rows, requests, ready, choose, menu, settle, snapshot, conversation, streams: Stream.all };
}

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
  h.requests[1]!.resolve({ name: '修改的第二个会话' }); await saving;
  expect(h.rows[0]!.name).toBe('会话0'); expect(h.rows[1]!.name).toBe('修改的第二个会话');
  expect(h.node('title').textContent).toBe('会话0'); expect(h.node('rename-dialog').open).toBe(false);
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
