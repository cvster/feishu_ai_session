import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, utimes, unlink, rm, readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

const run = promisify(execFile), roots: string[] = [];
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
const helper = resolve('tools/windows-codex-common.ps1');
const desktop = resolve('tools/windows-launch-desktop.ps1');
const ps = async (script: string) => (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `$ErrorActionPreference='Stop'; . ${quote(helper)}; ${script}`], { windowsHide: true })).stdout.trim();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'windows-codex-upgrade-')); roots.push(root); return root;
}
async function binary(root: string, name: string, time: number, content = 'fixture') {
  const path = join(root, 'OpenAI/Codex/bin', name, 'codex.exe');
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, content);
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
    const script = `$env:USERPROFILE=${quote(root)}; & ${quote(installer)} -NoRegister`;
    expect(await ps(script)).toContain('"processesRestarted":false');
    const installed = join(root, '.lark-channel/windows-launcher/windows-codex-common.ps1');
    expect(await readFile(installed, 'utf8')).toBe(await readFile(helper, 'utf8'));
    await ps(script);
    expect(await readFile(installed + '.previous', 'utf8')).toBe(await readFile(helper, 'utf8'));
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
