import { expect, it, vi } from 'vitest';
import { fixture } from '../../helpers/worker-fixture';
import type { WorkerSessionService } from '../../../src/worker/protocol';
import { renderRunStatus } from '../../../src/card/run-status-render';
import { initialState, reduce } from '../../../src/card/run-state';

it.each([
  ['codex', ['low','medium','high','xhigh','max','ultra'], 'ultra'],
  ['claude', ['low','medium','high','xhigh','max'], 'max'],
  ['zcode', [], undefined],
  ['kilo', ['low','medium','high'], 'high'],
  ['dsh', ['off','high','max'], 'max'],
] as const)('maps unified effort inside the %s worker and journals the original selection exactly once', async (tool,levels,actual) => {
  const h=await fixture(tool);
  Object.assign(h.raw,{listModels:async()=>[{value:'p/model',label:'Native',isDefault:true,reasoningEfforts:levels.map(value=>({value,label:value}))}]});
  const input={requestKey:'mapped',options:{...h.options,reasoningEffort:'ultra'}};
  const job=await h.client.submit(input);
  await vi.waitFor(()=>expect(h.calls).toHaveLength(1));
  expect(h.calls[0]?.reasoningEffort).toBe(actual);
  expect((await h.client.snapshot(job.id)).job.options.reasoningEffort).toBe('ultra');
  expect((await h.client.submit(input)).id).toBe(job.id); expect(h.calls).toHaveLength(1);
  h.finish(); await vi.waitFor(async()=>expect((await h.client.snapshot(job.id)).job.status).toBe('completed'));
  const snapshot=await h.client.snapshot(job.id);
  const state=snapshot.events.reduce((s,r)=>reduce(s,r.event),initialState);
  expect(state.execution).toMatchObject({requestedReasoningEffort:'ultra',reasoningEffort:actual??'unavailable'});
  expect(renderRunStatus(state)).toContain(actual===undefined?'工具未提供可调档位':actual==='ultra'?'ultra':`ultra → ${actual}`);
});
it('initializes an existing session from its native setting and a new session at high without changing native settings during a read', async()=>{
  const conversation=vi.fn(async()=>({id:'native',cwd:'/unused',archived:false,settings:{model:'p/model',reasoningEffort:'medium'},turns:[]}));
  const h=await fixture('kilo',{conversation} as unknown as WorkerSessionService);
  conversation.mockImplementation(async()=>({id:'native',cwd:h.dir,archived:false,settings:{model:'p/model',reasoningEffort:'medium'},turns:[]}));
  Object.assign(h.raw,{listModels:async()=>[{value:'p/model',label:'Native',isDefault:true,reasoningEfforts:['low','medium','high'].map(value=>({value,label:value}))}]});
  expect(await h.client.readReasoning('native',h.dir)).toMatchObject({effort:'medium',nativeEffort:'medium',source:'native'});
  expect(h.calls).toHaveLength(0);
  const old=await h.client.submit({requestKey:'old',options:{...h.options,sessionId:'native'}});
  await vi.waitFor(()=>expect(h.calls).toHaveLength(1)); expect(h.calls[0]?.reasoningEffort).toBe('medium');
  h.finish(); await vi.waitFor(async()=>expect((await h.client.snapshot(old.id)).job.status).toBe('completed'));
  const fresh=await h.client.submit({requestKey:'new',options:{...h.options,delivery:undefined,initialSessionId:'fresh'}});
  await vi.waitFor(async()=>expect((await h.client.snapshot(fresh.id)).job.status).toBe('completed'));
  expect(h.calls[1]?.reasoningEffort).toBe('high');
});
