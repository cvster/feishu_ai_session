import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { SessionCatalog } from '../../../src/session/catalog';
import { startToolNameSync, startWorkerNameSync } from '../../../src/bot/tool-name-sync';
import { ToolRegistry, type AgentTool } from '../../../src/tools/types';
import { DurableAgentAdapter } from '../../../src/worker/adapter';
import { WorkerClient } from '../../../src/worker/client';
import type { WorkerCapabilities } from '../../../src/worker/protocol';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function fixture(toolId: 'codex' | 'claude' | 'dsh' | 'zcode' | 'kilo' = 'zcode') {
  const dir=await mkdtemp(join(tmpdir(),'zcode-names-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
  const bindings=new ToolBindingStore(join(dir,'bindings.json'));await bindings.load();
  const catalog=new SessionCatalog(join(dir,'catalog.json'));await catalog.load();
  cleanup.push(async()=>{await bindings.flush();await catalog.flush();});
  const add=(scope:string,id:string)=>{
    bindings.set(scope,{toolId,sourceId:'local',nativeId:id,name:'old label'});
    catalog.upsertActive({scopeId:scope,agentId:toolId,cwdRealpath:dir,policyFingerprint:scope,
      ...(toolId==='codex'?{threadId:id}:{sessionId:id}),sourceId:'local',botAppId:'bot'});
  };add('oc_group','session_native');
  const legacyAdd=async(scope:string,id:string)=>{
    await bindings.flush();
    await writeFile(join(dir,'bindings.json'),JSON.stringify({version:1,archived:[],bindings:{...Object.fromEntries(bindings.entries()),[scope]:{toolId,sourceId:'local',nativeId:id}}}));
    await bindings.load();
    catalog.upsertActive({scopeId:scope,agentId:toolId,cwdRealpath:dir,policyFingerprint:scope,sessionId:id,sourceId:'local',botAppId:'bot'});
  };
  let title='新会话',group='AA-copy（ZCode）';
  const rename=vi.fn(async(_id:string,name:string)=>{title=name;});
  const list=vi.fn(async()=>[{nativeId:'session_native',name:title,cwd:dir,createdAtMs:1,updatedAtMs:2}]);
  const update=vi.fn(async(p:{data:{name:string}})=>{group=p.data.name;return {code:0};});
  const getChatInfo=vi.fn(async()=>({name:group}));
  const channel={getChatMode:vi.fn(async()=> 'group'),getChatInfo,rawClient:{im:{v1:{chat:{update}}}}} as unknown as LarkChannel;
  const profile=createDefaultProfileConfig({agentKind:'codex',codex:{binaryPath:'codex',inheritCodexHome:true},accounts:{app:{id:'bot',secret:'test',tenant:'feishu'}}});
  const controls={profileConfig:profile,toolBindings:bindings} as unknown as Controls;
  const worker=new WorkerClient(dir,'local','bot',toolId);
  const capabilities: WorkerCapabilities={apiVersion:2,jobs:{submit:true,read:true,stop:true,eventCursor:true},models:true,nativeSessionNames:true,
    sessions:{list:true,history:true,rename:true,archive:false,fork:false},nativeTurnStop:false};
  const health=vi.spyOn(worker,'health').mockResolvedValue({capabilities,zcodeRegistryResume:true,zcodeSessionNames:true});
  const agent=new DurableAgentAdapter(worker,{id:toolId,displayName:toolId,isAvailable:async()=>true,run:()=>{throw Error('Name synchronization must never submit a task');}});
  const tool={id:toolId,sourceId:'local',agent,sessions:{rename},listSessions:list} as unknown as AgentTool;
  const registry=new ToolRegistry();registry.register(tool);controls.toolRegistry=registry;
  if(toolId==='zcode')profile.zcode={binaryPath:'zcode',remoteControlFile:'/private/pair.link'};
  const ready=vi.fn(async()=>true);
  let handle:Awaited<ReturnType<typeof startToolNameSync>>;
  const start=async()=>{handle=await startToolNameSync({channel,controls,catalog,tool,ready,statePath:join(dir,'names.json'),intervalMs:60_000});cleanup.push(()=>handle.stop());await handle.tick();return handle;};
  const startRegistered=async(waitForTick=true)=>{const handle=await startWorkerNameSync({channel,controls,catalog,profileDir:dir,intervalMs:60_000});cleanup.push(()=>handle.stop());if(waitForTick)await handle.tick();return handle;};
  const omitCatalogSource=async()=>{
    await catalog.flush();
    const data=JSON.parse(await readFile(join(dir,'catalog.json'),'utf8'));
    const rows=Array.isArray(data)?data:[...data.history,...Object.values(data.current)];
    for(const row of rows)delete row.sourceId;
    await writeFile(join(dir,'catalog.json'),JSON.stringify(rows));await catalog.load();
  };
  return {dir,bindings,catalog,add,legacyAdd,omitCatalogSource,controls,channel,tool,rename,list,ready,start,startRegistered,health,capabilities,update,getChatInfo,title:(v:string)=>{title=v;},group:(v:string)=>{group=v;}};
}
it.each(['codex','zcode'] as const)('syncs legacy %s catalog rows only after verifying their current binding source',async toolId=>{
  const h=await fixture(toolId);await h.omitCatalogSource();const sync=await h.startRegistered();
  expect(h.rename).toHaveBeenCalledWith('session_native','AA-copy（ZCode）');await sync.tick();
  h.title('AA-桌面改名');await sync.tick();
  expect(h.update).toHaveBeenCalledWith(expect.objectContaining({data:{name:'AA-桌面改名'}}));
});
it.each(['codex','claude','zcode','kilo','dsh'] as const)('stores one current %s route across policy migrations and syncs non-AA titles both ways', async toolId => {
  const h = await fixture(toolId); await h.omitCatalogSource();
  h.title('AA-copy（ZCode）');
  const first = await h.startRegistered();
  const legacy = h.catalog.entries()[0]!;
  h.catalog.upsertActive({ ...legacy, sourceId: 'local', policyFingerprint: 'current-policy', preserveBinding: true });
  expect(h.catalog.entries().filter(row => row.status === 'active' && row.scopeId === 'oc_group')).toHaveLength(1);
  expect(h.catalog.entries().filter(row => row.status === 'archived' && row.scopeId === 'oc_group')).toHaveLength(1);
  h.title('AF-电机误差检测'); await first.tick();
  expect(h.update).toHaveBeenCalledOnce();
  expect(h.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { name: 'AF-电机误差检测' } }));
  expect(h.bindings.get('oc_group')?.name).toBe('AF-电机误差检测');
  await first.stop();
  const restored = await h.startRegistered(); await restored.tick();
  expect(h.update).toHaveBeenCalledOnce(); expect(h.rename).not.toHaveBeenCalled();
  h.group('AF-群中改名'); await restored.tick();
  expect(h.rename).toHaveBeenCalledOnce();
  expect(h.rename).toHaveBeenLastCalledWith('session_native', 'AF-群中改名');
  expect(h.bindings.get('oc_group')?.name).toBe('AF-群中改名');
});
it.each(['wrong-source','wrong-session','wrong-bot','shared'] as const)('rejects legacy catalog rows with %s ownership',async kind=>{
  const h=await fixture('codex');await h.omitCatalogSource();const b=h.bindings.get('oc_group')!;
  if(kind==='wrong-source'){h.bindings.removeChat('oc_group');h.bindings.set('oc_group',{...b,sourceId:'another'});}
  if(kind==='wrong-session')h.bindings.set('oc_group',{...b,nativeId:'another'});
  if(kind==='shared')h.bindings.set('oc_group',{...b,auxiliaryWorkgroup:true});
  if(kind==='wrong-bot')h.controls.profileConfig.accounts.app.id='another';
  await h.startRegistered();expect(h.rename).not.toHaveBeenCalled();expect(h.update).not.toHaveBeenCalled();
});
it('repairs a copied native title from the live group, then mirrors desktop renames without submitting input',async()=>{
  const h=await fixture(),sync=await h.start();
  expect(h.rename).toHaveBeenCalledWith('session_native','AA-copy（ZCode）');
  expect(h.bindings.get('oc_group')?.name).toBe('AA-copy（ZCode）');
  await sync.tick(); // acknowledge our native rename before a subsequent edit
  h.title('AA-桌面改名');await sync.tick();
  expect(h.update).toHaveBeenCalledWith(expect.objectContaining({data:{name:'AA-桌面改名'}}));
  expect(h.bindings.get('oc_group')?.name).toBe('AA-桌面改名');
  expect(JSON.parse(await readFile(join(h.dir,'names.json'),'utf8')).bindings).toHaveLength(1);
});
it.each(['codex','claude','zcode','kilo','dsh'] as const)('backfills a stale %s binding from an unchanged persisted name baseline', async toolId => {
  const h = await fixture(toolId); h.title('AA-copy（ZCode）');
  const first = await h.startRegistered(); await first.stop();
  h.bindings.set('oc_group', { ...h.bindings.get('oc_group')!, name: '旧绑定名' });
  const restored = await h.startRegistered(); await restored.tick();
  expect(h.bindings.get('oc_group')?.name).toBe('AA-copy（ZCode）');
  expect(h.rename).not.toHaveBeenCalled(); expect(h.update).not.toHaveBeenCalled();
  await h.bindings.flush();
  expect(JSON.parse(await readFile(join(h.dir, 'bindings.json'), 'utf8')).bindings.oc_group.name).toBe('AA-copy（ZCode）');
});

