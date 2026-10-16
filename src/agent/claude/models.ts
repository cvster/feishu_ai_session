import { CLAUDE_MODEL_QUERY_ARGS } from './occupation';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { spawnProcess, mergeProcessEnv } from '../../platform/spawn';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import type { ModelOption } from '../models';

/** SDK initialize only: no user message, generation, session persistence, or tool permission approval. */
export async function listClaudeModels(binary: string, cwd?: string, larkChannel?: LarkChannelEnvContext): Promise<ModelOption[]> {
  const child = spawnProcess(binary, [...CLAUDE_MODEL_QUERY_ARGS], {
    cwd, env: mergeProcessEnv(process.env, buildLarkChannelEnv(larkChannel)), stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr!.on('data', () => {});
  const lines = createInterface({ input: child.stdout! });
  const requestId = randomUUID();
  let timer: ReturnType<typeof setTimeout>;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const exited = new Promise<void>(resolve => { child.once('error', () => resolve()); child.once('close', () => resolve()); });
  try {
    return await new Promise<ModelOption[]>((resolve, reject) => {
      const fail = () => reject(new Error('Claude 原生模型列表读取失败'));
      timer = setTimeout(fail, 10_000);
      child.once('error', fail); child.once('close', fail); child.stdin!.on('error', fail);
      lines.on('error', fail);
      lines.on('line', line => {
        if (line.length > 4 * 1024 * 1024) { fail(); return; }
        let value; try { value = JSON.parse(line); } catch { fail(); return; }
        if (value.type !== 'control_response' || value.response?.request_id !== requestId) return;
        const response = value.response;
        if (response.subtype !== 'success' || !Array.isArray(response.response?.models)) { fail(); return; }
        resolve(response.response.models.map((model: any) => ({ value: model.value, label: model.displayName ?? model.value })));
      });
      child.stdin!.write(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } }) + '\n');
    });
  } finally {
    clearTimeout(timer!); lines.close(); child.stdin?.end(); child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); killTimer.unref();
    await exited; clearTimeout(killTimer);
  }
}
