import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as lockfile from 'proper-lockfile';
import { WorkerClient } from '../../src/worker/client';
import type { DiscoveredWorker } from '../../src/worker/discovery';
import { ToolBindingStore, isPersonalWorkgroup } from '../../src/tools/bindings';
import { writeFileAtomic } from '../../src/platform/atomic-write';
import { liveNativeDriver } from './live-native-driver';

export const AUTOTEST_TITLE = 'AA-飞书桥接-autotest';
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function eventually<T>(label: string, read: () => Promise<T | undefined>, timeout = 90_000): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    // Read errors are failures too. Never turn a 401/404 into a timeout or a pass.
    const value = await read(); if (value !== undefined) return value;
    await delay(2_000);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

/** Explicit owner identity; the agents' isolated bot CLI is never used here. */
export async function ownerCli(appId: string, args: string[], data?: unknown): Promise<any> {
  const env: NodeJS.ProcessEnv = { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' };
  for (const key of ['LARK_CHANNEL', 'LARK_CHANNEL_PROFILE', 'LARK_CHANNEL_HOME', 'LARK_CHANNEL_CONFIG', 'LARKSUITE_CLI_CONFIG_DIR']) delete env[key];
  if (process.env.LARK_CHANNEL_OWNER_CLI_CONFIG_DIR) env.LARKSUITE_CLI_CONFIG_DIR = process.env.LARK_CHANNEL_OWNER_CLI_CONFIG_DIR;
  return new Promise((resolve, reject) => {
    const child = spawn('lark-cli', ['--profile', appId, ...args, '--as', 'user', '--format', 'json'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Owner CLI timed out')); }, 30_000);
    child.stdout.on('data', value => { out += value; if (out.length > 4 * 1024 * 1024) child.kill('SIGTERM'); });
    child.stderr.on('data', value => { if (err.length < 64 * 1024) err += value; });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Owner CLI unavailable')); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(code === 0 ? out : err);
        if (code !== 0 || result.ok !== true || result.identity !== 'user')
          throw new Error(`Owner CLI failed: ${result.error?.subtype ?? code}`);
        resolve(result.data);
      } catch (error) { reject(error instanceof SyntaxError ? new Error(`Owner CLI invalid response (exit ${code})`) : error); }
    });
    child.stdin.end(data === undefined ? undefined : JSON.stringify(data));
  });
}

interface SavedSession { nativeId: string; sourceId: string; cwd: string; chatId?: string; name?: string }
export async function lockLiveSuite(profileDir: string) {
  const dir = join(profileDir, 'autotest'); await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'suite.lock'); await writeFile(path, '', { flag: 'a', mode: 0o600 });
  return lockfile.lock(path, { realpath: false, stale: 30_000, update: 5_000 });
}

