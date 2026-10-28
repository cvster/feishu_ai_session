import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { fixture } from '../../helpers/worker-fixture';
import { startWorkerReplies } from '../../../src/worker/replies';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionCatalog } from '../../../src/session/catalog';
import { SessionStore } from '../../../src/session/store';
import { ActiveRuns } from '../../../src/bot/active-runs';
import type { Controls } from '../../../src/commands';

async function repliesFixture(mode: 'card' | 'markdown' | 'text' = 'card', privateFF = false) {
  const h = await fixture();
  const scope = privateFF ? 'oc_private' : 'oc_group';
  if (privateFF) h.options.delivery = { ...h.options.delivery!, scope, chatId: 'oc_private', replyTo: 'om_private' };
  const bindings = new ToolBindingStore(join(h.dir, 'bindings.json')); await bindings.load();
  bindings.set(scope, { toolId: 'claude', sourceId: 'local-claude', nativeId: 'native', nativeCreated: false }); await bindings.flush();
  const catalog = new SessionCatalog(join(h.dir, 'catalog.json')); await catalog.load();
  const sessions = new SessionStore(join(h.dir, 'sessions.json')); await sessions.load();
  const profile = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: 'codex', inheritCodexHome: true }, accounts: { app: { id: 'cli_test', secret: 'test', tenant: 'feishu' } } });
  const controls = { profileConfig: profile, toolBindings: bindings, cfg: { preferences: { messageReply: mode, messageReplyMigrated: true } } } as unknown as Controls;
  if (privateFF) controls.auxiliary = { isAuxiliary: (id: string) => id === scope, isActive: () => true, trackRun: async () => {} } as any;
  const reply = vi.fn(async (..._args: unknown[]) => ({ code: 0, data: { message_id: 'om_reply' } }));
  const patch = vi.fn(async () => ({ code: 0 }));
  const channel = { createCard: vi.fn(async () => ({ cardId: 'card_stable' })), updateCardById: vi.fn(async () => {}),
    rawClient: { im: { v1: { message: { reply, patch } } } } } as unknown as LarkChannel;
  const activeRuns = new ActiveRuns();
  const statePath = join(h.dir, 'replies.json');
  const start = () => startWorkerReplies({ adapter: h.adapter, channel, controls, catalog, sessions, activeRuns, statePath, intervalMs: 60_000, renderOptions: () => privateFF ? { auxiliary: true, auxiliaryScope: scope } : {} });
  const job = await h.client.submit({ requestKey: 'message-one', options: h.options });
  await vi.waitFor(async () => expect((await h.client.snapshot(job.id)).events.length).toBeGreaterThan(1));
  return { ...h, job, bindings, catalog, sessions, controls, activeRuns, channel, reply, patch, statePath, start };
}
it('recovers the same reply card and native session after bridge restart, including output produced while disconnected', async () => {
  const h = await repliesFixture(); const first = await h.start(); await first.runNow();
  expect(h.reply).toHaveBeenCalledOnce(); expect(h.sessions.getRaw('oc_group')?.sessionId).toBe('native');
  await h.activeRuns.disconnectAll(); await first.stop(); expect(h.stop).not.toHaveBeenCalled();
  h.finish(); await vi.waitFor(async () => expect((await h.client.snapshot(h.job.id)).job.status).toBe('completed'));
  const second = await h.start();
  try {
    await second.runNow();
    expect(h.reply).toHaveBeenCalledOnce(); expect(h.channel.createCard).toHaveBeenCalledOnce();
    const updates = vi.mocked(h.channel.updateCardById).mock.calls;
    expect(updates.at(-1)![0]).toBe('card_stable');
    expect(JSON.stringify(updates.at(-1)![1])).toContain('after restart');
    expect(updates.at(-1)![2]).toBeGreaterThan(updates[0]![2]); expect(h.calls).toHaveLength(1);
  } finally { await second.stop(); await h.catalog.flush(); await h.sessions.flush(); }
});

