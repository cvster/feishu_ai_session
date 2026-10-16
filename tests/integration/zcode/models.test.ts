import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listZcodeModels, listZcodeModelCapabilities, loadZcodeRuntimeModel } from '../../../src/agent/zcode/model-config';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('refreshes native desktop providers and models, keeps same-named models distinct, and never exposes keys', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'native-zcode-models-')); roots.push(dataDir);
  const modelConfigPath = join(dataDir, 'provider_config.json');
  const provider = (id: string, ids = ['same-model']) => ({ providerId: id, providerName: `Vendor ${id}`, config: {
    access: { type: 'api-key', apiKey: `test-secret-${id}` }, api: { type: 'openai-chat-completions', baseUrl: 'https://example.invalid/v1' },
    personalModelIds: ids, modelOrder: ['removed-from-declarations', ...ids],
  } });
  const config = { providerOrder: ['b', 'a'], providerConfigRules: { providerRules: [provider('a'), provider('b')] },
    modelConfigRules: { providerModelRules: [] as any[], manualProviderModelRules: [] } };
  const save = () => writeFile(modelConfigPath, JSON.stringify({ schemaVersion: 1, config }));
  await save();
  const options = { dataDir, modelConfigPath };
  const models = await listZcodeModels(options);
  expect(models.map(model => model.value)).toEqual(['b/same-model', 'a/same-model']);
  expect(models[0]?.label).toContain('Vendor b'); expect(JSON.stringify(models)).not.toContain('test-secret');
  expect((await loadZcodeRuntimeModel(options)).model).toEqual({ providerId: 'b', modelId: 'same-model' });
  const selected = await loadZcodeRuntimeModel(options, 'a/same-model');
  expect(selected.provider.apiKey?.value).toBe('test-secret-a'); expect(selected.provider.apiFormat).toBe('openai-chat-completions');
  config.providerConfigRules.providerRules = [provider('a', ['brand-new'])]; await save();
  expect((await listZcodeModels(options)).map(model => model.value)).toEqual(['a/brand-new']);
  await expect(loadZcodeRuntimeModel(options, 'b/same-model')).rejects.toThrow('已移除');
  await expect(loadZcodeRuntimeModel(options, 'a/same-model')).rejects.toThrow('已移除');
  config.modelConfigRules.providerModelRules.push({ providerId: 'a', modelId: 'brand-new', config: { enabled: false } }); await save();
  expect(await listZcodeModels(options)).toEqual([]);
  await expect(loadZcodeRuntimeModel(options)).rejects.toThrow('不可用');
});
it('keeps an explicitly selected legacy default and fails instead of returning a stale catalog after a bad edit', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cli-zcode-models-')); roots.push(dataDir);
  const path = join(dataDir, 'config.json');
  await writeFile(path, JSON.stringify({ model: 'p/two', provider: { p: { kind: 'openai', models: { one: {}, two: {} } } } }));
  expect((await loadZcodeRuntimeModel({ dataDir })).model.modelId).toBe('two');
  await writeFile(path, JSON.stringify({ model: 'p/deleted', provider: { p: { kind: 'openai', models: { one: {} } } } }));
  await expect(loadZcodeRuntimeModel({ dataDir })).rejects.toThrow('已移除');
  await writeFile(path, '{broken');
  await expect(listZcodeModels({ dataDir })).rejects.toThrow('无法读取');
});

it('discovers native levels in an isolated metadata process and excludes credentials and inference requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zcode-capabilities-')); roots.push(root);
  const path = join(root, 'config.json'), cli = join(root, 'cli.cjs'), calls = join(root, 'calls.jsonl');
  const config = { model: 'p/two', provider: { p: { kind: 'openai', options: { apiKey: 'private-key', headers: { authorization: 'private-header' } }, models: { one: {}, two: {} } } } };
  await writeFile(path, JSON.stringify(config));
  await writeFile(cli, `
    const fs=require('node:fs');require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      fs.appendFileSync(${JSON.stringify(calls)},line+'\\n');const q=JSON.parse(line);
      const models=q.params.registry.providers.flatMap(provider=>provider.models.map(model=>({ref:{providerId:provider.providerId,modelId:model.modelId},reasoning:model.modelId==='two'?{enabled:true,levels:[{value:'future',label:'Future'}],defaultLevel:'future'}:{enabled:false,levels:[]}})));
      process.stdout.write(JSON.stringify({id:q.id,result:{workspaceState:{settings:{model:{available:models}}}}})+'\\n');
    });`);
  const choices = await listZcodeModelCapabilities({ binary: process.execPath, args: [cli, '--settings', path], dataDir: root });
  expect(choices[0]?.reasoningEfforts).toBeUndefined();
  expect(choices[1]).toMatchObject({ value: 'p/two', isDefault: true, defaultReasoningEffort: 'future', reasoningEfforts: [{ value: 'future', label: 'Future' }] });
  const requests = await readFile(calls, 'utf8');
  expect(requests).not.toContain('private-key'); expect(requests).not.toContain('private-header');
  expect(requests).not.toContain('session/create'); expect(requests).not.toContain('session/send');
  expect(requests).toContain('workspace/updateProviderRegistry');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(config);
});
