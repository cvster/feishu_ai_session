import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PiAdapter } from '../../../src/agent/pi/adapter';
import { PiSessionProvider } from '../../../src/tools/pi-sessions';
import { PiNativeConversationReader } from '../../../src/agent/pi/conversation';
import { piActiveBranch } from '../../../src/agent/pi/sessions';
import { piProvidersFromZcode } from '../../../src/agent/pi/import-zcode';
import type { AgentEvent } from '../../../src/agent/types';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createWorkerProvider } from '../../../src/worker/providers';
import { startWorkerServer } from '../../../src/worker/server';
import { discoverWorkers, workerTool } from '../../../src/worker/discovery';
import { WorkerClient } from '../../../src/worker/client';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function harness(mode?: string) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-pi-')); roots.push(root);
  const options = { binary: process.execPath, args: [fileURLToPath(new URL('./fixture.cjs', import.meta.url)), ...(mode ? [`--fixture-mode=${mode}`] : [])], agentDir: root };
  const adapter = new PiAdapter(options), provider = new PiSessionProvider(options);
  const requests = async (): Promise<any[]> => (await readFile(join(root,'requests.jsonl'),'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const collect = async (extra = {}) => {
    const run = adapter.run({ runId: 'pi-job', prompt: 'raw\u2028中文\u2029', cwd: root, accessMode: 'full', ...extra });
    const events: AgentEvent[]=[];for await(const event of run.events)events.push(event);
    expect(await run.waitForExit(5000)).toBe(true);return events;
  };
  return { root, options, adapter, provider, collect, requests };
}
it('reads native model identities and reasoning levels privately without submitting a prompt', async () => {
  const h=await harness(), models=await h.adapter.listModels();
  expect(models.map(m=>m.value)).toEqual(['tars/model/one','other/model/one']);
  expect(models[0]).toMatchObject({isDefault:true,reasoningEfforts:[{value:'off',label:'off'},{value:'low',label:'low'},{value:'high',label:'high'}]});
  expect((await h.requests()).some(r=>r.type==='prompt')).toBe(false);
  expect((await h.requests()).every(r=>r.argv.includes('--no-session'))).toBe(true);
});
it('preserves Unicode prompt framing, deduplicates final text and waits for settled after agent_end',async()=>{
  const h=await harness(), events=await h.collect({sessionName:'AA-Pi',model:'tars/model/one',reasoningEffort:'high'});
  expect(events.filter(e=>e.type==='text').map(e=>e.delta).join('')).toBe('reply\u2028中文\u2029');
  expect(events.some(e=>e.type==='tool_use')).toBe(true);expect(events.some(e=>e.type==='tool_result')).toBe(true);
  expect(events.at(-1)).toMatchObject({type:'done',terminationReason:'normal'});
  expect(events.some(e=>e.type==='system'&&e.turnId)).toBe(true);
  expect((await h.requests()).filter(r=>r.type==='prompt')).toMatchObject([{message:'raw\u2028中文\u2029'}]);
  expect(JSON.stringify(events)).not.toContain('CREDENTIAL_SECRET');
});
it('resumes one exact session and exposes read-only history, rename and native clone',async()=>{
  const h=await harness(), events=await h.collect();const id=events.find(e=>e.type==='system')?.sessionId!;
  await h.collect({sessionId:id});expect(await h.provider.listSessions()).toHaveLength(1);
  await h.provider.rename(id,'AA-Pi');expect((await h.provider.listSessions())[0]?.name).toBe('AA-Pi');
  const reader=new PiNativeConversationReader(h.options), snapshot=await reader.read(id);
  expect(snapshot).toMatchObject({id,cwd:h.root,name:'AA-Pi',settings:{model:'tars/model/one',reasoningEffort:'high'}});
  expect(snapshot.turns).toHaveLength(2);expect(snapshot.turns.every(t=>t.bridge)).toBe(true);
  expect(snapshot.turns[1]?.state.terminal).toBe('done');
  expect(await readFile((await h.provider.historyPath(id))!,'utf8')).toContain('raw');
  const copy=await h.provider.fork(id);expect(copy.nativeId).not.toBe(id);expect(copy.cwd).toBe(h.root);
  expect(h.provider).toMatchObject({nativeArchive:true,archiveEffect:'delete'});
  vi.stubEnv('PATH',h.root); // Force native unlink fallback without touching the user's trash.
  await h.provider.archive(id);await h.provider.archive(id);
  expect((await h.provider.listSessions()).map(s=>s.nativeId)).toEqual([copy.nativeId]);
  await expect(reader.read(id)).rejects.toThrow('不存在');
  expect((await reader.read(copy.nativeId)).turns).toHaveLength(2);
});
it.each(['read-only','workspace'])('rejects %s permissions without launching an unrestricted process',async accessMode=>{
  const h=await harness(),events=await h.collect({accessMode});expect(events.at(-1)).toMatchObject({type:'error',submissionStatus:'rejected'});expect(await h.requests()).toEqual([]);
});
it('uses the native trash command for the exact session and refuses ambiguous or path-like identities',async()=>{
  const h=await harness(),events=await h.collect(),id=events.find(e=>e.type==='system')?.sessionId!;
  const path=await h.provider.historyPath(id),before=await readFile(path,'utf8');
  await writeFile(join(h.root,'trash'),`#!${process.execPath}\nconst fs=require('node:fs');fs.renameSync(process.argv[2],process.argv[2]+'.trashed');`,{mode:0o700});
  vi.stubEnv('PATH',h.root);
  const duplicate=join(h.root,'sessions','duplicate.jsonl');await writeFile(duplicate,before);
  await expect(h.provider.archive(id)).rejects.toThrow('重复会话 ID');
  expect(await readFile(path,'utf8')).toBe(before);await rm(duplicate);
  await expect(h.provider.archive('../models.json')).rejects.toThrow('ID');
  await h.provider.archive(id);
  expect(await readFile(path+'.trashed','utf8')).toBe(before);expect(await h.provider.listSessions()).toEqual([]);
  await expect(readFile(path)).rejects.toMatchObject({code:'ENOENT'});
});
it.each([{model:'missing/model'},{reasoningEffort:'ultra'}])('rejects unavailable native selections before prompt: %j',async extra=>{
  const h=await harness(),events=await h.collect(extra);
  expect(events.at(-1)).toMatchObject({type:'error',submissionStatus:'rejected'});
  expect((await h.requests()).some(r=>r.type==='prompt')).toBe(false);
});
it('does not retry an uncertain prompt after process loss and suppresses native diagnostics',async()=>{
  const h=await harness('disconnect'),events=await h.collect();expect(events.at(-1)).toMatchObject({type:'error',submissionStatus:'unknown'});
  expect((await h.requests()).filter(r=>r.type==='prompt')).toHaveLength(1);expect(JSON.stringify(events)).not.toContain('CREDENTIAL_SECRET');
});
it('rejects malformed protocol output without submitting input',async()=>{
  const h=await harness('malformed'),events=await h.collect();expect(events.at(-1)).toMatchObject({type:'error',submissionStatus:'rejected'});
});
it('reports an authoritative model error instead of a successful empty completion',async()=>{
  const h=await harness('model-error'),events=await h.collect();expect(events.at(-1)).toMatchObject({type:'error',terminationReason:'failed'});
  expect(JSON.stringify(events)).not.toContain('CREDENTIAL_SECRET');
});
it('stops only the owned RPC run with an abort request',async()=>{
  const h=await harness('wait'),run=h.adapter.run({runId:'stop',cwd:h.root,prompt:'wait',accessMode:'full'}),events:AgentEvent[]=[];
  for await(const event of run.events){events.push(event);if(event.type==='system'&&!event.turnId){await new Promise(r=>setTimeout(r,30));await run.stop();}}
  expect(events.at(-1)).toMatchObject({type:'done',terminationReason:'interrupted'});expect(await run.waitForExit(5000)).toBe(true);
  expect((await h.requests()).filter(r=>r.type==='abort')).toHaveLength(1);
});
it('projects only the active branch and rejects broken or cyclic history',()=>{
  const entries=[{id:'a',parentId:null},{id:'old',parentId:'a'},{id:'b',parentId:'a'}];
  expect(piActiveBranch(entries).map(e=>e.id)).toEqual(['a','b']);
  expect(()=>piActiveBranch([{id:'bad',parentId:'missing'}])).toThrow('缺少父记录');
  expect(()=>piActiveBranch([{id:'bad',parentId:'bad'}])).toThrow('无效');
});
it('refuses path-like session IDs and changed project directories',async()=>{
  const h=await harness();await expect(h.provider.historyPath('../auth')).rejects.toThrow('ID');
  const events=await h.collect();const id=events.find(e=>e.type==='system')?.sessionId!;
  const file=await h.provider.historyPath(id),content=await readFile(file,'utf8');await writeFile(file,content.replaceAll(h.root,'/another-project'));
  expect((await h.collect({sessionId:id})).at(-1)).toMatchObject({type:'error',submissionStatus:'rejected'});
});
it('converts Zcode API formats and preserves literal credentials without shell/env expansion',()=>{
  const config=piProvidersFromZcode({revision:'00000000-0000-4000-8000-000000000000',generatedAt:0,providers:[{providerId:'test',kind:'openai-compatible',apiFormat:'openai-chat-completions',source:'user',baseURL:'https://provider.invalid/v1',apiKey:{source:'inline',value:'!secret$KEY'},models:[{modelId:'model',supportsImages:true}]}] as any});
  expect(config.test).toMatchObject({api:'openai-completions',apiKey:'$!secret$$KEY',models:[{id:'model',input:['text','image']}]});
});

