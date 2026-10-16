import { afterEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadZcodeRuntimeModel } from '../../../src/agent/zcode/model-config';
import { capabilityForTool } from '../../../src/agent/capability';
import { nativeSessionFields, toolDefinition } from '../../../src/tools/definitions';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('projects the selected local model without placing account secrets in model identity', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'zcode-model-')); roots.push(dataDir);
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({ model: { main: 'local/model-a' }, provider: {
    local: { kind: 'openai', name: 'test', options: { baseURL: 'https://example.invalid/v1', apiKey: 'test-only-secret' },
      models: { 'model-a': { limit: { context: 10000, output: 1000 } }, 'model-b': {} } },
  } }));
  const runtime = await loadZcodeRuntimeModel({ dataDir });
  expect(runtime?.model).toEqual({ providerId: 'local', modelId: 'model-a' });
  expect(runtime?.provider.apiKey).toEqual({ source: 'inline', value: 'test-only-secret' });
  expect(runtime?.provider.models).toHaveLength(1);
  expect((await loadZcodeRuntimeModel({ dataDir }, 'local/model-b'))?.model.modelId).toBe('model-b');
  await expect(loadZcodeRuntimeModel({ dataDir }, 'foreign/model-a')).rejects.toThrow('选定模型');
  await writeFile(join(dataDir, 'config.json'), 'invalid-secret-data');
  await expect(loadZcodeRuntimeModel({ dataDir })).rejects.toThrow('ZCode CLI 模型配置无法读取');
});
it('keeps opaque native IDs and rejects unknown providers instead of falling back', () => {
  expect(nativeSessionFields('zcode', 'sess_opaque')).toEqual({ sessionId: 'sess_opaque' });
  expect(capabilityForTool('zcode')).toMatchObject({ agentId: 'zcode', sessionKind: 'zcode-session' });
  expect(() => toolDefinition('unknown' as never)).toThrow('未注册');
});
