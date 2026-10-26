#!/usr/bin/env node
// Local systemd deployment: build the clean HEAD, stage releases/<sha>, switch
// `current`, point the profile's units at `current`, restart the bridge (and
// only the workers named with --workers), then verify. Never touches Codex
// Desktop or the shared app-server. Usage:
//   node tools/deploy.mjs --profile <name> [--workers all|codex,kilo] [--skip-build] [--no-restart]
//   node tools/deploy.mjs --profile <name> --rollback <sha>
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: {
  profile: { type: 'string' }, root: { type: 'string' }, home: { type: 'string' },
  workers: { type: 'string' }, rollback: { type: 'string' },
  'skip-build': { type: 'boolean' }, 'no-restart': { type: 'boolean' },
  /** Set by the transient handoff unit: path to the restart plan to finish. */
  'self-restart': { type: 'string' },
} });
if (!args.profile) throw new Error('--profile is required');
const repo = resolve(dirname(new URL(import.meta.url).pathname), '..');
const root = resolve(args.root ?? process.env.LARK_BRIDGE_DEPLOY_ROOT ?? join(homedir(), 'lark-coding-agent-bridge'));
const home = resolve(args.home ?? process.env.LARK_CHANNEL_HOME ?? join(homedir(), '.lark-channel'));
const profileDir = join(home, 'profiles', args.profile);
const unitDir = join(homedir(), '.config/systemd/user');
const current = join(root, 'current');
const entryPattern = new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/releases/[^/"\\s]+/bin/lark-channel-bridge\\.mjs`, 'g');
// Gitignored build outputs that `pnpm build` produces and the runtime loads.
const BUILD_OUTPUTS = ['dist', 'packages/codex-core/dist', 'apps/web-app/upstream-overrides/claudecodeui-1.25.2/server/codex-core',
  'apps/web-app/upstream-overrides/claudecodeui-1.25.2/shared/codex-core-models.js'];

const sh = (cmd, argv, opts = {}) => (execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }) ?? '').trim();
const systemctl = (...argv) => sh('systemctl', ['--user', ...argv]);
const step = message => { notes.push(`• ${message}`); console.log(`• ${message}`); };
const notes = [];
const exists = path => lstat(path).then(() => true, () => false);
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, ms));

const units = (await readdir(unitDir)).filter(name => name === `lark-channel-bridge.bot.${args.profile}.service` ||
  name.startsWith('lark-channel-worker.') && name.endsWith(`.${args.profile}.service`));
const bridgeUnit = `lark-channel-bridge.bot.${args.profile}.service`;
if (!units.includes(bridgeUnit)) throw new Error(`missing ${join(unitDir, bridgeUnit)}`);
const workerTool = unit => unit.slice('lark-channel-worker.'.length, -`.${args.profile}.service`.length) || 'claude';
const workerUnits = units.filter(unit => unit !== bridgeUnit);
const restartWorkers = !args.workers ? [] : args.workers === 'all' ? workerUnits
  : args.workers.split(',').map(tool => {
    const unit = workerUnits.find(name => workerTool(name) === tool.trim());
    if (!unit) throw new Error(`no worker unit for ${tool} (have: ${workerUnits.map(workerTool).join(', ')})`);
    return unit;
  });
const mainPid = unit => Number(systemctl('show', '-p', 'MainPID', '--value', unit));

/** pnpm's build script calls nested `pnpm`; provide it through corepack when it is not on PATH. */
async function buildEnv() {
  if (spawnSync('pnpm', ['--version'], { stdio: 'ignore' }).status === 0) return process.env;
  const shim = await mkdtemp(join(tmpdir(), 'pnpm-shim-'));
  await writeFile(join(shim, 'pnpm'), '#!/bin/sh\nexec corepack pnpm "$@"\n', { mode: 0o755 });
  return { ...process.env, PATH: `${shim}:${dirname(process.execPath)}:${process.env.PATH}` };
}

