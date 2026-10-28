#!/usr/bin/env node
// Read the selected CLI application's scopes; update only the generated table.
import { spawnSync } from 'node:child_process';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: {
  profile: { type: 'string' }, check: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
} });
if (args.help) {
  console.log(`用法：node tools/update-feishu-permissions.mjs [--profile <lark-cli配置名>] [--check]
供维护者读取参考机器人的全部权限，写入 docs/FEISHU_PERMISSIONS.md，供安装者申请。
--profile 指定 lark-cli 的应用配置，不是桥接 profile；省略时使用当前 CLI 配置。
--check 只读比对，不修改文件；清单有变化时退出码为 1。
只调用 whoami 和应用信息 GET，不申请权限、不发起 OAuth、不切换配置。`);
  process.exit(0);
}

function cli(argv) {
  const result = spawnSync('lark-cli', [...(args.profile ? ['--profile', args.profile] : []), ...argv], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Do not echo raw CLI output: failures may contain credential/config details.
  if (result.error || result.status !== 0) throw new Error('lark-cli 查询失败，请检查 CLI 配置及 application:application:self_manage 权限；原清单未修改');
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('lark-cli 未返回有效 JSON；原清单未修改'); }
}

const start = '<!-- feishu-permissions:start -->', end = '<!-- feishu-permissions:end -->';
const file = new URL('../docs/FEISHU_PERMISSIONS.md', import.meta.url);
const text = await readFile(file, 'utf8');
if (text.split(start).length !== 2 || text.split(end).length !== 2 || text.indexOf(start) >= text.indexOf(end)) {
  throw new Error('统一权限表标记缺失或重复；原清单未修改');
}
const identity = cli(['whoami', '--as', 'bot']);
if (!/^cli_[a-zA-Z0-9]+$/.test(identity.appId ?? '') || identity.identity !== 'bot' || identity.available !== true) {
  throw new Error('当前 CLI 没有可用的机器人应用身份；原清单未修改');
}
const app = cli(['api', 'GET', `/open-apis/application/v6/applications/${identity.appId}`, '--as', 'bot',
  '--params', '{"lang":"zh_cn","user_id_type":"open_id"}', '--jq', '.data.app | {app_id,app_name,scopes}']);
if (app?.app_id !== identity.appId || typeof app.app_name !== 'string' || !Array.isArray(app.scopes) || !app.scopes.length) {
  throw new Error('应用信息不匹配或权限列表为空；原清单未修改');
}
const scopes = new Map();
for (const item of app.scopes) {
  if (typeof item?.scope !== 'string' || !/^[a-zA-Z0-9_:.-]+$/.test(item.scope) ||
    typeof item.description !== 'string' || !Array.isArray(item.token_types) || !item.token_types.length ||
    item.token_types.some(type => !['tenant', 'user'].includes(type))) {
    throw new Error('权限数据不完整或含未知身份；原清单未修改');
  }
  const prior = scopes.get(item.scope);
  scopes.set(item.scope, { ...item, token_types: [...new Set([...(prior?.token_types ?? []), ...item.token_types])] });
}
const rows = [...scopes.values()].sort((a, b) => a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0);
const count = type => rows.filter(item => item.token_types.includes(type)).length;
const cell = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\|/g, '&#124;').replace(/[\r\n]+/g, ' ');
const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const block = [start, '',
  `核对日期：${date}。清单来源（参考机器人）：${cell(app.app_name)}（\`${app.app_id}\`）。共 **${rows.length} 项**，其中 ${count('tenant')} 项支持应用 / 机器人身份，${count('user')} 项支持用户身份；每个权限标识仅列一次。`, '',
  '| 权限标识 | 后台名称 | 支持身份 |', '| --- | --- | --- |',
  ...rows.map(item => `| \`${item.scope}\` | ${cell(item.description)} | ${[item.token_types.includes('tenant') && '应用 / 机器人', item.token_types.includes('user') && '用户'].filter(Boolean).join('、')} |`),
  '', end].join('\n');
const next = text.slice(0, text.indexOf(start)) + block + text.slice(text.indexOf(end) + end.length);
if (next === text) console.log(`权限清单已是最新：${app.app_id}，${rows.length} 项`);
else if (args.check) { console.log(`权限清单需要更新：${app.app_id}，${rows.length} 项`); process.exitCode = 1; }
else {
  const temporary = new URL(`../docs/.FEISHU_PERMISSIONS.${process.pid}.tmp`, import.meta.url);
  try { await writeFile(temporary, next, { flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
  console.log(`已更新 docs/FEISHU_PERMISSIONS.md：${app.app_id}，${rows.length} 项（机器人 ${count('tenant')}，用户 ${count('user')}）`);
}