it('registers Pi through the real worker factory and common authenticated discovery, job and session APIs',async()=>{
  const h=await harness();
  const profile=createDefaultProfileConfig({agentKind:'pi',accounts:{app:{id:'app',secret:'fixture',tenant:'feishu'}},
    pi:{binaryPath:process.execPath,args:h.options.args,agentDir:h.root}});
  const built=await createWorkerProvider(join(h.root,'profile'),'pi',profile,{});
  const server=await startWorkerServer({...built,botAppId:'app'});
  try{
    const discovered=await discoverWorkers(join(h.root,'profile'),'app');expect(discovered).toHaveLength(1);
    const tool=workerTool(discovered[0]!);expect(tool).toMatchObject({id:'pi',label:'Pi',sourceId:h.root});
    const client=new WorkerClient(built.stateDir,h.root,'app','pi');
    const health=await client.health();expect(health.capabilities?.sessions).toMatchObject({list:true,history:true,rename:true,fork:true,archive:true,archiveEffect:'delete'});
    expect(health.capabilities?.sessionListAuthoritative).toBe(true);
    expect(tool.sessions?.archiveEffect).toBe('delete');
    expect((await client.models(h.root)).some(m=>m.value==='tars/model/one')).toBe(true);
    const job=await client.submit({requestKey:'pi-worker-message',options:{runId:'input',cwd:h.root,prompt:'worker question',initialSessionId:'pi-worker-native',accessMode:'full',model:'tars/model/one'}});
    await vi.waitFor(async()=>expect((await client.snapshot(job.id)).job.status).toBe('completed'),{timeout:5000});
    expect((await tool.listSessions()).map(s=>s.nativeId)).toContain('pi-worker-native');
    expect((await client.conversation('pi-worker-native')).turns[0]?.input).toBe('worker question');
    const exported=await tool.sessions!.historyPath('pi-worker-native');expect(exported).toBeTruthy();
    vi.stubEnv('PATH',h.root);
    await tool.sessions!.archive('pi-worker-native');await client.archiveSession('pi-worker-native');
    expect(await client.listSessions()).toEqual([]);
    await expect(readFile(exported!)).rejects.toMatchObject({code:'ENOENT'});
  }finally{await server.close();}
});

