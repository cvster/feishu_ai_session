import { open, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { CodexThreadItem, CodexThreadSnapshot, CodexThreadTurn } from './thread-client';

export type CodexPersistedTurnTerminal = 'completed' | 'interrupted';

export interface CodexTurnExecutionInfo {
  model?: string;
  reasoningEffort?: string;
}

interface RolloutCursor {
  offset: number;
  carry: string;
  skipFirstPartialLine: boolean;
  activeTurnId?: string;
  unscopedAbortSeen: boolean;
  terminals: Map<string, CodexPersistedTurnTerminal>;
  executions: Map<string, CodexTurnExecutionInfo>;
  startedTurns: Set<string>;
  turns: Map<string, { threadId?: string; turn: CodexThreadTurn }>;
}

const INITIAL_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * Confirms terminal turn state from Codex's durable rollout events.
 *
 * A read-only app-server intentionally projects an unfinished tail turn as
 * `interrupted` when that turn is live in another app-server. The rollout is
 * the durable source used by app-server itself: `task_complete` and
 * `turn_aborted` are unambiguous and survive process boundaries.
 */
export class CodexTurnTerminalVerifier {
  private readonly cursors = new Map<string, RolloutCursor>();

  async terminalFor(
    rolloutPath: string | undefined,
    turnId: string,
  ): Promise<CodexPersistedTurnTerminal | undefined> {
    const cursor = await this.loadCursor(rolloutPath);
    return cursor?.terminals.get(turnId) ??
      (cursor?.unscopedAbortSeen ? 'interrupted' : undefined);
  }

  async executionsFor(rolloutPath: string | undefined): Promise<ReadonlyMap<string, CodexTurnExecutionInfo>> {
    return (await this.loadCursor(rolloutPath))?.executions ?? new Map();
  }

  async startedTurnsFor(rolloutPath: string | undefined): Promise<ReadonlySet<string>> {
    return (await this.loadCursor(rolloutPath))?.startedTurns ?? new Set();
  }

  /** Recover only attributed, durable turns missing from the native index. */
  async recoverMissingTurns(snapshot: CodexThreadSnapshot): Promise<CodexThreadTurn[]> {
    const cursor = await this.loadCursor(snapshot.rolloutPath);
    if (!cursor) return snapshot.turns;
    const known = new Set(snapshot.turns.map(turn => turn.id));
    const latest = Math.max(0, ...snapshot.turns.map(turn => turn.startedAtMs ?? 0));
    const missing = [...cursor.turns.values()].filter(({ threadId, turn }) => threadId === snapshot.id && !known.has(turn.id) &&
      (turn.startedAtMs ?? 0) >= latest && turn.items.some(item => item.type === 'userMessage'));
    return [...snapshot.turns, ...missing.map(({ turn }) => ({ ...turn, items: [...turn.items] }))];
  }

  private async loadCursor(rolloutPath: string | undefined): Promise<RolloutCursor | undefined> {
    const path = localPath(rolloutPath);
    if (!path) return undefined;

    let info;
    try {
      info = await stat(path);
    } catch {
      return undefined;
    }
    if (!info.isFile()) return undefined;

    let cursor = this.cursors.get(path);
    if (!cursor || info.size < cursor.offset) {
      cursor = {
        offset: Math.max(0, info.size - INITIAL_TAIL_BYTES),
        carry: '',
        skipFirstPartialLine: info.size > INITIAL_TAIL_BYTES,
        unscopedAbortSeen: false,
        terminals: new Map(),
        executions: new Map(),
        startedTurns: new Set(),
        turns: new Map(),
      };
      this.cursors.set(path, cursor);
    }
    if (info.size > cursor.offset) {
      await this.readAppended(path, info.size, cursor);
    }
    return cursor;
  }

  private async readAppended(path: string, size: number, cursor: RolloutCursor): Promise<void> {
    const length = size - cursor.offset;
    const buffer = Buffer.allocUnsafe(length);
    const handle = await open(path, 'r');
    try {
      const { bytesRead } = await handle.read(buffer, 0, length, cursor.offset);
      cursor.offset += bytesRead;
      const text = cursor.carry + buffer.subarray(0, bytesRead).toString('utf8');
      const lines = text.split(/\r?\n/);
      cursor.carry = lines.pop() ?? '';
      if (cursor.skipFirstPartialLine && lines.length > 0) {
        lines.shift();
        cursor.skipFirstPartialLine = false;
      }
      for (const line of lines) recordEvent(line, cursor);
    } finally {
      await handle.close();
    }
  }
}

function recordEvent(line: string, cursor: RolloutCursor): void {
  if (
    !line.includes('task_started') &&
    !line.includes('turn_started') &&
    !line.includes('task_complete') &&
    !line.includes('turn_complete') &&
    !line.includes('turn_aborted') &&
    !line.includes('turn_context') &&
    !line.includes('item_completed')
  ) {
    return;
  }
  let envelope: Record<string, unknown> | undefined;
  try {
    envelope = recordValue(JSON.parse(line));
  } catch {
    return;
  }
  const payload = recordValue(envelope?.payload);
  if (envelope?.type === 'turn_context') {
    const contextTurnId = stringValue(payload?.turn_id) ?? cursor.activeTurnId;
    if (contextTurnId) {
      cursor.startedTurns.add(contextTurnId);
      const model = stringValue(payload?.model);
      const effort = stringValue(payload?.effort) ?? stringValue(payload?.reasoning_effort);
      cursor.executions.set(contextTurnId, {
        ...cursor.executions.get(contextTurnId),
        ...(model ? { model } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
      });
      const stored = cursor.turns.get(contextTurnId);
      if (stored) Object.assign(stored.turn, cursor.executions.get(contextTurnId));
    }
    return;
  }
  if (envelope?.type !== 'event_msg') return;
  const type = stringValue(payload?.type);
  const turnId = stringValue(payload?.turn_id);
  if (type === 'item_completed' && turnId) {
    const stored = cursor.turns.get(turnId), item = durableItem(payload?.item);
    const threadId = stringValue(payload?.thread_id);
    if (!stored || !item || !threadId || (stored.threadId && stored.threadId !== threadId)) return;
    stored.threadId = threadId;
    const index = stored.turn.items.findIndex(previous => previous.id === item.id);
    if (index < 0) stored.turn.items.push(item); else stored.turn.items[index] = item;
    return;
  }
  if ((type === 'task_started' || type === 'turn_started') && turnId) {
    cursor.startedTurns.add(turnId);
    cursor.activeTurnId = turnId;
    cursor.turns.set(turnId, { turn: { id: turnId, status: 'inProgress', items: [],
      startedAtMs: timestampMs(payload?.started_at) ?? timestampMs(envelope?.timestamp) } });
    cursor.unscopedAbortSeen = false;
    return;
  }
  if ((type === 'task_complete' || type === 'turn_complete') && turnId) {
    cursor.startedTurns.add(turnId);
    cursor.terminals.set(turnId, 'completed');
    const stored = cursor.turns.get(turnId);
    if (stored) { stored.turn.status = 'completed'; stored.turn.completedAtMs = timestampMs(payload?.completed_at) ?? timestampMs(envelope?.timestamp); }
    if (cursor.activeTurnId === turnId) cursor.activeTurnId = undefined;
    cursor.unscopedAbortSeen = false;
    return;
  }
  if (type !== 'turn_aborted') return;
  const abortedTurnId = turnId ?? cursor.activeTurnId;
  if (abortedTurnId) {
    cursor.terminals.set(abortedTurnId, 'interrupted');
    const stored = cursor.turns.get(abortedTurnId);
    if (stored) { stored.turn.status = 'interrupted'; stored.turn.completedAtMs = timestampMs(envelope?.timestamp); }
    if (cursor.activeTurnId === abortedTurnId) cursor.activeTurnId = undefined;
    cursor.unscopedAbortSeen = false;
  } else {
    // Legacy rollouts can omit turn_id. This still closes the currently
    // reconstructed tail turn, matching app-server's own recovery logic.
    cursor.unscopedAbortSeen = true;
  }
}

function durableItem(input: unknown): CodexThreadItem | undefined {
  const raw = recordValue(input), kind = stringValue(raw?.type), id = stringValue(raw?.id);
  if (!raw || !kind || !id) return;
  const type = kind[0]!.toLowerCase() + kind.slice(1);
  if (!['userMessage', 'agentMessage', 'reasoning', 'commandExecution', 'mcpToolCall'].includes(type)) return;
  return { ...raw, type, id,
    ...(type === 'userMessage' ? { clientId: raw.client_id ?? raw.clientId } : {}),
    ...(type === 'agentMessage' ? { text: Array.isArray(raw.content) ? raw.content.map(value => stringValue(recordValue(value)?.text) ?? '').join('') : stringValue(raw.text) ?? '' } : {}),
    ...(type === 'reasoning' ? { summary: raw.summary_text ?? raw.summary, content: raw.raw_content ?? raw.content } : {}),
    ...(type === 'commandExecution' ? { exitCode: raw.exit_code ?? raw.exitCode, aggregatedOutput: raw.aggregated_output ?? raw.aggregatedOutput } : {}),
  };
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value !== 'string') return;
  const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined;
}

function localPath(input: string | undefined): string | undefined {
  if (!input) return undefined;
  if (!input.startsWith('file:')) return input;
  try {
    return fileURLToPath(input);
  } catch {
    return undefined;
  }
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined;
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' ? input : undefined;
}
