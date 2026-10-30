import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parsePiModel, piSettingsPath, readPiDefaults, writePiDefaults } from '../../../src/agent/pi/settings';

async function workspace() {
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-settings-'));
  return { agentDir, path: join(agentDir, 'settings.json') };
}

it('reads and writes the Pi default-model keys without disturbing other settings', async () => {
  const { agentDir, path } = await workspace();
  expect(piSettingsPath({ agentDir })).toBe(path);
  expect(await readPiDefaults({ agentDir })).toEqual({});
  await writeFile(path, JSON.stringify({ defaultProvider: 'gaoliu', defaultModel: 'deepseek-v4-flash', telemetry: true }, null, 2) + '\n');
  expect(await readPiDefaults({ agentDir })).toEqual({ value: 'gaoliu/deepseek-v4-flash' });
  expect(await writePiDefaults({ agentDir }, 'tars-point/deepseek-v4-flash')).toEqual({ value: 'tars-point/deepseek-v4-flash' });
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ defaultProvider: 'tars-point', defaultModel: 'deepseek-v4-flash', telemetry: true });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await readPiDefaults({ agentDir })).toEqual({ value: 'tars-point/deepseek-v4-flash' });
});

it('treats an incomplete pair as unset and rejects malformed values or settings files', async () => {
  const { agentDir, path } = await workspace();
  await writeFile(path, JSON.stringify({ defaultProvider: 'gaoliu' }));
  expect(await readPiDefaults({ agentDir })).toEqual({});
  for (const value of ['', 'gaoliu', '/model', 'provider/', 'a b/c', 'p/m\n', 'x'.repeat(600) + '/m']) expect(parsePiModel(value)).toBeUndefined();
  expect(parsePiModel('p/m/x')).toEqual({ provider: 'p', model: 'm/x' });
  await expect(writePiDefaults({ agentDir }, 'broken')).rejects.toThrow('默认模型格式无效');
  await writeFile(path, '{not json');
  await expect(readPiDefaults({ agentDir })).rejects.toThrow('不是有效 JSON');
  await writeFile(path, '[]');
  await expect(readPiDefaults({ agentDir })).rejects.toThrow('格式不兼容');
});