it('rejects deletion while the worker owns a running session, then deletes after that run stops',async()=>{
  const h=await harness('wait');
  const profile=createDefaultProfileConfig({agentKind:'pi',accounts:{app:{id:'app',secret:'fixture',tenant:'feishu'}},
    pi:{binaryPath:process.execPath,args:h.options.args,agentDir:h.root}});
  const built=await createWorkerProvider(join(h.root,'profile'),'pi',profile,{}),server=await startWorkerServer({...built,botAppId:'app'});
  const client=new WorkerClient(built.stateDir,h.root,'app','pi');
  try{
    const job=await client.submit({requestKey:'busy-pi-delete',options:{runId:'busy',cwd:h.root,prompt:'wait',initialSessionId:'busy-native',accessMode:'full'}});
    await vi.waitFor(async()=>expect((await client.snapshot(job.id)).job.status).toBe('running'));
    await expect(client.archiveSession('busy-native')).rejects.toMatchObject({status:429,code:'busy'});
    await client.stop(job.id);
    await vi.waitFor(async()=>expect((await client.snapshot(job.id)).job.status).toBe('interrupted'));
    vi.stubEnv('PATH',h.root);await client.archiveSession('busy-native');expect(await client.listSessions()).toEqual([]);
  }finally{await server.close();}
});
