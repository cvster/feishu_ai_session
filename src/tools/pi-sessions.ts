import { PiClient, type PiOptions } from '../agent/pi/client';
import { PiSessionFiles } from '../agent/pi/sessions';
import type { ToolSession, ToolSessionOperations } from './types';

export class PiSessionProvider implements ToolSessionOperations {
  readonly historyMode = 'file';
  readonly nativeArchive = false;
  private files: PiSessionFiles;
  constructor(private options: PiOptions) { this.files = new PiSessionFiles(options); }
  async listSessions(): Promise<ToolSession[]> {
    return (await this.files.list()).map(file => ({ nativeId: file.header.id, name: file.name, cwd: file.header.cwd,
      createdAtMs: file.createdAtMs, updatedAtMs: file.updatedAtMs, archived: false }));
  }
  async historyPath(id: string) { return (await this.files.find(id)).path; }
  private async withSession<T>(id: string, work: (client: PiClient, file: Awaited<ReturnType<PiSessionFiles['find']>>) => Promise<T>) {
    const file = await this.files.find(id), client = new PiClient(this.options, file.header.cwd, ['--session', file.path]);
    try {
      const state = await client.request('get_state');
      if (state?.sessionId !== id || state.sessionFile !== file.path || state.isStreaming) throw Error('Pi 会话身份或状态不匹配');
      return await work(client, file);
    } finally { await client.close(); }
  }
  async rename(id: string, name: string) {
    await this.withSession(id, async client => { await client.request('set_session_name', { name });
      if ((await client.request('get_state'))?.sessionName !== name) throw Error('Pi 会话名称回读不匹配'); });
  }
  async archive(_id: string): Promise<void> { throw Error('Pi 不提供原生归档；可通过桥接归档入口，原生历史保留'); }
  async fork(id: string) {
    return this.withSession(id, async (client, file) => {
      const result = await client.request('clone');
      if (result?.cancelled !== false) throw Error('Pi 取消了复制会话');
      const state = await client.request('get_state');
      if (!state?.sessionId || state.sessionId === id) throw Error('Pi 复制会话身份无效');
      const copy = await this.files.find(state.sessionId);
      if (copy.header.cwd !== file.header.cwd) throw Error('Pi 复制会话的工作目录不匹配');
      return { nativeId: state.sessionId, cwd: copy.header.cwd, name: state.sessionName || file.name || state.sessionId };
    });
  }
}
