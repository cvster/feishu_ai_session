import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';

const run = promisify(execFile), roots: string[] = [];
const deploySource = new URL('../../../tools/deploy.mjs', import.meta.url).pathname;
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('prints deployment help without profile, dependencies or systemd configuration', async () => {
  expect((await run(process.execPath, [deploySource, '--help'])).stdout).toContain('--check');
  await expect(run(process.execPath, [deploySource, '--profile', '../invalid'])).rejects.toMatchObject({ code: 1 });
});

it.skipIf(process.platform !== 'linux')('preflights, stages paths with spaces and reuses a release without touching credentials or restarting workers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deploy-fixture-')); roots.push(root);
  const repo = join(root, 'source $literal space'), home = join(root, 'data'), osHome = join(root, 'user'), deploy = join(root, 'release space');
  const units = join(osHome, '.config/systemd/user'), bin = join(root, 'bin'), trace = join(root, 'systemctl-calls');
  for (const directory of [join(repo, 'tools'), units, bin, join(home, 'profiles/test'), join(deploy, 'releases/old/node_modules')]) await mkdir(directory, { recursive: true });
  await cp(deploySource, join(repo, 'tools/deploy.mjs'));
  await cp(new URL('../../../tools/lib', import.meta.url).pathname, join(repo, 'tools/lib'), { recursive: true });
  await writeFile(join(repo, '.gitignore'), 'dist/\npackages/codex-core/dist/\napps/\n');
  await writeFile(join(repo, 'pnpm-lock.yaml'), 'fixture-lock');
  await writeFile(join(deploy, 'releases/old/pnpm-lock.yaml'), 'fixture-lock');
  await symlink(join(deploy, 'releases/old'), join(deploy, 'current'));
  const unit = 'lark-channel-bridge.bot.test.service';
  await writeFile(join(units, unit), `[Service]\nExecStart=${process.execPath} "${deploy}/releases/old/bin/lark-channel-bridge.mjs"\n`);
  await writeFile(join(units, 'lark-channel-worker.codex.test.service'), '[Service]\n');
  await writeFile(join(home, 'config.json'), '{}');
  const credentials = '{"secretHash":"unchanged","passwordHash":"unchanged"}';
  await writeFile(join(home, 'profiles/test/web.json'), credentials);
  await writeFile(join(bin, 'systemctl'), `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(process.argv.slice(2))+'\\n');console.log(process.argv.includes('--property=LoadState')?'loaded':'456');\n`, { mode: 0o755 });
  const env = { ...process.env, HOME: osHome, SYSTEMD_EXEC_PID: '', PATH: [bin, dirname(process.execPath), process.env.PATH].join(':') };
  const git = (...args: string[]) => run('git', args, { cwd: repo, env });
  await git('init', '-q'); await git('add', '.'); await git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  for (const output of ['dist', 'packages/codex-core/dist', 'apps/web-app/upstream-overrides/claudecodeui-1.25.2/server/codex-core']) {
    await mkdir(join(repo, output), { recursive: true }); await writeFile(join(repo, output, 'index.js'), 'fixture');
  }
  await writeFile(join(repo, 'dist/cli.js'), 'fixture');
  const shared = join(repo, 'apps/web-app/upstream-overrides/claudecodeui-1.25.2/shared');
  await mkdir(shared, { recursive: true }); await writeFile(join(shared, 'codex-core-models.js'), 'fixture');
  const args = [join(repo, 'tools/deploy.mjs'), '--profile', 'test', '--root', deploy, '--home', home];
  const preflight = JSON.parse((await run(process.execPath, [...args, '--check'], { env })).stdout);
  expect(preflight).toMatchObject({ ok: true, cleanWorkingTree: true, defaultRestart: [unit] });
  expect(await readdir(join(deploy, 'releases'))).toEqual(['old']);
  await run(process.execPath, [...args, '--skip-build', '--no-restart'], { env });
  const sha = (await git('rev-parse', '--short=7', 'HEAD')).stdout.trim();
  expect(await readFile(join(deploy, 'releases', sha, 'pnpm-lock.yaml'), 'utf8')).toBe('fixture-lock');
  const repeated = await run(process.execPath, [...args, '--no-restart'], { env });
  expect(repeated.stdout).toContain('reusing immutable release');
  expect(await readFile(join(home, 'profiles/test/web.json'), 'utf8')).toBe(credentials);
  expect((await readFile(trace, 'utf8'))).not.toContain('"restart"');
  const record = JSON.parse(await readFile(join(deploy, 'releases', sha, 'deployment.json'), 'utf8'));
  expect(record.workersUntouched).toEqual(['lark-channel-worker.codex.test.service']);
});