export async function runLiveWorkerScenario(worker: DiscoveredWorker, profileDir: string, workspace: string) {
  const { health, directory } = worker, toolId = health.toolId;
  const client = new WorkerClient(directory, health.sourceId, health.botAppId, toolId, health.manifest);
  const report: { toolId: string; sourceId: string; startedAt: string; stages: string[]; nativeId?: string;
    chatId?: string; passed?: boolean; error?: string; restored?: boolean; failures: string[] } = {
    toolId, sourceId: health.sourceId, startedAt: new Date().toISOString(), stages: [], failures: [],
  };
  const stage = (name: string) => { report.stages.push(name); console.log(`[live:${toolId}] ${name}`); };
  const attempt = async (name: string, operation: () => Promise<void>) => {
    try { await operation(); }
    catch (error) {
      report.failures.push(`${name}: ${error instanceof Error ? error.message : 'failed'}`);
      stage(`${name} failed; continuing independent checks`);
    }
  };
  const reportDir = join(profileDir, 'autotest', 'reports'); await mkdir(reportDir, { recursive: true, mode: 0o700 });
  const reportPath = join(reportDir, `${Date.now()}-${toolId}.json`);
  const persistReport = () => writeFileAtomic(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  const savedPath = join(profileDir, 'autotest', 'sessions.json');
  let saved: Record<string, SavedSession> = {};
  try { saved = JSON.parse(await readFile(savedPath, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const key = JSON.stringify([toolId, health.sourceId]);
  let driver: ReturnType<typeof liveNativeDriver> | undefined, baseline: string | undefined, chatId: string | undefined;
  const saveSession = () => writeFileAtomic(savedPath, JSON.stringify(saved, null, 2), { mode: 0o600 });
  const nativeName = async (id: string) => (await client.listSessions()).find(row => row.nativeId === id)?.name;
  const chatName = async () => (await ownerCli(health.botAppId, ['im', 'chats', 'get', '--chat-id', chatId!])).name as string;
  try {
    if (!health.capabilities?.conversation || !health.capabilities.nativeSessionNames || !health.capabilities.sessions.rename)
      throw new Error(`${toolId} does not advertise bidirectional messages and native names`);
    const options = JSON.parse(await readFile(join(directory, 'config.json'), 'utf8')).options;
    const rows = await client.listSessions();
    const recorded = saved[key];
    const existing = recorded ? rows.find(row => row.nativeId === recorded.nativeId)
      : rows.filter(row => row.name?.startsWith(AUTOTEST_TITLE));
    if (Array.isArray(existing) && existing.length > 1) throw new Error('Multiple autotest sessions found; refusing to choose or create');
    const row = Array.isArray(existing) ? existing[0] : existing;
    if (row?.archived) throw new Error('Autotest session is archived; refusing to create another');
    const cwd = row?.cwd ?? recorded?.cwd ?? workspace;
    if (resolve(cwd) !== resolve(workspace)) throw new Error('Existing autotest session belongs to a different project; refusing to create a duplicate');
    driver = liveNativeDriver(toolId, options, health.sourceId, directory, cwd);
    if (row || recorded) await driver.validate(row?.nativeId ?? recorded!.nativeId);
    const id = row?.nativeId ?? recorded?.nativeId ?? await driver.create(AUTOTEST_TITLE, async nativeId => {
      report.nativeId = nativeId;
      saved[key] = { nativeId, sourceId: health.sourceId, cwd }; await saveSession();
    });
    if (typeof id !== 'string' || !id) throw new Error('Native creation returned no session ID');
    report.nativeId = id;
    saved[key] = { ...recorded, nativeId: id, sourceId: health.sourceId, cwd }; await saveSession();
    stage(row || recorded ? 'reused native session' : 'created native session');
    // Codex does not list an idle thread until its first native input exists.
    // Reuse the recorded ID after an incomplete run rather than duplicating it.
    if (!(await client.listSessions()).some(s => s.nativeId === id)) {
      await driver.send(id, '初始化飞书桥接自动测试会话。不要调用工具，不要读写文件，只回复 AUTOTEST_READY。');
      stage('initialized native history');
    }
    const discovered = await eventually('worker discovers native session', async () => (await client.listSessions()).find(s => s.nativeId === id));
    await eventually('initial native history is idle', async () => {
      const last = (await client.conversation(id)).turns.at(-1);
      // Setup only needs materialized, settled history. Model failures from
      // setup or a previous run must not prevent independent name checks.
      return !last || last.state.terminal !== 'running' ? true : undefined;
    }, 180_000);
    if (!discovered.name?.startsWith(AUTOTEST_TITLE) && !saved[key]!.name) await driver.rename(id, AUTOTEST_TITLE);

    chatId = await eventually('bridge automatically creates and binds the personal group', async () => {
      const bindings = new ToolBindingStore(join(profileDir, 'tool-bindings.json')); await bindings.load();
      const owned = bindings.entries().filter(([scope, b]) => isPersonalWorkgroup(scope, b) && b.toolId === toolId && b.sourceId === health.sourceId && b.nativeId === id);
      if (owned.length > 1) throw new Error('Autotest session has multiple personal groups');
      return owned[0]?.[0];
    }, 150_000);
    if (recorded?.chatId && recorded.chatId !== chatId) throw new Error('Autotest group changed unexpectedly');
    report.chatId = chatId; saved[key]!.chatId = chatId;
    baseline = saved[key]!.name ?? await chatName(); saved[key]!.name = baseline; await saveSession();
    await eventually('initial group name reaches native session', async () => await nativeName(id) === baseline ? true : undefined);
    stage('automatic personal group binding verified');

    const muted = await ownerCli(health.botAppId, ['im', 'chat.user_setting', 'batch_update', '--data', '-'], {
      chat_settings: [{ chat_id: chatId, is_muted: true }],
    });
    if (muted.invalid_ids?.length) throw new Error('Mute request rejected for autotest group');
    const settings = await ownerCli(health.botAppId, ['im', 'chat.user_setting', 'batch_query', '--data', '-'], { chat_ids: [chatId] });
    if (!settings.items?.some((s: any) => s.chat_id === chatId && s.is_muted === true)) throw new Error('Group is not muted');
    stage('owner notification setting verified: muted');

    const from = new Date(Date.now() - 10_000).toISOString();
    const messages = async (): Promise<any[]> => {
      const data = await ownerCli(health.botAppId, ['im', '+chat-messages-list', '--chat-id', chatId!, '--start', from,
        '--no-reactions', '--page-all', '--page-limit', '3']);
      if (data.has_more) throw new Error('Autotest message window exceeded pagination bound');
      return data.messages ?? [];
    };
    const text = (message: any) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    const prompt = (ack: string) => `飞书桥接自动集成测试。不要调用工具，不要读写文件，不要提问，只回复这一行：${ack}`;
    const groupAck = `AUTOTEST_GROUP_${toolId}_${randomUUID().replaceAll('-', '')}`;
    const groupPrompt = prompt(groupAck);
    await attempt('Feishu message round trip', async () => {
      await ownerCli(health.botAppId, ['im', '+messages-send', '--chat-id', chatId!, '--text', groupPrompt,
        '--idempotency-key', randomUUID()]);
      await eventually('group input reaches native conversation', async () =>
        (await client.conversation(id)).turns.find(t => t.input.trim() === groupPrompt), 180_000);
      stage('Feishu input → native conversation verified');
      await eventually('group input and model reply reach native conversation', async () => {
        const snapshot = await client.conversation(id), turn = snapshot.turns.find(t => t.input.trim() === groupPrompt);
        if (turn && ['error', 'interrupted', 'idle_timeout'].includes(turn.state.terminal)) throw new Error(`Group test ended: ${turn.state.terminal}`);
        return turn?.state.terminal === 'done' && JSON.stringify(turn.state.blocks).includes(groupAck) ? turn : undefined;
      }, 180_000);
      await eventually('group model reply arrives in Feishu', async () => (await messages()).find(m =>
        text(m).includes(groupAck) && !text(m).includes(groupPrompt)));
      stage('Feishu input → native conversation → Feishu reply verified');
    });

    // Wait for native baseline acknowledgement before introducing a new turn.
    await delay(3_000);
    const nativeAck = `AUTOTEST_NATIVE_${toolId}_${randomUUID().replaceAll('-', '')}`;
    await attempt('native message broadcast', async () => {
      const nativePrompt = prompt(nativeAck); await driver!.send(id, nativePrompt);
      await eventually('native input has native provenance', async () => {
        const turn = (await client.conversation(id)).turns.find(t => t.input.trim() === nativePrompt);
        if (turn?.bridge) throw new Error('Native test input was classified as bridge/unknown origin');
        return turn;
      });
      await eventually('native input arrives in Feishu', async () => (await messages()).find(m => text(m).includes(nativePrompt)));
      stage('native input → Feishu verified');
      await eventually('native input and model reply are readable with native provenance', async () => {
        const turn = (await client.conversation(id)).turns.find(t => t.input.trim() === nativePrompt);
        if (turn?.bridge) throw new Error('Native test input was classified as bridge/unknown origin');
        if (turn && ['error', 'interrupted', 'idle_timeout'].includes(turn.state.terminal)) throw new Error(`Native test ended: ${turn.state.terminal}`);
        return turn?.state.terminal === 'done' && JSON.stringify(turn.state.blocks).includes(nativeAck) ? turn : undefined;
      }, 180_000);
      await eventually('native input and reply both arrive in Feishu', async () => {
        const rows = await messages();
        const input = rows.find(m => text(m).includes(nativePrompt));
        const reply = rows.find(m => text(m).includes(nativeAck) && !text(m).includes(nativePrompt));
        return input && reply && input.message_id !== reply.message_id ? true : undefined;
      });
      stage('native input and reply → Feishu verified');
    });

    const suffix = randomUUID().slice(0, 8), nativeTitle = `${AUTOTEST_TITLE}-${toolId}-native-${suffix}`;
    await attempt('native title synchronization', async () => {
      await driver!.rename(id, nativeTitle);
      await eventually('native title reaches Feishu group', async () => await chatName() === nativeTitle ? true : undefined);
      stage('native rename → group rename verified');
    });
    await attempt('group title synchronization', async () => {
      const groupTitle = `${AUTOTEST_TITLE}-${toolId}-group-${suffix}`;
      await ownerCli(health.botAppId, ['im', '+chat-update', '--chat-id', chatId!, '--name', groupTitle]);
      await eventually('Feishu group title reaches native session', async () => await nativeName(id) === groupTitle ? true : undefined);
      stage('group rename → native rename verified');
    });
    if (report.failures.length) throw new Error(report.failures.join('; '));
    report.passed = true;
  } catch (error) {
    report.passed = false; report.error = error instanceof Error ? error.message : 'Live scenario failed'; throw error;
  } finally {
    try {
      if (chatId && baseline) {
        await ownerCli(health.botAppId, ['im', '+chat-update', '--chat-id', chatId, '--name', baseline]);
        await eventually('restore autotest baseline name', async () => await nativeName(report.nativeId!) === baseline ? true : undefined);
        report.restored = true;
      }
    } catch (error) {
      report.passed = false; report.restored = false;
      report.error = `Name restoration failed: ${error instanceof Error ? error.message : 'unknown'}`;
      throw error;
    } finally { await driver?.close(); await persistReport(); }
  }
  return { ...report, reportPath };
}
