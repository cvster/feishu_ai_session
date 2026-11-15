// Read-only MCP diagnostic. Does not send model input or control the desktop.
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
if (process.platform !== 'win32') throw new Error('Windows only');
const config = readFileSync(`${process.env.USERPROFILE}/.codex/config.toml`, 'utf8');
const section = name => config.split(`[${name}]`)[1]?.split(/^\[/m)[0] ?? '';
const value = s => s.startsWith("'") ? s.slice(1, -1) : JSON.parse(s);
const command = value(section('mcp_servers.node_repl').match(/^command\s*=\s*(.+)$/m)[1].trim());
const env = { ...process.env };
for (const line of section('mcp_servers.node_repl.env').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = value(m[2]);
}
const cliIndex = process.argv.indexOf('--cli');
if (cliIndex >= 0) env.CODEX_CLI_PATH = process.argv[cliIndex+1];
const child = spawn(command, [], { env, windowsHide: true });
const timeout = setTimeout(() => { console.error('MCP probe timeout'); child.kill(); process.exitCode = 1; }, 30000);
child.stderr.on('data', b => process.stderr.write(b));
let buffered = '';
const send = data => child.stdin.write(JSON.stringify({jsonrpc:'2.0', ...data})+'\n');
child.stdout.on('data', b => {
  buffered += b;
  while (buffered.includes('\n')) {
    const i = buffered.indexOf('\n'), line = buffered.slice(0,i); buffered = buffered.slice(i+1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id === 1) {
      send({method:'notifications/initialized'});
      send({id:2, method:'tools/call',params:{name:'js',arguments:{code:process.argv.includes('--sky') ? 'const { sky } = await import("@oai/sky"); nodeRepl.write(JSON.stringify({windowCount:(await sky.list_windows()).length}));' : 'nodeRepl.write(String(1+1))',title:'MCP runtime diagnostic'}}});
    }
    if (m.id === 2) { console.log(JSON.stringify(m)); if(m.error || m.result?.isError) process.exitCode=1; clearTimeout(timeout); child.stdin.end(); }
  }
});
child.on('exit', c => { clearTimeout(timeout); if(c) process.exitCode=c; });
send({id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'windows-node-repl-probe',version:'1'}}});
