import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import type { Controls } from '../../../src/commands';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { ToolBindingStore } from '../../../src/tools/bindings';
import { SessionCatalog } from '../../../src/session/catalog';
import { startToolNameSync } from '../../../src/bot/tool-name-sync';
import type { AgentTool } from '../../../src/tools/types';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'zcode-names-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));
  const bindings=new ToolBindingStore(join(dir,'bindings.json'));await bindings.load();
  const catalog=new SessionCatalog(join(dir,'catalog.json'));await catalog.load();
  cleanup.push(async()=>{await bindings.flush();await catalog.flush();});
  const add=(scope:string,id:string)=>{
    bindings.set(scope,{toolId:'zcode',sourceId:'local',nativeId:id,name:'old label'});
    catalog.upsertActive({scopeId:scope,agentId:'zcode',cwdRealpath:dir,policyFingerprint:scope,sessionId:id,sourceId:'local',botAppId:'bot'});
  };add('oc_group','session_native');
  let title='新会话',group='AA-copy（ZCode）';
  const rename=vi.fn(async(_id:string,name:string)=>{title=name;});
  const list=vi.fn(async()=>[{nativeId:'session_native',name:title,cwd:dir,createdAtMs:1,updatedAtMs:2}]);
  const update=vi.fn(async(p:{data:{name:string}})=>{group=p.data.name;return {code:0};});
  const getChatInfo=vi.fn(async()=>({name:group}));
  const channel={getChatMode:vi.fn(async()=> 'group'),getChatInfo,rawClient:{im:{v1:{chat:{update}}}}} as unknown as LarkChannel;
  const profile=createDefaultProfileConfig({agentKind:'codex',codex:{binaryPath:'codex',inheritCodexHome:true},accounts:{app:{id:'bot',secret:'test',tenant:'feishu'}}});
  const controls={profileConfig:profile,toolBindings:bindings} as unknown as Controls;
  const tool={id:'zcode',sourceId:'local',sessions:{rename},listSessions:list} as unknown as AgentTool;
  const ready=vi.fn(async()=>true);
  let handle:Awaited<ReturnType<typeof startToolNameSync>>;
  const start=async()=>{handle=await startToolNameSync({channel,controls,catalog,tool,ready,statePath:join(dir,'names.json'),intervalMs:60_000});cleanup.push(()=>handle.stop());await handle.tick();return handle;};
  return {dir,bindings,catalog,add,controls,rename,list,ready,start,update,getChatInfo,title:(v:string)=>{title=v;},group:(v:string)=>{group=v;}};
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
