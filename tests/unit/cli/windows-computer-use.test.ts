import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Windows Computer Use bootstrap safety', () => {
  const host = readFileSync('tools/windows-node-repl-host.cs', 'utf8');
  const installer = readFileSync('tools/windows-install-computer-use.ps1', 'utf8');
  it('requires a complete bundled runtime and a unique observed pipe', () => {
    for (const name of ['node_repl.exe', 'node.exe', 'package.json']) expect(host).toContain(name);
    expect(host).toContain('pipes.Length != 1');
    expect(host).toContain('.staging');
  });
  it('launches the bundled MCP without a terminal or helper implementation', () => {
    expect(host).toContain('CreateNoWindow=true');
    expect(host).toContain('Pump(p.StandardOutput.BaseStream,Console.OpenStandardOutput())');
    expect(host).toContain('await destination.FlushAsync()');
    expect(host).not.toContain('NamedPipeClientStream');
    expect(host).not.toContain('codex-computer-use-swift.exe');
  });
  it('backs up and atomically updates configuration without restarting services', () => {
    expect(installer).toContain('before-dynamic-node-repl-');
    expect(installer).toContain('[IO.File]::Replace');
    expect(installer).not.toMatch(/Stop-Process|Stop-ScheduledTask|Restart-Service/);
    expect(installer).toContain("$env:OS -ne 'Windows_NT'");
  });
  it('pins the Desktop service CLI independently of the shared writer', () => {
    const desktop = readFileSync('tools/windows-launch-desktop.ps1', 'utf8');
    expect(desktop).toContain('$env:CODEX_CLI_PATH = $desktopCli');
    expect(desktop).toContain("$env:PATH = (Split-Path $desktopCli -Parent)");
    expect(installer).toContain('$RepairUserPath');
    expect(installer).toContain('user-path-before-computer-use-');
  });
});