it('mentions the owner once after the final reply, recovering an ambiguous notification across restart', async () => {
  const h = await repliesFixture(); h.controls.botOwnerId = 'ou_owner';
  const first = await h.start(); await first.runNow();
  expect(h.reply).toHaveBeenCalledOnce(); // No running mention.
  h.finish(); await vi.waitFor(async () => expect((await h.client.snapshot(h.job.id)).job.status).toBe('completed'));
  h.reply.mockRejectedValueOnce(new Error('completion ack lost'));
  await first.runNow(); await first.stop();
  const second = await h.start();
  try {
    await second.runNow(); await second.runNow();
    expect(h.reply).toHaveBeenCalledTimes(3);
    const requests = h.reply.mock.calls as unknown as any[][];
    expect(requests[1]![0].data.uuid).toBe(requests[2]![0].data.uuid);
    expect(requests[2]![0].path.message_id).toBe('om_reply');
    expect(JSON.parse(requests[2]![0].data.content).zh_cn.content[0][0]).toEqual({ tag: 'at', user_id: 'ou_owner' });
    expect(h.channel.createCard).toHaveBeenCalledOnce();
  } finally { await second.stop(); await h.catalog.flush(); await h.sessions.flush(); }
});
it('recovers all parts of a long worker reply after restart and mentions the owner only after the last card', async () => {
  const h = await repliesFixture(); h.controls.botOwnerId = 'ou_owner';
  const full = Array.from({ length: 4000 }, (_, i) => `第${i}行：完整输出😀\n`).join('');
  const snapshot = h.adapter.client.snapshot.bind(h.adapter.client);
  vi.spyOn(h.adapter.client, 'snapshot').mockImplementation(async id => {
    const result = await snapshot(id);
    const event = result.events.find(row => row.event.type === 'text')!.event;
    if (event.type === 'text') event.delta = full;
    return result;
  });
  const create = vi.mocked(h.channel.createCard);
  create.mockImplementation(async () => ({ cardId: `card_${create.mock.calls.length}` }));
  h.reply.mockImplementation(async () => ({ code: 0, data: { message_id: `om_part_${h.reply.mock.calls.length}` } }));
  const first = await h.start(); await first.runNow();
  const count = create.mock.calls.length; expect(count).toBeGreaterThan(2);
  expect(h.reply).toHaveBeenCalledTimes(count);
  await first.stop(); h.finish();
  await vi.waitFor(async () => expect((await h.client.snapshot(h.job.id)).job.status).toBe('completed'));
  const second = await h.start();
  try {
    await second.runNow(); await second.runNow();
    expect(create).toHaveBeenCalledTimes(count);
    expect(h.reply).toHaveBeenCalledTimes(count + 1);
    const final = h.reply.mock.calls.at(-1)![0] as any;
    expect(final.path.message_id).toBe(`om_part_${count}`);
    expect(final.data.content).toContain('"tag":"at"');
    const latest = new Map(vi.mocked(h.channel.updateCardById).mock.calls.map(([id, card]) => [id, card as any]));
    const output = [...latest.values()].flatMap(card => card.body.elements.filter((element: any) => element.tag === 'markdown' && !element.text_size).map((element: any) => element.content)).join('');
    expect(output).toBe(full + 'after restart');
    expect([...latest.values()].every(card => Buffer.byteLength(JSON.stringify({ data: JSON.stringify(card) })) <= 26_000)).toBe(true);
  } finally { await second.stop(); await h.catalog.flush(); await h.sessions.flush(); }
});
it('recovers an ambiguous reply acknowledgement using the same uuid and does not recreate the card', async () => {
  const h = await repliesFixture();
  h.reply.mockRejectedValueOnce(new Error('connection lost after delivery'));
  const first = await h.start(); await first.runNow(); await first.stop();
  const second = await h.start();
  try {
    await second.runNow(); expect(h.reply).toHaveBeenCalledTimes(2);
    const calls = h.reply.mock.calls as unknown as { data: { uuid: string } }[][];
    expect(calls[0]![0]!.data.uuid).toBe(calls[1]![0]!.data.uuid);
    expect(h.channel.createCard).toHaveBeenCalledOnce(); expect(h.calls).toHaveLength(1);
  } finally { await second.stop(); await h.catalog.flush(); await h.sessions.flush(); }
});
it('stops the original worker task from recovered controls and preserves its interrupted output', async () => {
  const h = await repliesFixture(); const publisher = await h.start();
  try {
    await publisher.runNow(); expect(h.activeRuns.get('oc_group')?.run.runId).toBe(h.job.id);
    expect(await publisher.stopScope('oc_group')).toBe(true);
    await vi.waitFor(async () => expect((await h.client.snapshot(h.job.id)).job.status).toBe('interrupted'));
    await publisher.runNow(); expect(h.stop).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(h.channel.updateCardById).mock.calls.at(-1)![1])).toContain('已被中断');
  } finally { await publisher.stop(); await h.catalog.flush(); await h.sessions.flush(); }
});
it.each(['markdown', 'text'] as const)('retains %s delivery semantics after restart', async mode => {
  const h = await repliesFixture(mode); const first = await h.start(); await first.runNow();
  expect(h.channel.createCard).not.toHaveBeenCalled();
  if (mode === 'text') expect(h.reply).not.toHaveBeenCalled();
  else expect(h.reply).toHaveBeenCalledOnce();
  await first.stop(); h.finish(); await vi.waitFor(async () => expect((await h.client.snapshot(h.job.id)).job.status).toBe('completed'));
  const second = await h.start();
  try {
    await second.runNow(); expect(h.reply).toHaveBeenCalledOnce();
    if (mode === 'markdown') expect(JSON.stringify(h.patch.mock.calls.at(-1))).toContain('after restart');
    else expect(JSON.stringify(h.reply.mock.calls.at(-1))).toContain('after restart');
  } finally { await second.stop(); await h.catalog.flush(); await h.sessions.flush(); }
});
it('never replies to an archived group and fails closed beyond the ambiguous-send deduplication window', async () => {
  const h = await repliesFixture(); h.reply.mockRejectedValue(new Error('unknown delivery'));
  const first = await h.start(); await first.runNow(); await first.stop();
  const ledger = JSON.parse(await readFile(h.statePath, 'utf8'));
  ledger.deliveries[h.job.id].sendingSince = Date.now() - 60 * 60_000; await writeFile(h.statePath, JSON.stringify(ledger));
  const second = await h.start(); await second.runNow(); expect(h.reply).toHaveBeenCalledOnce(); await second.stop();
  h.catalog.archiveScope('oc_group', 'native'); await h.catalog.flush();
  const third = await h.start();
  try { await third.runNow(); expect(h.reply).toHaveBeenCalledOnce(); }
  finally { await third.stop(); await h.sessions.flush(); }
});

