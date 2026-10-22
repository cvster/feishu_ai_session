import { readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface KiloEditorServer { url: string; authorization: string; pid: number; client?: 'vscode' }

function contains(root: string, cwd: string): boolean {
  const path = relative(root, cwd);
  return !isAbsolute(path) && path !== '..' && !path.startsWith('../');
}
function database(env: NodeJS.ProcessEnv, dataHome?: string): string {
  const root = join(dataHome ?? env.XDG_DATA_HOME ?? join(env.HOME ?? homedir(), '.local/share'), 'kilo');
  return env.KILO_DB === ':memory:' ? ':memory:' : resolve(root, env.KILO_DB ?? 'kilo.db');
}

function extensionExecutable(path: string): boolean {
  for (const root of [join(homedir(), '.vscode/extensions'), join(homedir(), '.vscode-server/extensions'), join(homedir(), '.vscode-insiders/extensions')]) {
    const suffix = relative(root, path);
    if (/^kilocode\.kilo-code-\d[^/]*\/bin\/kilo$/.test(suffix)) return true;
  }
  return false;
}
async function readServer(server: KiloEditorServer, path: string): Promise<any> {
  return new Promise((accept, reject) => {
    const req = request(`${server.url}${path}`, { agent: false, headers: { Authorization: server.authorization } }, res => {
      const chunks: Buffer[] = []; let bytes = 0;
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) req.destroy(); else chunks.push(chunk); });
      res.on('error', () => reject(new Error('Kilo 界面后端不可用，未切换后端或提交消息。')));
      res.on('end', () => { try { if (res.statusCode === 200) { accept(JSON.parse(Buffer.concat(chunks).toString('utf8'))); return; } } catch {}
        reject(new Error(path === '/global/health' ? 'Kilo 界面后端健康检查失败，未切换后端或提交消息。' : 'Kilo 界面后端会话读取失败，未切换后端或提交消息。')); });
    });
    req.setTimeout(3000, () => req.destroy());
    req.once('error', () => reject(new Error('Kilo 界面后端连接失败，未切换后端或提交消息。')));
    req.end();
  });
}

/** Same-user local UI servers. Installed upgrades do not change an existing window's executable.
 */
export async function findKiloEditorServer(binary: string, cwd?: string, dataHome?: string,
  test: { procRoot?: string; uid?: number; platform?: string } = {}, sessionId?: string, _preferredClient?: string): Promise<KiloEditorServer | undefined> {
  if ((test.platform ?? process.platform) !== 'linux') return;
  const proc = test.procRoot ?? '/proc', uid = test.uid ?? process.getuid?.();
  if (uid === undefined) return;
  let executable: string, directory: string | undefined;
  try { executable = await realpath(binary); directory = cwd ? await realpath(cwd) : undefined; } catch { return; }
  const targetDb = database(process.env, dataHome);
  if (targetDb === ':memory:') return;
  const candidates: Array<KiloEditorServer & { root: string }> = [];
  let entries: string[]; try { entries = await readdir(proc); } catch { return; }
  for (const id of entries.filter(id => /^\d+$/.test(id))) {
    const root = join(proc, id);
    try {
      const path = (await readlink(join(root, 'exe'))).replace(/ \(deleted\)$/, '');
      const status = await readFile(join(root, 'status'), 'utf8');
      const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
      if (!ids || ids.slice(1).some(id => Number(id) !== uid)) continue;
      const env = Object.fromEntries((await readFile(join(root, 'environ'), 'utf8')).split('\0').filter(row => row.includes('='))
        .map(row => { const equals = row.indexOf('='); return [row.slice(0, equals), row.slice(equals + 1)]; }));
      if (!env.KILO_SERVER_PASSWORD || database(env) !== targetDb) continue;
      const parent = /^PPid:\s+(\d+)$/m.exec(status)?.[1];
      if (!parent || env.KILO_PARENT_PID !== parent) continue;
      const args = (await readFile(join(root, 'cmdline'), 'utf8')).split('\0');
      if (!args.includes('serve')) continue;
      let client: 'vscode';
      if (env.KILO_CLIENT === 'vscode' && (path === executable || extensionExecutable(path))) client = 'vscode';
      else continue;
      const workspace = await realpath(join(root, 'cwd'));
      if (client === 'vscode' && directory && !contains(workspace, directory)) continue;
      const sockets = new Set<string>();
      for (const fd of await readdir(join(root, 'fd'))) {
        try { const inode = /^socket:\[(\d+)\]$/.exec(await readlink(join(root, 'fd', fd)))?.[1]; if (inode) sockets.add(inode); } catch { /* fd closed */ }
      }
      const ports = new Set<number>();
      for (const file of ['tcp', 'tcp6']) {
        let table: string; try { table = await readFile(join(root, 'net', file), 'utf8'); } catch { continue; }
        for (const line of table.trim().split('\n').slice(1)) {
          const row = line.trim().split(/\s+/), [address, port] = (row[1] ?? '').split(':');
          if (row[3] === '0A' && sockets.has(row[9]!) && address === '0100007F' && port) ports.add(parseInt(port, 16));
        }
      }
      const authorization = `Basic ${Buffer.from(`${env.KILO_SERVER_USERNAME ?? 'kilo'}:${env.KILO_SERVER_PASSWORD}`).toString('base64')}`;
      for (const port of ports) candidates.push({ pid: Number(id), root: workspace, url: `http://127.0.0.1:${port}`, authorization, client });
    } catch { /* Exited, inaccessible, or not an eligible UI process. */ }
  }
  if (!candidates.length) return;
  if (sessionId) {
    if (!/^ses[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('Kilo 会话 ID 无效');
    const info = await readServer(candidates[0]!, `/session/${sessionId}`);
    if (info?.id !== sessionId || typeof info.directory !== 'string') throw new Error('Kilo 会话来源无法确认，未提交消息。');
    if (info.metadata?.['kilo-desktop']) throw new Error('不再支持 Kilo App 会话，请使用 VS Code 插件会话。');
    const nativeDirectory = await realpath(info.directory);
    if (directory && directory !== nativeDirectory) throw new Error('Kilo 会话工作目录不匹配，未提交消息。');
    directory = nativeDirectory;
  }
  let selected = directory ? candidates.filter(c => contains(c.root, directory!)) : candidates;
  if (selected.length) {
    const longest = Math.max(...selected.map(c => c.root.length));
    selected = selected.filter(c => c.root.length === longest);
  }
  if (!selected.length) return;
  if (selected.length !== 1) throw new Error('同一项目有多个 Kilo 编辑器后端，无法确定实时同步目标；请关闭重复窗口后重试。');
  const server = selected[0]!;
  if ((await readServer(server, '/global/health'))?.healthy !== true) throw new Error('Kilo 界面后端健康检查失败，未切换后端或提交消息。');
  return { url: server.url, authorization: server.authorization, pid: server.pid, client: 'vscode' };
}