it('automatically polls and applies a group rename after 15 seconds by default',async()=>{
  const h=await fixture();vi.useFakeTimers();
  // Explicitly omit the test fixture's slower timer.
  const sync=await startToolNameSync({channel:h.channel,controls:h.controls,catalog:h.catalog,tool:h.tool,
    ready:h.ready,statePath:join(h.dir,'default-names.json')});
  cleanup.push(()=>sync.stop());await sync.tick();
  h.group('15秒后的群名');
  await vi.advanceTimersByTimeAsync(14_999);
  expect(h.list).toHaveBeenCalledOnce();expect(h.rename).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);await sync.tick();
  expect(h.list).toHaveBeenCalledTimes(2);
  expect(h.rename).toHaveBeenLastCalledWith('session_native','15秒后的群名');
});
it('does not skip a name poll when worker metadata latency decreases',async()=>{
  let clock=1_030;vi.spyOn(Date,'now').mockImplementation(()=>clock);
  const h=await fixture(),sync=await h.start();
  // Polls are 15 seconds apart, but this lookup completes 30 ms faster.
  clock=16_000;h.group('群改名');await sync.tick();
  expect(h.rename).toHaveBeenLastCalledWith('session_native','群改名');
});
it.each(['archived','ff','auxiliary','wrong-source','wrong-bot','topic'] as const)('does not rename %s bindings',async kind=>{
  const h=await fixture();
  const b=h.bindings.get('oc_group')!;
  if(kind==='archived')h.catalog.archiveScope('oc_group','session_native');
  if(kind==='ff')h.bindings.set('oc_group',{...b,linkedSource:{toolId:'codex',sourceId:'other',nativeId:'source',historyPath:'/history'}});
  if(kind==='auxiliary')h.bindings.set('oc_group',{...b,auxiliaryWorkgroup:true});
  if(kind==='wrong-source')h.catalog.upsertActive({scopeId:'oc_group',agentId:'zcode',cwdRealpath:h.dir,policyFingerprint:'oc_group',sessionId:'session_native',sourceId:'another',botAppId:'bot'});
  if(kind==='wrong-bot')h.catalog.upsertActive({scopeId:'oc_group',agentId:'zcode',cwdRealpath:h.dir,policyFingerprint:'oc_group',sessionId:'session_native',sourceId:'local',botAppId:'another'});
  if(kind==='topic'){h.catalog.archiveScope('oc_group','session_native');h.add('oc_group:topic','session_native');}
  const sync=await h.start();await sync.tick();
  expect(h.rename).not.toHaveBeenCalled();expect(h.update).not.toHaveBeenCalled();
});
it('waits for an upgraded worker before reading or mutating titles',async()=>{
  const h=await fixture();h.ready.mockResolvedValue(false);await h.start();
  expect(h.list).not.toHaveBeenCalled();expect(h.rename).not.toHaveBeenCalled();
});