it('delivers a private Claude FF result only as a reply to its private request, including after restart', async () => {
  const h = await repliesFixture('markdown', true); const first = await h.start();
  try {
    await first.runNow();
    expect(h.reply).toHaveBeenCalledOnce();
    expect(h.reply.mock.calls[0]?.[0]).toMatchObject({ path: { message_id: 'om_private' }, data: { msg_type: 'interactive' } });
    expect(JSON.stringify(vi.mocked(h.channel.createCard).mock.calls)).not.toContain('request_id=');
    await first.stop(); h.finish();
    await vi.waitFor(async () => expect((await h.client.snapshot(h.job.id)).job.status).toBe('completed'));
    const recovered = await h.start();
    try { await recovered.runNow(); expect(h.reply).toHaveBeenCalledOnce(); }
    finally { await recovered.stop(); }
  } finally { await first.stop(); await h.catalog.flush(); await h.sessions.flush(); }
});

it('reattaches an interrupted observer to its exact live native turn, keeping the card across restart', async () => {
  const h = await repliesFixture(); h.controls.botOwnerId = 'ou_owner';
  const publisher = await h.start(); await publisher.runNow();
  await h.client.stop(h.job.id);
  await vi.waitFor(async () => expect((await h.client.snapshot(h.job.id)).job.status).toBe('interrupted'));
  await publisher.runNow(); await publisher.stop();
  const notificationCount = h.reply.mock.calls.length;
  const { initialState, reduce } = await import('../../../src/card/run-state');
  let state = reduce(initialState, { type: 'text', delta: 'native resumed output' });
  const health = await h.adapter.client.health();
  vi.spyOn(h.adapter.client, 'health').mockResolvedValue({ ...health, capabilities: { ...health.capabilities!, conversation: true, nativeTurnStop: true } });
  const conversation = vi.spyOn(h.adapter.client, 'conversation').mockImplementation(async () => ({
    id: 'native', cwd: h.dir, archived: false,
    turns: [{ id: 'original-turn', bridge: true, bridgeJobId: h.job.id, input: '', createdAtMs: h.job.createdAt, state },
      { id: 'new-queued-turn', bridge: true, bridgeJobId: 'another-job', input: '', createdAtMs: Date.now(), state: initialState }],
  }));
  const second = await h.start();
  try {
    await second.runNow();
    expect(JSON.stringify(vi.mocked(h.channel.updateCardById).mock.calls.at(-1)![1])).toContain('native resumed output');
    expect(h.channel.createCard).toHaveBeenCalledOnce(); expect(h.reply).toHaveBeenCalledTimes(notificationCount);
    expect(h.calls).toHaveLength(1);
    expect(second.ownsRecoveredMessage('oc_other', 'om_reply')).toBe(false);
    expect(second.ownsRecoveredMessage('oc_group', 'om_reply')).toBe(true);
    await second.runNow(); expect(conversation).toHaveBeenCalledOnce();
    await second.stop();
    const third = await h.start();
    try {
      await third.runNow();
      const stopTurn = vi.spyOn(h.adapter.client, 'stopNativeTurn').mockResolvedValue(true);
      await third.stopMessage('oc_group', 'om_reply');
      expect(stopTurn).toHaveBeenCalledWith('native', 'original-turn', h.dir);
      state = reduce(state, { type: 'done', terminationReason: 'normal' });
      await third.refreshMessage('oc_group', 'om_reply');
      const ledger = JSON.parse(await readFile(h.statePath, 'utf8'));
      expect(ledger.deliveries[h.job.id].nativeRecovery.finished).toBe(true);
      expect(h.reply).toHaveBeenCalledTimes(notificationCount); expect(h.calls).toHaveLength(1);
      await third.refreshMessage('oc_group', 'om_reply');
      expect(JSON.stringify(vi.mocked(h.channel.updateCardById).mock.calls.at(-1)![1])).toContain('native resumed output');
      expect(h.channel.createCard).toHaveBeenCalledOnce();
      const updates = vi.mocked(h.channel.updateCardById).mock.calls.length;
      conversation.mockRejectedValueOnce(new Error('native API offline'));
      await third.refreshMessage('oc_group', 'om_reply');
      expect(h.channel.updateCardById).toHaveBeenCalledTimes(updates);
    } finally { await third.stop(); }
  } finally { await second.stop(); await h.catalog.flush(); await h.sessions.flush(); }
});

