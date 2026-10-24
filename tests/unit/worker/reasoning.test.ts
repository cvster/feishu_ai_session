import { expect, it, vi } from 'vitest';
import { mapReasoningEffort, readReasoningSelection, resolveRunReasoning } from '../../../src/worker/reasoning';
import type { AgentAdapter } from '../../../src/agent/types';
import type { WorkerSessionService } from '../../../src/worker/protocol';
const model = (levels: string[]) => ({ value: 'p/model', label: 'Native', isDefault: true,
  reasoningEfforts: levels.map(value => ({ value, label: value })) });
const agent = (levels: string[]) => ({ id: 'opaque', listModels: vi.fn(async () => [model(levels)]) }) as unknown as AgentAdapter;
const sessions = (effort: string, currentModel='p/model') => ({ conversation: vi.fn(async () => ({ id: 'session', cwd: '/project', archived: false,
  settings: { model: currentModel, reasoningEffort: effort }, turns: [] })) }) as unknown as WorkerSessionService;
it('maps only to advertised positive native levels, preferring lower levels on a tie', () => {
  expect(mapReasoningEffort('ultra', model(['low','medium','high','xhigh','max']))).toBe('max');
  expect(mapReasoningEffort('medium', model(['off','low','high','max']))).toBe('low');
  expect(mapReasoningEffort('low', model(['off','high','max']))).toBe('high');
  expect(mapReasoningEffort('low', model(['minimal','high']))).toBe('minimal');
  expect(mapReasoningEffort('high', model(['instant','thinking']))).toBe('thinking');
  expect(mapReasoningEffort('ultra', model(['off','none','future-mode']))).toBeUndefined();
  expect(mapReasoningEffort('ultra')).toBeUndefined();
});
it('reads existing current settings instead of catalog suggestions and defaults new sessions to high', async () => {
  const a=agent(['low','high','max']);
  expect(await readReasoningSelection(a,sessions('max'),'session','/project')).toMatchObject({effort:'max',nativeEffort:'max',source:'native'});
  expect(await resolveRunReasoning(a,sessions('max'),{runId:'r',prompt:'p',cwd:'/project'})).toMatchObject({requested:'high',nativeEffort:'high'});
  expect(await resolveRunReasoning(a,sessions('max'),{runId:'r',prompt:'p',cwd:'/project',sessionId:'session'})).toMatchObject({requested:'max',nativeEffort:'max'});
});
it('uses the explicitly selected model and preserves native settings without mutating the request', async () => {
  const a=agent(['low','max']);
  a.listModels=vi.fn(async () => [model(['low','max']),{...model(['high']),value:'p/other'}]);
  const input={runId:'r',prompt:'p',cwd:'/project',sessionId:'session',model:'p/other',reasoningEffort:'ultra'};
  expect(await resolveRunReasoning(a,sessions('low'),input)).toMatchObject({requested:'ultra',nativeEffort:'high',model:'p/other'});
  expect(input.reasoningEffort).toBe('ultra');
  await expect(resolveRunReasoning(a,undefined,{...input,model:'deleted'})).rejects.toThrow('已移除');
});
it('does not fabricate a current level or treat a suggested default as confirmed session state', async () => {
  const a=agent([]); a.listModels=vi.fn(async () => [{...model([]),defaultReasoningEffort:'low'}]);
  expect(await readReasoningSelection(a,sessions('default'),'session','/project')).toMatchObject({effort:'high',source:'initial',notice:expect.any(String)});
  expect(await resolveRunReasoning(a,sessions('default'),{runId:'r',prompt:'p',cwd:'/project',sessionId:'session',reasoningEffort:'ultra'})).toMatchObject({requested:'ultra',nativeEffort:undefined});
});
it('falls back visibly on read failure without exposing provider diagnostics', async () => {
  const s=sessions('low'); vi.mocked(s.conversation!).mockRejectedValueOnce(Error('PRIVATE_KEY'));
  const result=await readReasoningSelection(agent(['high']),s,'session','/project');
  expect(result).toMatchObject({effort:'high',source:'initial',notice:expect.any(String)});
  expect(JSON.stringify(result)).not.toContain('PRIVATE_KEY');
});