it.each(['claude','dsh','zcode'] as const)('starts %s name synchronization from the tool registry and persists both directions across restart',async toolId=>{
  let clock=1000;vi.spyOn(Date,'now').mockImplementation(()=>clock);
  const h=await fixture(toolId),first=await h.startRegistered();
  expect(h.rename).toHaveBeenCalledWith('session_native','AA-copy（ZCode）');
  await first.tick();
  h.group('群改名');clock+=15_001;await first.tick();
  expect(h.rename).toHaveBeenLastCalledWith('session_native','群改名');
  await first.tick();h.title('工具改名');await first.tick();
  expect(h.update).toHaveBeenCalledWith(expect.objectContaining({data:{name:'工具改名'}}));
  expect(h.bindings.get('oc_group')?.name).toBe('工具改名');
  await first.stop();const restarted=await h.startRegistered();await restarted.tick();
  expect(h.rename).toHaveBeenCalledTimes(2);expect(h.update).toHaveBeenCalledOnce();
  expect(JSON.parse(await readFile(join(h.dir,`${toolId}-name-sync.json`),'utf8')).bindings).toHaveLength(1);
});
it.each(['claude','dsh','zcode'] as const)('waits for %s worker capabilities and recovers after an outage',async toolId=>{
  const h=await fixture(toolId);h.health.mockRejectedValue(Error('worker offline'));
  const sync=await h.startRegistered();expect(h.list).not.toHaveBeenCalled();
  h.health.mockResolvedValue({capabilities:{...h.capabilities,sessions:{...h.capabilities.sessions,rename:false}},zcodeRegistryResume:true});
  await sync.tick();expect(h.rename).not.toHaveBeenCalled();expect(h.list).not.toHaveBeenCalled();
  h.health.mockResolvedValue({capabilities:h.capabilities,zcodeRegistryResume:true});
  await sync.tick();expect(h.rename).toHaveBeenCalledOnce();
});
it('keeps CLI ZCode aliases out of automatic native name synchronization',async()=>{
  const h=await fixture();h.health.mockResolvedValue({capabilities:{...h.capabilities,nativeSessionNames:false}});
  await h.startRegistered();expect(h.list).not.toHaveBeenCalled();expect(h.rename).not.toHaveBeenCalled();
});
it.each(['claude','dsh'] as const)('does not enable %s name writes through an older worker',async toolId=>{
  const h=await fixture(toolId);h.health.mockResolvedValue({});await h.startRegistered();
  expect(h.list).not.toHaveBeenCalled();expect(h.rename).not.toHaveBeenCalled();
});
it('requires common capabilities even for older paired ZCode workers',async()=>{
  const h=await fixture();h.health.mockResolvedValue({zcodeRegistryResume:true,zcodeSessionNames:true});await h.startRegistered();
  expect(h.rename).not.toHaveBeenCalled();
});
it.each(['claude','dsh','zcode'] as const)('prevents multiple personal groups from fighting over a %s title',async toolId=>{
  const h=await fixture(toolId);await h.legacyAdd('oc_duplicate','session_native');
  const sync=await h.startRegistered();expect(h.rename).not.toHaveBeenCalled();expect(h.update).not.toHaveBeenCalled();
  h.catalog.archiveScope('oc_duplicate','session_native');h.bindings.removeChat('oc_duplicate');await sync.tick();expect(h.rename).toHaveBeenCalledOnce();
});
it('rechecks duplicate binding ownership immediately before a name write',async()=>{
  const h=await fixture('claude');h.getChatInfo.mockImplementation(async()=>{await h.legacyAdd('oc_duplicate','session_native');return{name:'new name'};});
  await h.startRegistered();expect(h.rename).not.toHaveBeenCalled();expect(h.update).not.toHaveBeenCalled();
});
it('stops polling and prevents a late group lookup from renaming after disconnect',async()=>{
  const h=await fixture('dsh');let release!:(v:{name:string})=>void;
  const pending=new Promise<{name:string}>(resolve=>{release=resolve;});h.getChatInfo.mockReturnValue(pending);
  const first=await h.startRegistered(false);await vi.waitFor(()=>expect(h.getChatInfo).toHaveBeenCalledOnce());
  const stopping=first.stop();release({name:'late rename'});await stopping;
  expect(h.rename).not.toHaveBeenCalled();expect(h.update).not.toHaveBeenCalled();
  const calls=h.list.mock.calls.length;await first.tick();expect(h.list).toHaveBeenCalledTimes(calls);
});