it.each(['different-job', 'wrong-cwd', 'archived', 'interrupted'] as const)('does not reattach an interrupted card to %s native history', async mismatch => {
  const h = await repliesFixture(); const first = await h.start(); await first.runNow();
  await h.client.stop(h.job.id);
  await vi.waitFor(async () => expect((await h.client.snapshot(h.job.id)).job.status).toBe('interrupted'));
  await first.runNow(); await first.stop();
  const health = await h.adapter.client.health();
  vi.spyOn(h.adapter.client, 'health').mockResolvedValue({ ...health, capabilities: { ...health.capabilities!, conversation: true } });
  const { initialState, reduce } = await import('../../../src/card/run-state');
  vi.spyOn(h.adapter.client, 'conversation').mockResolvedValue({ id: 'native', cwd: mismatch === 'wrong-cwd' ? '/other-project' : h.dir,
    archived: mismatch === 'archived', turns: [{ id: 'other-turn', bridge: true, input: '', createdAtMs: Date.now(),
      bridgeJobId: mismatch === 'different-job' ? 'another-job' : h.job.id,
      state: mismatch === 'interrupted' ? reduce(initialState, { type: 'done', terminationReason: 'interrupted' }) : initialState }] });
  const count = vi.mocked(h.channel.updateCardById).mock.calls.length;
  const second = await h.start();
  try { await second.runNow(); expect(h.channel.updateCardById).toHaveBeenCalledTimes(count); expect(h.calls).toHaveLength(1); }
  finally { await second.stop(); await h.catalog.flush(); await h.sessions.flush(); }
});


