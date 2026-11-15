import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, utimes, unlink, rm, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const run = promisify(execFile), roots: string[] = [];
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
const helper = resolve('tools/windows-codex-common.ps1');
const desktop = resolve('tools/windows-launch-desktop.ps1');
const ps = async (script: string) => (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $env:PSModulePath=(Join-Path $PSHOME 'Modules')+';'+$env:PSModulePath; $ErrorActionPreference='Stop'; . ${quote(helper)}; ${script}`], { windowsHide: true })).stdout.trim();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'windows-codex-upgrade-')); roots.push(root); return root;
}
async function binary(root: string, name: string, time: number, content = 'fixture') {
  const path = join(root, 'OpenAI/Codex/bin', name, 'codex.exe');
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, content);
  for (const name of ['codex-code-mode-host.exe', 'codex-command-runner.exe', 'codex-windows-sandbox-setup.exe']) {
    await writeFile(join(dirname(path), name), 'fixture-component');
  }
  await utimes(path, new Date(time), new Date(time)); return path;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe.skipIf(process.platform !== 'win32')('Windows upgrade-friendly launcher', () => {
  it('discovers a newer Desktop binary even while the old version still exists, then after removal', async () => {
    const root = await fixture(), old = await binary(root, 'old', 10000), current = await binary(root, 'new', 20000);
    const script = `Resolve-WindowsCodexBinary -Configured ${quote(old)} -LocalAppData ${quote(root)}`;
    expect(await ps(script)).toBe(current);
    await unlink(old); expect(await ps(script)).toBe(current);
  });
  it('prefers Desktop over a stale inherited PATH for a bare codex command', async () => {
    const root = await fixture(), current = await binary(root, 'new', 20000);
    expect(await ps(`Resolve-WindowsCodexBinary -Configured codex -LocalAppData ${quote(root)}`)).toBe(current);
  });
  it('does not select an incomplete zero-byte update', async () => {
    const root = await fixture(), old = await binary(root, 'old', 10000);
    await binary(root, 'incomplete', 20000, '');
    expect(await ps(`Resolve-WindowsCodexBinary -Configured ${quote(old)} -LocalAppData ${quote(root)}`)).toBe(old);
  });
  it('skips incomplete and staging runtime sets, and snapshots survive App cleanup and reject corruption', async () => {
    const root = await fixture(), old = await binary(root, 'old', 10000);
    const incomplete = await binary(root, 'incomplete', 20000);
    await unlink(join(dirname(incomplete), 'codex-code-mode-host.exe'));
    await binary(root, '.staging-update', 30000);
    expect(await ps(`Resolve-WindowsCodexBinary -Configured ${quote(old)} -LocalAppData ${quote(root)}`)).toBe(old);
    const cache = join(root, 'owned');
    const snapshot = await ps(`Save-WindowsCodexRuntime -Binary ${quote(old)} -CacheRoot ${quote(cache)}`);
    expect(await readFile(snapshot, 'utf8')).toBe('fixture');
    await unlink(old);
    expect(await readFile(join(dirname(snapshot), 'codex-code-mode-host.exe'), 'utf8')).toBe('fixture-component');
    await writeFile(old, 'fixture');
    await writeFile(join(dirname(snapshot), 'codex-code-mode-host.exe'), 'corrupt');
    await expect(ps(`Save-WindowsCodexRuntime -Binary ${quote(old)} -CacheRoot ${quote(cache)}`)).rejects.toThrow();
  });
  it('new component sets get a separate immutable snapshot', async () => {
    const root = await fixture(), old = await binary(root, 'old', 10000), current = await binary(root, 'new', 20000, 'new-cli');
    const cache = join(root, 'owned');
    const a = await ps(`Save-WindowsCodexRuntime ${quote(old)} ${quote(cache)}`);
    const b = await ps(`Save-WindowsCodexRuntime ${quote(current)} ${quote(cache)}`);
    expect(a).not.toBe(b); expect(await readFile(a, 'utf8')).toBe('fixture'); expect(await readFile(b, 'utf8')).toBe('new-cli');
  });
  it('atomically prepares worker config while preserving unrelated settings and a backup', async () => {
    const root = await fixture(), original = await binary(root, 'fixture', 10000);
    await unlink(original);
    const source = join(root, 'fake.cs');
    await writeFile(source, 'public static class Fake { public static void Main() { System.Console.WriteLine("fixture --listen --remote"); } }');
    await ps(`Add-Type -Path ${quote(source)} -OutputAssembly ${quote(original)} -OutputType ConsoleApplication`);
    const config = join(root, '.lark-channel/profiles/test/workers/codex/config.json');
    await mkdir(dirname(config), { recursive: true });
    const data = { version: 1, toolId: 'codex', options: { binaryPath: original, appServerRemote: 'ws://127.0.0.1:4517', keep: 'unchanged' } };
    await writeFile(config, JSON.stringify(data));
    const prepare = resolve('tools/windows-prepare-codex.ps1');
    await ps(`$env:USERPROFILE=${quote(root)}; & ${quote(prepare)} -Profile test`);
    const next = JSON.parse(await readFile(config, 'utf8'));
    expect(next.options.keep).toBe('unchanged'); expect(next.options.appServerRemote).toBe(data.options.appServerRemote);
    expect(next.options.binaryPath).toContain('codex-runtime');
    expect(JSON.parse(await readFile(config + '.before-owned-runtime', 'utf8'))).toEqual(data);
  });
  it('runs a GUI-subsystem supervisor with redirected logs and preserves child exit status', async () => {
    const root = await fixture(), release = join(root, 'release');
    await mkdir(join(release, 'bin'), { recursive: true });
    await writeFile(join(release, 'bin/lark-channel-bridge.mjs'), "console.log('WINDOWLESS_OK'); console.error('STDERR_OK'); process.exit(7);");
    const installer = resolve('tools/windows-install-services.ps1');
    const result = JSON.parse(await ps(`$env:USERPROFILE=${quote(root)}; & ${quote(installer)} -NoRegister -NodePath ${quote(process.execPath)} -BridgeRelease ${quote(release)}`));
    const config = join(root, '.lark-channel/windows-launcher/bridge-codex.json');
    const data = JSON.parse(await readFile(config, 'utf8'));
    const exe = await readFile(result.hostExecutable);
    expect(exe.readUInt16LE(exe.readUInt32LE(0x3c) + 24 + 68)).toBe(2); // IMAGE_SUBSYSTEM_WINDOWS_GUI
    await expect(run(result.hostExecutable, [config], { windowsHide: true })).rejects.toMatchObject({ code: 7 });
    expect(await readFile(data.stdout, 'utf8')).toContain('WINDOWLESS_OK');
    expect(await readFile(data.stderr, 'utf8')).toContain('STDERR_OK');
    data.prepare = { ...data, arguments: '-e "process.exit(9)"', prepare: undefined };
    await writeFile(config, JSON.stringify(data));
    await expect(run(result.hostExecutable, [config], { windowsHide: true })).rejects.toMatchObject({ code: 9 });
  });
  it('terminates the supervised child when the native host is stopped (no orphan Node)', async () => {
    const root = await fixture(), release = join(root, 'release'), pidFile = join(root, 'child.pid');
    await mkdir(join(release, 'bin'), { recursive: true });
    await writeFile(join(release, 'bin/lark-channel-bridge.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{},1000);`);
    const installer = resolve('tools/windows-install-services.ps1');
    const result = JSON.parse(await ps(`$env:USERPROFILE=${quote(root)}; & ${quote(installer)} -NoRegister -NodePath ${quote(process.execPath)} -BridgeRelease ${quote(release)}`));
    const child = execFile(result.hostExecutable, [join(root, '.lark-channel/windows-launcher/bridge-codex.json')], { windowsHide: true }, () => {});
    let pid = 0;
    try {
      await vi.waitFor(async () => { pid = Number(await readFile(pidFile, 'utf8')); expect(pid).toBeGreaterThan(0); }, { timeout: 5000 });
      await run('taskkill.exe', ['/PID', String(child.pid), '/F'], { windowsHide: true });
      await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow(); }, { timeout: 5000 });
    } finally { child.kill(); }
  });
  it('preserves a valid custom executable, and fails rather than overriding a missing custom pin', async () => {
    const root = await fixture(), custom = join(root, 'custom.exe'); await writeFile(custom, 'custom');
    await binary(root, 'new', 20000);
    expect(await ps(`Resolve-WindowsCodexBinary -Configured ${quote(custom)} -LocalAppData ${quote(root)}`)).toBe(custom);
    await unlink(custom);
    await expect(ps(`Resolve-WindowsCodexBinary -Configured ${quote(custom)} -LocalAppData ${quote(root)}`)).rejects.toThrow();
  });
  it('fails clearly when nothing is installed without invoking another service', async () => {
    const root = await fixture();
    await expect(ps(`function Get-Command { return $null }; Resolve-WindowsCodexBinary -LocalAppData ${quote(root)}`)).rejects.toThrow();
  });
  it('requires the shared listener and remote queue flags', async () => {
    expect(await ps(`function Invoke-WindowsCodexProbe { param($Binary,$Arguments); switch ($Arguments) {
      '--version' { 'codex 9' }; 'app-server --help' { '--listen URL' }; 'queue --help' { '--remote URL' }
    } }; Test-WindowsCodexCompatibility codex | ConvertTo-Json -Compress`)).toContain('"remoteQueue":true');
    await expect(ps(`function Invoke-WindowsCodexProbe { 'unsupported' }; Test-WindowsCodexCompatibility codex`)).rejects.toThrow();
  });
  it('registers desktop autostart without launching anything even if Desktop is already running', async () => {
    const root = await fixture(); await mkdir(join(root, 'app')); await writeFile(join(root, 'app/ChatGPT.exe'), 'fixture');
    const output = await ps(`
      $global:trace=@(); function Get-AppxPackage { [pscustomobject]@{InstallLocation=${quote(root)}} }
      function Get-Process { throw 'No process inspection should be needed for -NoLaunch' }
      function Start-Process { throw 'Unexpected launch' }
      function New-ScheduledTaskAction { }
      function New-ScheduledTaskPrincipal { }
      function New-ScheduledTaskSettingsSet { }
      function New-ScheduledTaskTrigger { $global:trace += 'logon-trigger' }
      function Register-ScheduledTask { $global:trace += 'registered' }
      & ${quote(desktop)} -Install -NoLaunch
      $global:trace | ConvertTo-Json -Compress
    `);
    expect(JSON.parse(output)).toEqual(['logon-trigger', 'registered']);
  });
  it('installs a stable bundle with backups without starting services', async () => {
    const root = await fixture();
    const installer = resolve('tools/windows-install-launcher.ps1');
    const script = `$env:USERPROFILE=${quote(root)}; & ${quote(installer)} -NoRegister -NoShortcut`;
    expect(await ps(script)).toContain('"processesRestarted":false');
    const installed = join(root, '.lark-channel/windows-launcher/windows-codex-common.ps1');
    expect(await readFile(installed, 'utf8')).toBe(await readFile(helper, 'utf8'));
    await ps(script);
    expect(await readFile(installed + '.previous', 'utf8')).toBe(await readFile(helper, 'utf8'));
  });
  it('creates the blue hidden shortcut and portable port settings in an isolated desktop', async () => {
    const root = await fixture(), desktopDir = join(root, 'desktop'); await mkdir(desktopDir);
    const installer = resolve('tools/windows-install-launcher.ps1');
    const result = JSON.parse(await ps(`$env:USERPROFILE=${quote(root)}; & ${quote(installer)} -NoRegister -Port 4678 -DesktopDirectory ${quote(desktopDir)}`));
    const settings = JSON.parse(await readFile(join(result.directory, 'launcher.json'), 'utf8'));
    expect(settings).toEqual({ version: 1, port: 4678 });
    const shortcut = JSON.parse(await ps(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut(${quote(result.shortcut)}); @{target=$s.TargetPath;args=$s.Arguments;icon=$s.IconLocation} | ConvertTo-Json -Compress`));
    expect(shortcut.target.toLowerCase()).toContain('wscript.exe');
    expect(shortcut.args).toContain('windows-shortcut.vbs');
    expect(shortcut.icon).toContain('codex-blue.ico');
    expect(await readFile(join(result.directory, 'codex-blue.ico'))).toEqual(await readFile('assets/windows/codex-blue.ico'));
  });
});

it('keeps Windows launch changes outside Linux deployment and native resolution', async () => {
  const installer = await readFile('tools/windows-install-launcher.ps1', 'utf8');
  expect(installer).toContain("$env:OS -ne 'Windows_NT'");
  expect(installer).toContain('-Install -NoLaunch');
  expect(installer).not.toMatch(/Stop-Process|taskkill|Action restart/);
  const source = await readFile('tools/windows-launch-desktop.ps1', 'utf8');
  expect(source.indexOf("-Action start -Port $Port")).toBeLessThan(source.indexOf('Start-Process -FilePath $exe'));
});