async function stage(sha) {
  const release = join(root, 'releases', sha);
  if (await exists(release)) throw new Error(`${release} already exists; use --rollback ${sha} to switch to it`);
  const env = await buildEnv();
  if (!args['skip-build']) { step('building'); sh('pnpm', ['build'], { cwd: repo, env, stdio: ['ignore', 'inherit', 'inherit'] }); }
  const staging = `${release}.staging-${process.pid}`;
  await mkdir(staging, { recursive: true });
  try {
    step(`staging ${release}`);
    execFileSync('sh', ['-c', `git archive HEAD | tar -x -C "${staging}"`], { cwd: repo, stdio: ['ignore', 'inherit', 'inherit'] });
    for (const output of BUILD_OUTPUTS) {
      if (!await exists(join(repo, output))) throw new Error(`missing build output ${output}; run without --skip-build`);
      await cp(join(repo, output), join(staging, output), { recursive: true });
    }
    // Reuse the installed production dependencies when the lockfile is unchanged.
    const modules = await realpath(join(current, 'node_modules')).catch(() => undefined);
    const same = modules && await sha256(join(dirname(modules), 'pnpm-lock.yaml')).catch(() => '') === await sha256(join(staging, 'pnpm-lock.yaml'));
    if (same) await symlink(modules, join(staging, 'node_modules'));
    else { step('lockfile changed: installing production dependencies'); sh('pnpm', ['install', '--prod', '--frozen-lockfile'], { cwd: staging, env, stdio: ['ignore', 'inherit', 'inherit'] }); }
    await writeFile(join(staging, 'DEPLOYED_COMMIT'), `${sh('git', ['rev-parse', 'HEAD'], { cwd: repo })}\n`);
    await rename(staging, release);
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
  return release;
}

async function switchCurrent(release) {
  const previous = await exists(current) ? await readlink(current) : undefined;
  const next = `${current}.next-${process.pid}`;
  await symlink(release, next); await rename(next, current);
  return previous;
}

/** Point every unit of this profile at `current`, so later switches need no unit edits. */
async function pinUnitsToCurrent(backup) {
  const changed = [];
  for (const unit of units) {
    const path = join(unitDir, unit), text = await readFile(path, 'utf8');
    const next = text.replace(entryPattern, `${current}/bin/lark-channel-bridge.mjs`);
    if (next === text) continue;
    await cp(path, join(backup, unit)); await writeFile(path, next); changed.push(unit);
  }
  if (changed.length) systemctl('daemon-reload');
  return changed;
}

async function restart(unitsToRestart) {
  const before = Object.fromEntries(unitsToRestart.map(unit => [unit, mainPid(unit)]));
  for (const unit of unitsToRestart) { step(`restarting ${unit}`); systemctl('restart', unit); }
  const after = {};
  for (const unit of unitsToRestart) {
    let pid = 0;
    for (let i = 0; i < 30 && !pid; i++) { await sleep(1000); pid = spawnSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' }).stdout.trim() === 'active' ? mainPid(unit) : 0; }
    await sleep(3000);
    if (!pid || mainPid(unit) !== pid || pid === before[unit]) throw new Error(`${unit} did not come up stably (journalctl --user -u ${unit})`);
    after[unit] = pid;
  }
  return { before, after };
}

async function retry(attempts, check) {
  let value;
  for (let i = 0; i < attempts; i++) { value = await check(); if (value === 200) break; await sleep(1000); }
  return value;
}

async function webCheck() {
  const web = JSON.parse(await readFile(join(profileDir, 'web.json'), 'utf8').catch(() => '{}'));
  if (!web.enabled || !web.port) return undefined;
  const status = await retry(20, () => fetch(`http://127.0.0.1:${web.port}/`).then(r => r.status, () => 0));
  if (status !== 200) throw new Error(`web on port ${web.port} returned ${status}`);
  return { port: web.port, status };
}

/** Each worker publishes url+token in endpoint.json; a fresh restart rewrites it. */
async function workerHealth(attempts) {
  const result = {}, workersDir = join(profileDir, 'workers');
  for (const dir of await readdir(workersDir).catch(() => [])) {
    const file = join(workersDir, dir, 'endpoint.json');
    if (!await exists(file)) continue;
    result[dir] = await retry(attempts, async () => {
      const endpoint = JSON.parse(await readFile(file, 'utf8').catch(() => 'null'));
      return endpoint ? fetch(`${endpoint.url}/health`, { headers: { Authorization: `Bearer ${endpoint.token}` },
        signal: AbortSignal.timeout(3000) }).then(r => r.status, () => 0) : 0;
    });
  }
  return result;
}

/** Units restarted in order: workers first, so the new bridge attaches to their new capabilities. */
const restartGroups = args['no-restart'] ? [] : [restartWorkers, [bridgeUnit]].filter(group => group.length);

/** The systemd service this script runs inside, if any: restarting it would kill the script itself. */
async function hostingUnit() {
  if (!process.env.SYSTEMD_EXEC_PID) return undefined;
  const line = await readFile('/proc/self/cgroup', 'utf8').catch(() => '');
  return /([^/\n]+\.service)(?::|\n|$)/.exec(line.trim())?.[1];
}

async function restartAndRecord(plan) {
  const untouched = plan.untouched;
  const restarted = { before: {}, after: {} };
  for (const group of plan.restartGroups) {
    const result = await restart(group);
    Object.assign(restarted.before, result.before); Object.assign(restarted.after, result.after);
    if (group !== plan.restartGroups.at(-1)) await workerHealth(20);
  }
  for (const [unit, pid] of Object.entries(untouched)) if (mainPid(unit) !== pid) console.warn(`⚠ ${unit} changed PID during deployment (${pid} -> ${mainPid(unit)})`);
  const count = plan.restartGroups.some(group => group !== plan.restartGroups.at(-1)) ? 20 : 1;
  const checks = { web: await webCheck(), workers: await workerHealth(count) };
  const releaseDir = plan.release;
  const record = { ...plan.record, restarted: restarted.after, pidsBefore: restarted.before, checks, deployedAt: new Date().toISOString(),
    artifacts: Object.fromEntries(await Promise.all(['dist/cli.js', 'dist/index.js', 'packages/codex-core/dist/index.js']
      .map(async file => [file, await sha256(join(releaseDir, file)).catch(() => null)]))) };
  await writeFile(join(releaseDir, 'deployment.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ release: releaseDir, restarted: restarted.after, checks }, null, 2));
  if (Object.values(checks.workers).some(status => status !== 200)) console.warn('⚠ some workers did not answer /health; see checks.workers');
  if (plan.previousCurrent) console.log(`rollback: node tools/deploy.mjs --profile ${args.profile} --rollback ${basename(plan.previousCurrent)}`);
  return record;
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
if (args['self-restart']) {
  const plan = JSON.parse(await readFile(args['self-restart'], 'utf8'));
  for (const note of plan.notes) console.log(note);
  step(`resumed after the handoff unit restarted ${plan.selfUnit}`);
  await restartAndRecord(plan);
  process.exit(0);
}

let release;
if (args.rollback) {
  release = join(root, 'releases', args.rollback);
  if (!await exists(join(release, 'dist/cli.js'))) throw new Error(`${release} is not a deployable release`);
} else {
  if (sh('git', ['status', '--porcelain'], { cwd: repo })) throw new Error('working tree is not clean; commit or stash first');
  release = await stage(sh('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: repo }));
}
const backup = join(root, 'deployment-backups', `${stamp}-${basename(release)}`);
await mkdir(backup, { recursive: true });
const pinned = await pinUnitsToCurrent(backup);
const previous = await switchCurrent(release);
await writeFile(join(backup, 'previous-current'), `${previous ?? ''}\n`);
step(`current -> ${release} (was ${previous ?? 'unset'})`);
const untouched = Object.fromEntries(workerUnits.filter(unit => !restartWorkers.includes(unit)).map(unit => [unit, mainPid(unit)]));
const plan = {
  notes: [], release, previousCurrent: previous, backup, selfUnit: await hostingUnit(),
  restartGroups: restartGroups.filter(group => group.length),
  untouched,
  record: { commit: (await readFile(join(release, 'DEPLOYED_COMMIT'), 'utf8')).trim(), release, previousCurrent: previous, backup,
    rollback: !!args.rollback, unitsPinnedToCurrent: pinned, workersUntouched: Object.keys(untouched) },
};
await writeFile(join(backup, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);

if (plan.selfUnit && plan.restartGroups.some(group => group.includes(plan.selfUnit))) {
  // This script runs inside a unit it must restart. Hand the restart and the
  // verification to a transient unit outside that service's cgroup.
  const unit = `lark-bridge-deploy-${stamp}-${basename(release)}`;
  const planFile = join(backup, 'plan.json');
  plan.notes = notes;
  await writeFile(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  sh('systemd-run', ['--user', '--collect', '--unit', unit, `--working-directory=${repo}`,
    `--setenv=PATH=${dirname(process.execPath)}:${process.env.PATH}`,
    process.execPath, join(repo, 'tools/deploy.mjs'), '--profile', args.profile, '--root', root, '--home', home,
    '--self-restart', planFile]);
  console.log(`handing over to ${unit}: this process runs inside ${plan.selfUnit}, so the restarted unit must live elsewhere`);
  console.log(`follow: journalctl --user -u ${unit} -f`);
  process.exit(0);
}
await restartAndRecord({ ...plan, notes });