it('repairs the original card when the native turn finished while its worker observer was interrupted', async () => {
  const h = await repliesFixture(); const first = await h.start(); await first.runNow();
  await h.client.stop(h.job.id);
  await vi.waitFor(async () => expect((await h.client.snapshot(h.job.id)).job.status).toBe('interrupted'));
  await first.runNow(); await first.stop();
  const health = await h.adapter.client.health();
  vi.spyOn(h.adapter.client, 'health').mockResolvedValue({ ...health, capabilities: { ...health.capabilities!, conversation: true } });
  const { initialState, reduce } = await import('../../../src/card/run-state');
  const state = reduce(reduce(initialState, { type: 'text', delta: 'final native answer' }), { type: 'done', terminationReason: 'normal' });
  vi.spyOn(h.adapter.client, 'conversation').mockResolvedValue({ id: 'native', cwd: h.dir, archived: false,
    turns: [{ id: 'original-turn', bridge: true, bridgeJobId: h.job.id, input: '', createdAtMs: h.job.createdAt, state }] });
  const second = await h.start();
  try {
    await second.runNow();
    expect(JSON.stringify(vi.mocked(h.channel.updateCardById).mock.calls.at(-1)![1])).toContain('final native answer');
    expect(h.channel.createCard).toHaveBeenCalledOnce(); expect(h.calls).toHaveLength(1);
    const count = vi.mocked(h.channel.updateCardById).mock.calls.length;
    await second.runNow(); expect(h.channel.updateCardById).toHaveBeenCalledTimes(count);
  } finally { await second.stop(); await h.catalog.flush(); await h.sessions.flush(); }
});


it('keeps queue rows after the five controls on the same live card, including idle updates and restart', async () => {
  const h = await repliesFixture();
  let items = [{ id: 'one', text: 'long queued message '.repeat(80), senderName: 'Nick', createdAtMs: 1 }];
  h.controls.messageQueue = { list: () => items, remove: async () => true, observeReply: () => {}, forReply: () => items };
  const first = await h.start();
  try {
    await first.runNow();
    const card = vi.mocked(h.channel.updateCardById).mock.calls.at(-1)![1] as any;
    const controls = card.body.elements.findIndex((e: any) => e.tag === 'column_set' && e.columns.length === 5);
    expect(card.body.elements[controls + 1].content).toContain('排队消息（1）');
    expect(card.body.elements[controls + 2].columns[0].elements[0].text.lines).toBe(1);
    expect(card.body.elements[controls + 2].columns[0].elements[0].text.content).toContain('…');
    items = [...items, { id: 'two', text: 'second queued message', senderName: 'Nick', createdAtMs: 2 }];
    await first.runNow();
    expect(JSON.stringify(vi.mocked(h.channel.updateCardById).mock.calls.at(-1)![1])).toContain('second queued message');
    expect(h.reply).toHaveBeenCalledOnce(); expect(h.channel.createCard).toHaveBeenCalledOnce();
    await first.stop(); const second = await h.start();
    try {
      await second.runNow(); items = []; await second.runNow();
      expect(JSON.stringify(vi.mocked(h.channel.updateCardById).mock.calls.at(-1)![1])).not.toContain('排队消息');
      expect(h.reply).toHaveBeenCalledOnce(); expect(h.channel.createCard).toHaveBeenCalledOnce();
    } finally { await second.stop(); }
  } finally { await first.stop(); await h.catalog.flush(); await h.sessions.flush(); }
});
it('keeps controls and queue together on the last part of an oversized reply', async () => {
  const h = await repliesFixture();
  const snapshot = h.adapter.client.snapshot.bind(h.adapter.client);
  vi.spyOn(h.adapter.client, 'snapshot').mockImplementation(async id => {
    const result = await snapshot(id); const event = result.events.find(row => row.event.type === 'text')!.event;
    if (event.type === 'text') event.delta = 'long answer line '.repeat(4000);
    return result;
  });
  h.controls.messageQueue = { list: () => [], remove: async () => true, observeReply: () => {},
    forReply: () => [{ id: 'waiting', text: 'next task', senderName: 'Nick', createdAtMs: 1 }] };
  const publisher = await h.start();
  try {
    await publisher.runNow(); const calls = vi.mocked(h.channel.updateCardById).mock.calls;
    const last = calls.at(-1)![1] as any;
    expect(last.body.elements.at(-3).columns).toHaveLength(5);
    expect(last.body.elements.at(-2).content).toContain('排队消息（1）');
    expect(last.body.elements.at(-1).columns[1].elements[0].behaviors[0].value).toEqual({ cmd: 'queue.remove', arg: 'waiting' });
    expect(calls.every(([, card]) => Buffer.byteLength(JSON.stringify({ data: JSON.stringify(card) })) <= 26_000)).toBe(true);
  } finally { await publisher.stop(); await h.catalog.flush(); await h.sessions.flush(); }
});

