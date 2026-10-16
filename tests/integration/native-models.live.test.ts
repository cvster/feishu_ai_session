import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../../src/agent/codex/adapter';
import { ClaudeAdapter } from '../../src/agent/claude/adapter';
import { ZcodeAdapter } from '../../src/agent/zcode/adapter';
it.skipIf(process.env.MODEL_DISCOVERY_LIVE !== '1')('reads all three native catalogs without creating a conversation or submitting a user message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-model-read-'));
  try {
    const agents = [new CodexAdapter({ binary: process.env.LARK_CHANNEL_CODEX_BIN ?? 'codex', profileStateDir: dir, inheritCodexHome: true }), new ClaudeAdapter(), new ZcodeAdapter()];
    for (const agent of agents) {
      const models = await agent.listModels({ cwd: dir });
      expect(models.length, agent.id).toBeGreaterThan(0);
      expect(models.every(model => typeof model.value === 'string' && typeof model.label === 'string'), agent.id).toBe(true);
      process.stdout.write(`${agent.id}: ${models.length} native models\n`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 60000);
