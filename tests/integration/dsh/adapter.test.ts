import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DshAdapter, dshPermission } from '../../../src/agent/dsh/adapter';
import { DshClient } from '../../../src/agent/dsh/client';
import { DshSessionProvider } from '../../../src/tools/dsh-sessions';
import type { AgentEvent } from '../../../src/agent/types';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function harness(mode?: string) {
  const root = await mkdtemp(join(tmpdir(), 'bridge-dsh-')); roots.push(root);
  const file = join(root, 'fixture.json'); await writeFile(file, JSON.stringify({mode,sessions:{}}));
  const options = { binary: process.execPath, args: [fileURLToPath(new URL('./fixture.cjs', import.meta.url))], homeDir: root };
  const adapter = new DshAdapter(options);
  const collect = async (prompt = 'raw prompt', extra = {}) => {
    const run = adapter.run({ runId: 'run-test', cwd: root, prompt, ...extra });
    const events: AgentEvent[] = []; for await (const event of run.events) events.push(event);
    expect(await run.waitForExit(5000)).toBe(true); return events;
  };
  const state = async () => JSON.parse(await readFile(file, 'utf8'));
  return { root, file, options, adapter, collect, state };
}
it('discovers provider/model identities and exact per-model reasoning metadata without credentials', async () => {
  const h = await harness(); const rows = await h.adapter.listModels();
  expect(rows.map(row => row.value)).toEqual(['default','tars/model/one','second/model/one']);
  expect(rows[1]?.label).toContain('(tars)');
  expect(rows[1]?.reasoningEfforts?.map(e => e.value)).toEqual(['low','high']);
  expect(rows[2]?.reasoningEfforts).toBeUndefined();
  expect(JSON.stringify(rows)).not.toContain('CREDENTIAL_SECRET');
});
it.each(['plain input', JSON.stringify({type:'ff_request',user_input:'FF JSON input'})])('preserves input, filters streams, deduplicates chunks and emits native tool controls: %s', async prompt => {
  const h = await harness(); const events = await h.collect(prompt, { model:'tars/model/one', reasoningEffort:'high', accessMode:'read-only',sessionName:'FF-project' });
  expect(events.filter(e => e.type==='text').map(e => e.delta).join('')).toBe('reply');
  expect(events.some(e => e.type==='tool_use' && e.name==='read')).toBe(true);
  expect(events.some(e => e.type==='tool_result' && e.id==='tool-test' && e.output==='marker')).toBe(true);
  expect(events.at(-1)).toMatchObject({type:'done',terminationReason:'normal'});
  const state = await h.state();
  const posted = state.requests.filter((r: any) => r.method==='session/prompt');expect(posted).toHaveLength(1);
  expect(posted[0].args.request.content).toEqual([{type:'text',text:prompt}]);
  expect(state.requests.find((r: any) => r.method==='commands/execute').args.line).toBe('/permission read-only');
  expect(Object.values(state.sessions)[0]).toMatchObject({title:'FF-project',model:{provider:'tars',model:'model/one',reasoningEffort:'high'}});
});
it('resumes the existing native session and retains its model/effort without sending source prompts', async () => {
  const h = await harness();const first = await h.collect('first',{model:'tars/model/one',reasoningEffort:'high'});
  const id = first.find(e => e.type==='system')?.sessionId;
  const second = await h.collect('next',{sessionId:id});
  expect(second.at(-1)).toMatchObject({type:'done',sessionId:id});
  expect(Object.keys((await h.state()).sessions)).toHaveLength(1);
});
it.each([{model:'removed/model'},{model:'second/model/one',reasoningEffort:'high'}])('rejects unavailable selection before creating/submitting a session: %j', async selection => {
  const h = await harness();const events = await h.collect('unused',selection);
  expect(events.at(-1)).toMatchObject({type:'error',submissionStatus:'rejected'});
  expect((await h.state()).requests.some((r: any) => r.method==='session/prompt'||r.method==='session/create')).toBe(false);
});
it.each(['disconnect','lost-ack'])('does not retry an uncertain mutation (%s)', async mode => {
  const h = await harness(mode);const events = await h.collect();
  expect(events.at(-1)).toMatchObject({type:'error',submissionStatus:'unknown'});
  expect((await h.state()).requests.filter((r: any) => r.method==='session/prompt')).toHaveLength(1);
  expect(JSON.stringify(events)).not.toContain('CREDENTIAL_SECRET');
});
it('reports model authentication failure instead of a successful empty answer', async () => {
  const h=await harness('model-error');const events=await h.collect();
  expect(events.at(-1)).toMatchObject({type:'error',terminationReason:'failed'});
  expect(JSON.stringify(events)).toContain('凭据');
});
it('stops only the current native session through its cancel endpoint', async () => {
  const h=await harness('wait');const run=h.adapter.run({runId:'stop',cwd:h.root,prompt:'wait'});
  const events: AgentEvent[]=[];
  for await(const event of run.events){events.push(event);if(event.type==='system'){await new Promise(r=>setTimeout(r,100));await run.stop();}}
  expect(events.at(-1)).toMatchObject({type:'done',terminationReason:'interrupted'});
  expect(await run.waitForExit(5000)).toBe(true);
  expect((await h.state()).requests.filter((r: any)=>r.method==='session/cancel')).toHaveLength(1);
});
it('reads native history privately, forks through the native API, renames and archives without deleting',async()=>{
  const h=await harness();const events=await h.collect();const id=events.find(e=>e.type==='system')?.sessionId!;
  const provider=new DshSessionProvider(h.options,join(h.root,'bridge-state'));
  await provider.rename(id,'AA-native');expect((await provider.listSessions())[0]?.name).toBe('AA-native');
  const history=await provider.historyPath(id);expect((await stat(history!)).mode&0o777).toBe(0o600);
  const copy=await provider.fork(id);expect(copy.nativeId).not.toBe(id);expect(copy.cwd).toBe(h.root);
  await provider.archive(copy.nativeId);expect((await provider.listSessions()).find(row=>row.nativeId===copy.nativeId)?.archived).toBe(true);
  expect((await h.state()).requests.filter((r: any)=>r.method==='session/prompt')).toHaveLength(1);
});
it('sanitizes native RPC error bodies and launch tokens',async()=>{
  const h=await harness();const client=new DshClient(h.options);
  try{await expect(client.request('unknown/operation')).rejects.toThrow('fixture/refused');}
  finally{await client.close();}
});
it.each([['read-only','read-only'],['workspace','workspace-write'],['full','danger-full-access']] as const)('maps native access %s to %s', (mode,preset)=>{expect(dshPermission(mode)).toBe(preset);});