it('retries a failed Web group rename from the native title and keeps the saved baseline across restart', async () => {
  const h = await fixture('claude'), sync = await h.startRegistered();
  h.update.mockRejectedValueOnce(new Error('group write failed'));
  await expect(sync.rename('claude', 'oc_group', 'session_native', 'AA-Web')).rejects.toThrow('group write failed');
  await sync.stop(); const restarted = await h.startRegistered(); await restarted.tick();
  expect(h.update).toHaveBeenLastCalledWith(expect.objectContaining({ data: { name: 'AA-Web' } }));
  expect(h.bindings.get('oc_group')?.name).toBe('AA-Web');
});

it.each(['codex','claude','zcode','kilo','dsh'] as const)('repairs an unchanged unequal %s baseline from the confirmed group name and resumes both-way sync', async toolId => {
  const h = await fixture(toolId), first = await h.startRegistered(); await first.stop();
  h.title('旧会话名'); h.group('当前群名');
  const file = join(h.dir, `${toolId}-name-sync.json`), ledger = JSON.parse(await readFile(file, 'utf8'));
  ledger.bindings[0][1] = { groupName: '当前群名', threadName: '旧会话名' };
  await writeFile(file, JSON.stringify(ledger)); h.rename.mockClear(); h.update.mockClear();
  const restarted = await h.startRegistered(); await restarted.tick();
  expect(h.rename).toHaveBeenCalledOnce(); expect(h.rename).toHaveBeenLastCalledWith('session_native', '当前群名');
  expect(h.update).not.toHaveBeenCalled(); expect(h.bindings.get('oc_group')?.name).toBe('当前群名');
  h.title('新的工具名'); await restarted.tick();
  expect(h.update).toHaveBeenCalledOnce(); expect(h.bindings.get('oc_group')?.name).toBe('新的工具名');
});
