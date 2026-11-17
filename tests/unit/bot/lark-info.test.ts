import { afterEach, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { fetchKnownChatsResult, fetchChatInfoResult, invalidateChatInfo } from '../../../src/bot/lark-info';
import { createBoundChat, renameChat, dissolveChat } from '../../../src/bot/group';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
  let name = 'AA-original';
  const list = vi.fn(async () => [{ id: 'oc_group', name }]);
  const get = vi.fn(async () => ({ code: 0, data: { name, chat_mode: 'group', chat_status: 'normal' } }));
  const update = vi.fn(async ({ data }: { data: { name: string } }) => { name = data.name; return { code: 0 }; });
  const remove = vi.fn(async () => ({ code: 0 }));
  const create = vi.fn(async () => ({ code: 0, data: { chat_id: 'oc_new' } }));
  const channel = { listChats: list, rawClient: { im: { v1: { chat: { get, update, delete: remove, create } } } } } as unknown as LarkChannel;
  return { channel, list, get, update, remove, create, name: (value: string) => { name = value; } };
}

it('shares one roster across six tools, isolates returned objects and expires it at 15 seconds', async () => {
  vi.useFakeTimers(); const h = fixture();
  const results = await Promise.all(Array.from({ length: 6 }, () => fetchKnownChatsResult(h.channel)));
  expect(h.list).toHaveBeenCalledOnce();
  if (results[0]!.ok) results[0]!.chats[0]!.name = 'mutated';
  expect((await fetchKnownChatsResult(h.channel))).toMatchObject({ chats: [{ name: 'AA-original' }] });
  h.name('AA-renamed'); await vi.advanceTimersByTimeAsync(15_000);
  expect(await fetchKnownChatsResult(h.channel)).toMatchObject({ chats: [{ name: 'AA-renamed' }] });
  expect(h.list).toHaveBeenCalledTimes(2);
});

it('reuses 84 detail reads over repeated console/cleanup polls while preserving their actual timestamps', async () => {
  vi.useFakeTimers(); const h = fixture(), ids = Array.from({ length: 84 }, (_, i) => `oc_${i}`);
  const first = await Promise.all(ids.map(id => fetchChatInfoResult(h.channel, id)));
  for (let round = 0; round < 6; round++) {
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await Promise.all(ids.map(id => fetchChatInfoResult(h.channel, id)));
    expect(result.map(r => r.checkedAtMs)).toEqual(first.map(r => r.checkedAtMs));
  }
  expect(h.get).toHaveBeenCalledTimes(84);
  await vi.advanceTimersByTimeAsync(240_000);
  await fetchChatInfoResult(h.channel, ids[0]!); expect(h.get).toHaveBeenCalledTimes(85);
  await fetchChatInfoResult(h.channel, ids[0]!, true); expect(h.get).toHaveBeenCalledTimes(86);
});

it('isolates bot accounts and never invents details or dissolution from an omitted roster entry', async () => {
  const a = fixture(), b = fixture(); a.list.mockResolvedValue([]);
  await fetchKnownChatsResult(a.channel);
  expect(await fetchChatInfoResult(a.channel, 'oc_missing')).toMatchObject({ data: { chat_status: 'normal' } });
  await fetchChatInfoResult(b.channel, 'oc_missing');
  expect(a.get).toHaveBeenCalledOnce(); expect(b.get).toHaveBeenCalledOnce();
});

it('coalesces concurrent detail failures, backs off briefly, and never serves expired success as current evidence', async () => {
  vi.useFakeTimers(); const h = fixture();
  await fetchChatInfoResult(h.channel, 'oc_group');
  await vi.advanceTimersByTimeAsync(300_000);
  h.get.mockRejectedValue(new Error('network unavailable'));
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => fetchChatInfoResult(h.channel, 'oc_group')));
  expect(results.every(r => r.status === 'rejected')).toBe(true); expect(h.get).toHaveBeenCalledTimes(2);
  await expect(fetchChatInfoResult(h.channel, 'oc_group')).rejects.toThrow('network unavailable');
  expect(h.get).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000);
  h.get.mockResolvedValue({ code: 0, data: { name: 'new', chat_mode: 'group', chat_status: 'normal' } });
  expect(await fetchChatInfoResult(h.channel, 'oc_group')).toMatchObject({ data: { name: 'new' } });
});

it('backs off roster failures without returning a stale successful list', async () => {
  vi.useFakeTimers(); const h = fixture(); await fetchKnownChatsResult(h.channel);
  await vi.advanceTimersByTimeAsync(15_000); h.list.mockRejectedValue(new Error('offline'));
  expect(await fetchKnownChatsResult(h.channel)).toEqual({ ok: false, chats: [] });
  expect(await fetchKnownChatsResult(h.channel)).toEqual({ ok: false, chats: [] });
  expect(h.list).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000); h.list.mockResolvedValue([{ id: 'oc_group', name: 'back' }]);
  expect(await fetchKnownChatsResult(h.channel)).toMatchObject({ ok: true, chats: [{ name: 'back' }] });
});

it('invalidates pending reads so a late pre-write response cannot refill the shared cache', async () => {
  const h = fixture(); let release!: (value: Awaited<ReturnType<typeof h.get>>) => void;
  h.get.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const pending = fetchChatInfoResult(h.channel, 'oc_group');
  invalidateChatInfo(h.channel, 'oc_group'); h.name('new');
  expect(await fetchChatInfoResult(h.channel, 'oc_group')).toMatchObject({ data: { name: 'new' } });
  release({ code: 0, data: { name: 'old', chat_mode: 'group', chat_status: 'normal' } }); await pending;
  expect(await fetchChatInfoResult(h.channel, 'oc_group')).toMatchObject({ data: { name: 'new' } });
  expect(h.get).toHaveBeenCalledTimes(2);
});

it('invalidates successful group mutations but retains cached evidence after a rejected rename', async () => {
  const h = fixture(); await fetchKnownChatsResult(h.channel); await fetchChatInfoResult(h.channel, 'oc_group');
  h.update.mockResolvedValueOnce({ code: 232017 });
  await expect(renameChat(h.channel, 'oc_group', 'denied')).rejects.toThrow('232017');
  await fetchKnownChatsResult(h.channel); expect(h.list).toHaveBeenCalledOnce();
  await renameChat(h.channel, 'oc_group', 'renamed');
  expect(await fetchChatInfoResult(h.channel, 'oc_group')).toMatchObject({ data: { name: 'renamed' } });
  await fetchKnownChatsResult(h.channel); expect(h.list).toHaveBeenCalledTimes(2);
  await dissolveChat(h.channel, 'oc_group'); await fetchChatInfoResult(h.channel, 'oc_group');
  expect(h.get).toHaveBeenCalledTimes(3);
  await createBoundChat({ channel: h.channel, name: 'new group', inviteOpenId: 'ou_owner' });
  await fetchKnownChatsResult(h.channel); expect(h.list).toHaveBeenCalledTimes(3);
});
