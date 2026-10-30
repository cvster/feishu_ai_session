import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../platform/atomic-write';
import { piStorageDir, type PiOptions } from './client';

/** Pi reads these two keys at startup, so they are the only default-model switch. */
export const PI_DEFAULT_KEYS = ['defaultProvider', 'defaultModel'] as const;
const MAX_LENGTH = 512;

export function piSettingsPath(options: PiOptions = {}) {
  return join(piStorageDir(options), 'settings.json');
}

export interface PiModelValue { provider: string; model: string }

/** Values travel as `provider/model` because both halves are required together. */
export function parsePiModel(value: string | undefined): PiModelValue | undefined {
  if (typeof value !== 'string' || !value || value.length > MAX_LENGTH || /\s/.test(value) || /[\x00-\x1f\x7f]/.test(value)) return undefined;
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return undefined;
  const provider = value.slice(0, slash), model = value.slice(slash + 1);
  if (!provider || !model) return undefined;
  return { provider, model };
}

function settingsObject(raw: unknown) {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Pi 设置文件格式不兼容，请在 Pi 中检查 settings.json');
  return raw as Record<string, unknown>;
}

async function readSettingsJson(options: PiOptions) {
  let text: string;
  try { text = await readFile(piSettingsPath(options), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw Error('Pi 设置文件不是有效 JSON，请在 Pi 中检查 settings.json'); }
  return settingsObject(raw);
}

/** A half-written pair is reported as "no default": Pi would ignore it anyway. */
export async function readPiDefaults(options: PiOptions = {}): Promise<{ value?: string }> {
  const raw = await readSettingsJson(options);
  const provider = typeof raw.defaultProvider === 'string' ? raw.defaultProvider : '';
  const model = typeof raw.defaultModel === 'string' ? raw.defaultModel : '';
  const value = provider && model ? `${provider}/${model}` : '';
  return parsePiModel(value) ? { value } : {};
}

export async function writePiDefaults(options: PiOptions, value: string): Promise<{ value: string }> {
  const parsed = parsePiModel(value);
  if (!parsed) throw Error('默认模型格式无效');
  const raw = await readSettingsJson(options);
  // Unknown keys belong to the user and stay untouched.
  await writeFileAtomic(piSettingsPath(options), JSON.stringify({ ...raw, defaultProvider: parsed.provider, defaultModel: parsed.model }, null, 2) + '\n', { mode: 0o600 });
  return { value };
}
