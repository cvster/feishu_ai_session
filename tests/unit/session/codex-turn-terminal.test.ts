import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexTurnTerminalVerifier } from '../../../src/session/codex-turn-terminal.js';

describe('CodexTurnTerminalVerifier', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it('distinguishes durable completion from app-server projected interruption', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-turn-terminal-'));
    cleanup.push(dir);
    const rollout = join(dir, 'rollout.jsonl');
    await writeFile(rollout, `${event('task_started', 'turn-1')}\n`, 'utf8');
    const verifier = new CodexTurnTerminalVerifier();

    await expect(verifier.terminalFor(rollout, 'turn-1')).resolves.toBeUndefined();
    await appendFile(rollout, `${event('task_complete', 'turn-1')}\n`, 'utf8');
    await expect(verifier.terminalFor(rollout, 'turn-1')).resolves.toBe('completed');
  });

  it('recognizes explicit aborts and file URLs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-turn-terminal-'));
    cleanup.push(dir);
    const rollout = join(dir, 'rollout.jsonl');
    await writeFile(rollout, `${event('turn_aborted', 'turn-stop')}\n`, 'utf8');
    const verifier = new CodexTurnTerminalVerifier();

    await expect(
      verifier.terminalFor(pathToFileURL(rollout).href, 'turn-stop'),
    ).resolves.toBe('interrupted');
  });

  it('keeps actual execution metadata separate for each turn and reads appended updates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-turn-metadata-'));
    cleanup.push(dir);
    const rollout = join(dir, 'rollout.jsonl');
    const context = (turnId: string, model: string, effort: string) => JSON.stringify({
      type: 'turn_context', payload: { turn_id: turnId, model, effort },
    });
    await writeFile(rollout, `${event('task_started', 'one')}\n${context('one', 'gpt-5.6-sol', 'high')}\n`);
    const verifier = new CodexTurnTerminalVerifier();
    expect((await verifier.executionsFor(rollout)).get('one')).toEqual({
      model: 'gpt-5.6-sol', reasoningEffort: 'high',
    });
    await appendFile(rollout, `${event('task_complete', 'one')}\n${event('task_started', 'two')}\n${context('two', 'gpt-6-sol', 'xhigh')}\n`);
    const metadata = await verifier.executionsFor(rollout);
    expect(metadata.get('one')).toEqual({ model: 'gpt-5.6-sol', reasoningEffort: 'high' });
    expect(metadata.get('two')).toEqual({ model: 'gpt-6-sol', reasoningEffort: 'xhigh' });
    await expect(verifier.terminalFor(rollout, 'one')).resolves.toBe('completed');
  });

  it('associates legacy unscoped aborts with the active turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-turn-terminal-'));
    cleanup.push(dir);
    const rollout = join(dir, 'rollout.jsonl');
    await writeFile(
      rollout,
      `${event('task_started', 'turn-legacy')}\n${eventWithoutTurnId('turn_aborted')}\n`,
      'utf8',
    );
    const verifier = new CodexTurnTerminalVerifier();

    await expect(verifier.terminalFor(rollout, 'turn-legacy')).resolves.toBe('interrupted');
  });

  it('recovers durable user, answer and tool items when the native projection omitted an executed turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-stale-projection-')); cleanup.push(dir);
    const rollout = join(dir, 'rollout.jsonl'), verifier = new CodexTurnTerminalVerifier();
    const item = (value: unknown) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread', turn_id: 'new', item: value } });
    await writeFile(rollout, [event('task_started', 'new'),
      item({ type: 'UserMessage', id: 'u', client_id: 'bridge-id', content: [{ type: 'text', text: 'request' }] }),
      item({ type: 'AgentMessage', id: 'a', content: [{ type: 'Text', text: 'answer' }], phase: 'final_answer' }),
      item({ type: 'CommandExecution', id: 'c', exit_code: 0, aggregated_output: 'done' }),
      item({ type: 'AgentMessage', id: 'a', content: [{ type: 'Text', text: 'answer final' }], phase: 'final_answer' }),
      event('task_complete', 'new')].join('\n') + '\n');
    const projected = { id: 'thread', rolloutPath: rollout, turns: [{ id: 'old', status: 'completed', items: [] }] };
    const recovered = await verifier.recoverMissingTurns(projected);
    expect(recovered.map(t => t.id)).toEqual(['old', 'new']);
    expect(recovered[1]).toMatchObject({ status: 'completed', items: [
      { type: 'userMessage', clientId: 'bridge-id' }, { type: 'agentMessage', text: 'answer final' }, { type: 'commandExecution', exitCode: 0, aggregatedOutput: 'done' }] });
    expect(await verifier.recoverMissingTurns({ ...projected, turns: recovered })).toHaveLength(2);
    expect(await verifier.recoverMissingTurns({ ...projected, id: 'another-thread' })).toEqual(projected.turns);
  });

  it('discards partial JSON and previous fallback turns when a rollout is truncated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-rollout-truncate-')); cleanup.push(dir);
    const rollout = join(dir, 'rollout.jsonl'), verifier = new CodexTurnTerminalVerifier();
    const item = JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', thread_id: 'thread', turn_id: 'new',
      item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: 'request' }] } } });
    await writeFile(rollout, event('task_started', 'new') + '\n' + item);
    const projected = { id: 'thread', rolloutPath: rollout, turns: [] };
    expect(await verifier.recoverMissingTurns(projected)).toEqual([]);
    await appendFile(rollout, '\n' + event('task_complete', 'new') + '\n');
    expect(await verifier.recoverMissingTurns(projected)).toMatchObject([{ id: 'new', status: 'completed' }]);
    await writeFile(rollout, '\n');
    expect(await verifier.recoverMissingTurns(projected)).toEqual([]);
    expect(await verifier.startedTurnsFor(rollout)).toEqual(new Set());
  });
});

function event(type: string, turnId: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type, turn_id: turnId },
  });
}

function eventWithoutTurnId(type: string): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'event_msg',
    payload: { type, reason: 'interrupted' },
  });
}