it('does not mention the owner when a private auxiliary conversation finishes', async () => {
  const h = await repliesFixture('card', true); h.controls.botOwnerId = 'ou_owner';
  const sync = await h.start();
  try {
    await sync.runNow(); h.finish();
    await vi.waitFor(async () => expect((await h.client.snapshot(h.job.id)).job.status).toBe('completed'));
    await sync.runNow(); await sync.runNow();
    expect(h.reply.mock.calls.filter(([request]) => (request as any).data.msg_type === 'post')).toHaveLength(0);
  } finally { await sync.stop(); }
});


it('keeps the latest long shared reply expanded, folds its predecessor only after a newer card is delivered, and retains that choice after restart', async () => {
  const h = await repliesFixture('card', true); h.finish();
  await vi.waitFor(async () => expect((await h.client.snapshot(h.job.id)).job.status).toBe('completed'));
  const first = await h.client.snapshot(h.job.id);
  const long = '正文'.repeat(600);
  first.events = first.events.filter(row => row.event.type !== 'text');
  first.events.splice(1, 0, { seq: 999, at: Date.now(), event: { type: 'text', delta: long } });
  const next = { ...first.job, id: 'newer-shared-reply', createdAt: first.job.createdAt + 100,
    options: { ...first.job.options, delivery: { ...first.job.options.delivery!, replyTo: 'om_next', messageIds: ['om_next'] } } };
  let listed = [first.job];
  vi.spyOn(h.client, 'list').mockImplementation(async () => listed);
  vi.spyOn(h.client, 'snapshot').mockImplementation(async id => id === next.id ? { job: next, events: first.events.map(row => row.event.type === 'text'
    ? { ...row, event: { type: 'text', delta: '最新回答：' + long } } : row) } : first);
  let count = 0;
  vi.mocked(h.channel.createCard).mockImplementation(async () => ({ cardId: 'card-' + ++count }));
  h.reply.mockImplementation(async () => ({ code: 0, data: { message_id: 'message-' + count } }));
  let publisher = await h.start();
  try {
    await publisher.runNow();
    const updates = vi.mocked(h.channel.updateCardById);
    expect(JSON.stringify(updates.mock.calls.filter(([id]) => id === 'card-1').at(-1)![1])).not.toContain('collapsible_panel');
    listed = [first.job, next];
    h.reply.mockRejectedValueOnce(Error('new reply unavailable'));
    await publisher.runNow();
    expect(JSON.stringify(updates.mock.calls.filter(([id]) => id === 'card-1').at(-1)![1])).not.toContain('collapsible_panel');
    await publisher.runNow();
    expect(JSON.stringify(updates.mock.calls.filter(([id]) => id === 'card-1').at(-1)![1])).toContain('collapsible_panel');
    expect(JSON.stringify(updates.mock.calls.filter(([id]) => id === 'card-2').at(-1)![1])).not.toContain('collapsible_panel');
    await publisher.stop(); publisher = await h.start(); await publisher.runNow();
    expect(h.channel.createCard).toHaveBeenCalledTimes(2);
    const ledger = JSON.parse(await readFile(h.statePath, 'utf8')).deliveries;
    expect(ledger[first.job.id]).toMatchObject({ auxiliaryPreviousReply: true, auxiliaryLayoutVersion: 1 });
    expect(ledger[next.id]).toMatchObject({ auxiliaryPreviousReply: false, auxiliaryLayoutVersion: 1 });
  } finally { await publisher.stop(); await h.catalog.flush(); await h.sessions.flush(); }
});
