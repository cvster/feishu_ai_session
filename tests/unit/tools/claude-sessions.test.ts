import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeSessionProvider } from '../../../src/tools/claude-sessions';
const clean: string[] = [];
afterEach(async () => { await Promise.all(clean.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const id = '12345678-1234-4234-8234-123456789abc';
describe('Claude native session discovery', () => {
  it('reads authoritative name and real cwd, ignores preview/AI titles and tolerates partial appends', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-metadata-')); clean.push(root);
    const project = join(root, 'projects', '-encoded-project'); await mkdir(project, { recursive: true });
    const path = join(project, `${id}.jsonl`);
    await writeFile(path, [
      { type: 'user', sessionId: id, cwd: '/real/project', message: { content: 'AA do not use this as a name' } },
      { type: 'ai-title', title: 'AA auto title' },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    const provider = new ClaudeSessionProvider(root);
    expect((await provider.listSessions())[0]).toMatchObject({ nativeId: id, cwd: '/real/project', name: undefined });
    await appendFile(path, JSON.stringify({ type: 'custom-title', customTitle: 'AA-真实名称' }) + '\n{"type":');
    expect((await provider.listSessions())[0]?.name).toBe('AA-真实名称');
    await appendFile(path, '"progress"}\n' + JSON.stringify({ type: 'custom-title', customTitle: 'AA-改名' }) + '\n');
    expect((await provider.listSessions())[0]?.name).toBe('AA-改名');
    expect((await provider.listSessions())[0]?.name).toBe('AA-改名');
  });
  it('does not import sidechain-only files, subagent folders or missing history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-sidechain-')); clean.push(root);
    const provider = new ClaudeSessionProvider(root); expect(await provider.listSessions()).toEqual([]);
    const project = join(root, 'projects', '-project'); await mkdir(project, { recursive: true });
    await writeFile(join(project, `${id}.jsonl`), JSON.stringify({ type: 'user', sessionId: id, cwd: '/project', isSidechain: true }) + '\n');
    expect(await provider.listSessions()).toEqual([]);
  });
});
