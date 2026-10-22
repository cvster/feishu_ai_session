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
  onclick?: () => Promise<void>;
  classList = { remove() {}, toggle() {} };
  constructor(readonly tag = 'div', readonly id = '') {}
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute() {}
  addEventListener() {}
  close() {}
  focus() {}
  get scrollHeight(): number { return this.id === 'messages' ? Math.max(480, (this.children[0]?.children.length ?? 0) * 240) : 480; }
  get scrollTop() { return Math.min(this.top, this.scrollHeight - this.clientHeight); }
  set scrollTop(value: number) { this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
  querySelectorAll(tag: string): Element[] { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  querySelector(tag: string) { return this.querySelectorAll(tag)[0]; }
  get text(): string { return this.textContent + this.children.map(child => child.text).join(''); }
}

function harness() {
  const ids = [...bridgeWebPage.matchAll(/id="([^"]+)"/g)].map(match => match[1]!);
  const elements = new Map(ids.map(id => [id, new Element('div', id)]));
  const node = (id: string) => elements.get(id)!;
  const rows = ['a', 'b'].map((id, index) => ({ id: id.repeat(64), toolId: 'generic', tool: 'Tool',
    project: 'project', cwd: '/project', scope: 'oc_' + id, name: '会话' + index, online: true, canSend: true, canRename: true }));
  const conversation = (index: number, answer = '回答', count = 12) => ({ session: rows[index], turns: Array.from({ length: count }, (_, i) => ({
    id: String(i), input: '问题' + i, answer, status: 'completed', origin: 'native', createdAtMs: 1,
  })) });
  const requests: { id: string; resolve(value: unknown): void }[] = [];
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
    document: { getElementById: node, createElement: (tag: string) => new Element(tag), body: new Element('body') },
    fetch: async (path: string) => {
      if (path === '/api/access') return response({ loginRequired: false });
      if (path === '/api/sessions') return response(rows);
      // Deliberately allow a response after abort to check the selection guard.
      return new Promise(resolve => requests.push({ id: path.split('/').at(-1)!, resolve: value => resolve(response(value)) }));
    },
    EventSource: Stream, AbortController, localStorage: { getItem: () => null },
  });
  const ready = () => vi.waitFor(() => expect(requests).toHaveLength(1));
  const choose = (index: number) => { void node('tree').querySelectorAll('button').find(button => button.textContent === rows[index]!.name)!.onclick!(); };
  const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
  const snapshot = (index: number, answer?: string, count?: number) => Stream.all.at(-1)!.emit('snapshot', { sessions: rows, conversation: conversation(index, answer, count) });
  return { node, rows, requests, ready, choose, settle, snapshot, conversation, streams: Stream.all };
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
  h.streams.at(-1)!.emit('auth', {});
  expect(h.node('messages').text).toBe(''); expect(h.node('composer').hidden).toBe(true);
});
