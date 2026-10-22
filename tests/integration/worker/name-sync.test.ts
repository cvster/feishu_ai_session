import { mkdtemp, rm, readFile } from 'node:fs/promises';
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
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture(toolId: 'claude' | 'dsh' | 'zcode' = 'zcode') {
  const dir=await mkdtemp(join(tmpdir(),'zcode-names-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
  const bindings=new ToolBindingStore(join(dir,'bindings.json'));await bindings.load();
  const catalog=new SessionCatalog(join(dir,'catalog.json'));await catalog.load();
  cleanup.push(async()=>{await bindings.flush();await catalog.flush();});
  const add=(scope:string,id:string)=>{
    bindings.set(scope,{toolId,sourceId:'local',nativeId:id,name:'old label'});
    catalog.upsertActive({scopeId:scope,agentId:toolId,cwdRealpath:dir,policyFingerprint:scope,sessionId:id,sourceId:'local',botAppId:'bot'});
  };add('oc_group','session_native');
  let title='新会话',group='AA-copy（ZCode）';
  const rename=vi.fn(async(_id:string,name:string)=>{title=name;});
  const list=vi.fn(async()=>[{nativeId:'session_native',name:title,cwd:dir,createdAtMs:1,updatedAtMs:2}]);
  const update=vi.fn(async(p:{data:{name:string}})=>{group=p.data.name;return {code:0};});
  const getChatInfo=vi.fn(async()=>({name:group}));
  const channel={getChatMode:vi.fn(async()=> 'group'),getChatInfo,rawClient:{im:{v1:{chat:{update}}}}} as unknown as LarkChannel;
  const profile=createDefaultProfileConfig({agentKind:'codex',codex:{binaryPath:'codex',inheritCodexHome:true},accounts:{app:{id:'bot',secret:'test',tenant:'feishu'}}});
  const controls={profileConfig:profile,toolBindings:bindings} as unknown as Controls;
  const worker=new WorkerClient(dir,'local','bot',toolId);
  const capabilities: WorkerCapabilities={apiVersion:2,jobs:{submit:true,read:true,stop:true,eventCursor:true},models:true,
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
  return {dir,bindings,catalog,add,controls,rename,list,ready,start,startRegistered,health,capabilities,update,getChatInfo,title:(v:string)=>{title=v;},group:(v:string)=>{group=v;}};
}
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
  h.group('群改名');clock+=10_001;await first.tick();
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
  const h=await fixture();h.controls.profileConfig.zcode!.remoteControlFile=undefined;
  await h.startRegistered();expect(h.list).not.toHaveBeenCalled();expect(h.health).not.toHaveBeenCalled();
});
it.each(['claude','dsh'] as const)('does not enable %s name writes through an older worker',async toolId=>{
  const h=await fixture(toolId);h.health.mockResolvedValue({});await h.startRegistered();
  expect(h.list).not.toHaveBeenCalled();expect(h.rename).not.toHaveBeenCalled();
});
it('retains paired ZCode naming compatibility with v1 workers',async()=>{
  const h=await fixture();h.health.mockResolvedValue({zcodeRegistryResume:true,zcodeSessionNames:true});await h.startRegistered();
  expect(h.rename).toHaveBeenCalledOnce();
});
it.each(['claude','dsh','zcode'] as const)('prevents multiple personal groups from fighting over a %s title',async toolId=>{
  const h=await fixture(toolId);h.add('oc_duplicate','session_native');
  const sync=await h.startRegistered();expect(h.rename).not.toHaveBeenCalled();expect(h.update).not.toHaveBeenCalled();
  h.catalog.archiveScope('oc_duplicate','session_native');await sync.tick();expect(h.rename).toHaveBeenCalledOnce();
});
it('rechecks duplicate binding ownership immediately before a name write',async()=>{
  const h=await fixture('claude');h.getChatInfo.mockImplementation(async()=>{h.add('oc_duplicate','session_native');return{name:'new name'};});
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
