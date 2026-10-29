import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { PiAdapter } from '../../../src/agent/pi/adapter';
import { PiNativeConversationReader } from '../../../src/agent/pi/conversation';
import { PiSessionProvider } from '../../../src/tools/pi-sessions';
import { importZcodeToPi } from '../../../src/agent/pi/import-zcode';
import type { AgentEvent } from '../../../src/agent/types';

// Opt in with an installed native CLI. Inference goes only to the loopback
// fixture, never to a configured account or a billable provider.
it.skipIf(!process.env.PI_NATIVE_BIN)('uses actual Pi RPC, model discovery, resume, JSONL history, native rename and clone with a loopback model', async () => {
  const root=await mkdtemp(join(tmpdir(),'pi-native-')),agentDir=join(root,'agent'),cwd=join(root,'project');
  const requests:any[]=[];
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200,{'Content-Type':'text/event-stream'});
    const base={id:'chatcmpl-fixture',object:'chat.completion.chunk',created:1,model:'test-model'};
    for(const chunk of [{choices:[{index:0,delta:{role:'assistant',content:'native reply 中文'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}}])res.write('data: '+JSON.stringify({...base,...chunk})+'\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const port=(server.address() as {port:number}).port;
  try {
    await mkdir(agentDir,{recursive:true});await mkdir(cwd);
    // Exercise the same explicit import used on the installation, with fake
    // credentials and a local endpoint. No secret enters test output.
    const zcode=join(root,'zcode.json');
    await writeFile(zcode,JSON.stringify({provider:{fixture:{kind:'openai-compatible',options:{baseURL:`http://127.0.0.1:${port}/v1`,apiKey:'fixture-only'},models:{'test-model':{name:'Test'}}}},model:'fixture/test-model'}),{mode:0o600});
    const imported=await importZcodeToPi({modelConfigPath:zcode},{agentDir});
    expect(imported.models).toBe(1);expect((await stat(imported.path)).mode&0o777).toBe(0o600);
    const beforeModels=await readFile(imported.path,'utf8'),beforeSettings=await readFile(join(agentDir,'settings.json'),'utf8');
    const options={binary:process.env.PI_NATIVE_BIN!,agentDir};
    const adapter=new PiAdapter(options),provider=new PiSessionProvider(options);
    expect(await adapter.isAvailable()).toBe(true);
    const models=await adapter.listModels({cwd});expect(models.some(m=>m.value==='fixture/test-model')).toBe(true);
    expect(await readFile(imported.path,'utf8')).toBe(beforeModels);expect(await readFile(join(agentDir,'settings.json'),'utf8')).toBe(beforeSettings);
    const run=async(extra={})=>{const execution=adapter.run({runId:'native',cwd,prompt:'first\u2028中文',accessMode:'full',model:'fixture/test-model',sessionName:'AA-Pi loopback',...extra});
      const events:AgentEvent[]=[];for await(const event of execution.events)events.push(event);expect(await execution.waitForExit(5000)).toBe(true);return events;};
    const events=await run();expect(events.at(-1)).toMatchObject({type:'done',terminationReason:'normal'});
    expect(events.filter(e=>e.type==='text').map(e=>e.delta).join('')).toBe('native reply 中文');
    const id=events.find(e=>e.type==='system')?.sessionId!;expect(id).toBeTruthy();
    expect((await provider.listSessions()).find(s=>s.nativeId===id)?.name).toBe('AA-Pi loopback');
    expect((await run({sessionId:id,prompt:'second'})).at(-1)).toMatchObject({type:'done',sessionId:id});
    const conversation=await new PiNativeConversationReader(options).read(id);expect(conversation.turns).toHaveLength(2);
    expect(conversation.turns.every(turn=>turn.state.terminal==='done')).toBe(true);
    await provider.rename(id,'AA-native-renamed');expect((await provider.listSessions()).find(s=>s.nativeId===id)?.name).toBe('AA-native-renamed');
    const copy=await provider.fork(id);expect(copy.nativeId).not.toBe(id);expect(copy.cwd).toBe(cwd);
    expect((await new PiNativeConversationReader(options).read(copy.nativeId)).turns).toHaveLength(2);
    expect(requests).toHaveLength(2);expect(requests.every(r=>r.model==='test-model')).toBe(true);
    const renamed=JSON.parse(await readFile(zcode,'utf8'));renamed.provider.fixture.name='gaoliu';await writeFile(zcode,JSON.stringify(renamed));
    expect((await importZcodeToPi({modelConfigPath:zcode},{agentDir})).migratedSessions).toBe(2);
    const refreshed=await adapter.listModels({cwd});
    expect(refreshed.map(m=>m.value)).toContain('gaoliu/test-model');expect(refreshed.map(m=>m.value)).not.toContain('fixture/test-model');
    expect((await run({sessionId:id,prompt:'after provider rename',model:'gaoliu/test-model'})).at(-1)).toMatchObject({type:'done',sessionId:id});
    const continued=await new PiNativeConversationReader(options).read(id);
    expect(continued.turns).toHaveLength(3);expect(continued.settings?.model).toBe('gaoliu/test-model');expect(requests).toHaveLength(3);
  } finally { server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await rm(root,{recursive:true,force:true}); }
},30_000);
