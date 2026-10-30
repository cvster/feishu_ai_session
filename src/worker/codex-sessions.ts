import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CodexThreadReader, type CodexThreadReaderOptions } from '../session/codex-thread-reader';
import { listCodexThreadHistory, normalizeThread } from '../session/codex-history';
import { nativeSessionOperations } from '../tools/session-operations';
import { exportWorkerHistory } from './history';
import type { AgentAdapter } from '../agent/types';
import type { ToolSession } from '../tools/types';
import type { WorkerSessionService, WorkerQuestion } from './protocol';
import { codexTurnRunState } from '../card/codex-turn-state';
import { externalUserText } from './codex-projection';
import { isCodexBridgeClientMessageId, isClaimedCodexBridgeTurn } from '../session/codex-origin';
import { parseCodexAsyncInput, serializeCodexAsyncAnswers, codexAsyncAnsweredIds } from '../session/codex-async-input';
import { codexInputKey, type CodexInputAnswers, type CodexInputPrompt } from '../session/codex-user-input';
import { writeFileAtomic } from '../platform/atomic-write';
import { WorkerApiError } from './tool-api';
import { startCodexAutoContinue } from './codex-auto-continue';

/** Native RPC, history formats and answer compatibility are confined to this provider. */
export function createCodexWorkerSessions(options: CodexThreadReaderOptions, sourceId: string, agent: AgentAdapter, botAppId = ''): WorkerSessionService {
  // Keep historical intake provenance available after transport migration.
  let legacyRecords: import('../session/codex-submissions').CodexSubmissionRecord[] = [];
  const legacyLoaded = readFile(join(resolve(options.profileStateDir, '../..'), 'codex-submissions.json'), 'utf8').then(text => {
    const parsed = JSON.parse(text); legacyRecords = parsed.records ?? [];
  }).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const legacyFor = (id: string, turn: import('../session/codex-thread-reader').CodexThreadTurn) => legacyRecords.find(record => record.threadId === id &&
    !['rejected', 'cancelled'].includes(record.status) && (record.turnId === turn.id || (!!record.clientUserMessageId && promptItem(turn)?.clientId === record.clientUserMessageId) ||
      (record.transport === 'cli' && record.prompt?.trim() === externalUserText(turn) && !record.knownTurnIds?.includes(turn.id) && (turn.startedAtMs ?? 0) >= record.createdAtMs - 5000)));
  // Only the message that opened a turn proves its origin. The bridge also submits follow-up answers
  // inside an already running turn, and those items carry a bridge client id as well, which used to
  // mark natively started turns as bridge-owned.
  const promptItem = (turn: import('../session/codex-thread-reader').CodexThreadTurn) => turn.items.find(item => item.type === 'userMessage');
  const isBridge = (id: string, turn: import('../session/codex-thread-reader').CodexThreadTurn) => !!legacyFor(id, turn) ||
    isClaimedCodexBridgeTurn(id, turn.id, externalUserText(turn)) || isCodexBridgeClientMessageId(promptItem(turn)?.clientId);
  const prompts = new Map<string, CodexInputPrompt>();
  const claimedAnswers = new Set<string>();
  let claimsSaving = Promise.resolve();
  let loaded: Promise<void> | undefined;
  const answerLedger = join(options.profileStateDir, 'answer-claims.json');
  const load = () => loaded ??= readFile(answerLedger, 'utf8').then(text => {
    const ids = JSON.parse(text); if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Invalid answer ledger');
    for (const id of ids) claimedAnswers.add(id);
  }).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const reader = new CodexThreadReader({ ...options, sharedServer: true, passive: true,
    onUserInput(prompt) { prompts.set(codexInputKey(prompt.request), prompt); },
    onNotification(method, params) {
      if (method === 'serverRequest/resolved') for (const [id, prompt] of prompts)
        if (prompt.request.threadId === params.threadId && prompt.requestId === params.requestId) prompts.delete(id);
    },
    onDisconnect() { prompts.clear(); } });
  const metadata = new Map<string, ToolSession>();
  const observed = new Map<string, number>();
  const autoContinue = startCodexAutoContinue({ client: reader,
    targets: () => [...observed].filter(([id, at]) => Date.now() - at < 60_000 && !metadata.get(id)?.archived).map(([id]) => id),
    statePath: join(options.profileStateDir, 'auto-continue.json') });
  const rosterPath = join(options.profileStateDir, 'native-roster.json');
  let rosterLoaded = false, rosterSaved = '';
  const list = async () => {
    if (!rosterLoaded) {
      try { rosterSaved = await readFile(rosterPath, 'utf8'); for (const row of JSON.parse(rosterSaved) as ToolSession[]) metadata.set(row.nativeId, row); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      rosterLoaded = true;
    }
    const [rows, archived] = await Promise.all([listCodexThreadHistory({ ...options, limit: 10000 }), reader.listArchivedThreads()]);
    const archivedIds = new Set(archived.map(thread => thread.id as string));
    for (const row of rows) metadata.set(row.threadId, { nativeId: row.threadId, name: row.name, cwd: row.cwd,
      createdAtMs: row.createdAtMs, updatedAtMs: row.updatedAtMs, archived: archivedIds.has(row.threadId) });
    for (const [id, row] of metadata) if (archivedIds.has(id)) metadata.set(id, { ...row, archived: true });
    // Archived threads leave thread/list; list them from their archive records so a
    // binding archived before this worker first saw it is still reported as archived.
    for (const thread of archived) {
      const row = normalizeThread(thread);
      if (row && !metadata.has(row.threadId)) metadata.set(row.threadId, { nativeId: row.threadId, name: row.name, cwd: row.cwd,
        createdAtMs: row.createdAtMs, updatedAtMs: row.updatedAtMs, archived: true });
    }
    const roster = JSON.stringify([...metadata.values()]);
    if (roster !== rosterSaved) { await writeFileAtomic(rosterPath, roster, { mode: 0o600 }); rosterSaved = roster; }
    return [...metadata.values()].filter(row => rows.some(r => r.threadId === row.nativeId) || row.archived);
  };
  const conversation = async (id: string) => {
    await legacyLoaded;
    if (!metadata.has(id)) await list();
    let row = metadata.get(id);
    if (!row) {
      // Newly forked threads can be readable before Codex includes them in thread/list.
      // Resolve the exact native identity rather than inferring deletion from the roster.
      const result = await reader.rpc('thread/read', { threadId: id, includeTurns: false });
      const thread = result.thread as { id?: unknown; cwd?: unknown; name?: unknown; createdAt?: unknown; updatedAt?: unknown } | undefined;
      if (!thread) throw new WorkerApiError(404, 'Native session not found', 'not-found');
      if (thread.id !== id || typeof thread.cwd !== 'string' || !thread.cwd.trim())
        throw new WorkerApiError(502, 'Native session metadata identity mismatch', 'internal-error', true);
      row = { nativeId: id, name: typeof thread.name === 'string' ? thread.name : undefined, cwd: thread.cwd,
        createdAtMs: typeof thread.createdAt === 'number' ? thread.createdAt * 1000 : 0,
        updatedAtMs: typeof thread.updatedAt === 'number' ? thread.updatedAt * 1000 : 0 };
      metadata.set(id, row);
    }
    const snapshot = await reader.readThread(id), archived = (await reader.listArchivedThreadIds()).includes(id);
    if (archived) observed.delete(id); else observed.set(id, Date.now());
    const now = Date.now();
    return { id, name: snapshot.name ?? row.name, cwd: row.cwd, archived,
      turns: snapshot.turns.map(turn => ({ id: turn.id, createdAtMs: turn.startedAtMs ?? row.createdAtMs,
        bridge: isBridge(id, turn),
        input: externalUserText(turn), state: codexTurnRunState(turn, { firstSeenAtMs: turn.startedAtMs ?? now, lastActivityAtMs: now, checkedAtMs: now }) })) };
  };
  const questions = async (id: string): Promise<WorkerQuestion[]> => {
    await Promise.all([load(), legacyLoaded]);
    if ((await reader.listArchivedThreadIds()).includes(id)) return [];
    await reader.watchLoadedThread(id).catch(() => false);
    const snapshot = await reader.readThread(id), turn = snapshot.turns.at(-1);
    if (!turn || turn.status !== 'inProgress') return [];
    const result = new Map<string, WorkerQuestion>();
    for (const [key, prompt] of prompts) if (prompt.request.threadId === id && prompt.request.turnId === turn.id)
      result.set(key, { id: key, request: prompt.request, available: !claimedAnswers.has(key), origin: isBridge(id, turn) ? 'unknown' : 'native' });
    const answered = codexAsyncAnsweredIds(turn);
    for (const item of turn.items) {
      const request = parseCodexAsyncInput(id, turn.id, item); if (!request) continue;
      request.answeredQuestionIds = request.questions.filter(q => answered.has(q.id) || answered.has(request.itemId) || claimedAnswers.has(`${codexInputKey(request)}:${q.id}`)).map(q => q.id);
      if (request.answeredQuestionIds.length === request.questions.length) continue;
      const key = codexInputKey(request);
      result.set(key, { id: key, request, available: snapshot.status?.type === 'active' && !claimedAnswers.has(key), origin: isBridge(id, turn) ? 'unknown' : 'native' });
    }
    const record = legacyFor(id, turn);
    return [...result.values()].map(question => record ? { ...question, origin: 'worker' as const, delivery: {
      scope: record.scope, chatId: record.messages[0]?.chatId ?? record.scope.split(':')[0]!,
      replyTo: record.replyTo ?? record.messages.at(-1)?.messageId ?? record.id, replyInThread: record.replyInThread,
      operatorOpenId: record.messages[0]?.senderId ?? '', policyFingerprint: '', sourceId, botAppId,
    } } : question);
  };
  const provider = nativeSessionOperations({ id: 'codex', sourceId, agent });
  return { nativeNames: true, list, conversation, questions,
    receiveInput(prompt) { prompts.set(codexInputKey(prompt.request), prompt); },
    waitingForInput(id) { return [...prompts].some(([key, prompt]) => prompt.request.threadId === id && prompt.request.isBlocking && !claimedAnswers.has(key)); },
    history: id => exportWorkerHistory(provider, id), rename: (id, name) => provider.rename(id, name), archive: id => provider.archive(id),
    fork: async id => { if (!agent.forkThread) throw new WorkerApiError(501, 'Fork unsupported', 'unsupported-operation');
      const row = await agent.forkThread(id); return { nativeId: row.threadId, name: row.name, cwd: row.cwd }; },
    async answer(id: string, questionId: string, answers: CodexInputAnswers) {
      const question = (await questions(id)).find(q => q.id === questionId);
      if (!question?.available) throw new WorkerApiError(409, 'Question is stale, unavailable or already submitted', 'conflict');
      if (claimedAnswers.has(questionId)) throw new WorkerApiError(409, 'Answer already submitted', 'conflict');
      // Reserve and persist before RPC. Lost acknowledgements never cause replay after restart.
      const allowed = question.request.questions.filter(q => !question.request.answeredQuestionIds?.includes(q.id));
      const ids = Object.keys(answers);
      if (!ids.length || ids.some(id => !allowed.some(q => q.id === id && !q.isSecret)) ||
        (question.request.kind !== 'async' && ids.length !== allowed.length)) throw new WorkerApiError(400, 'Invalid question answers', 'invalid-request');
      for (const id of ids) {
        const q = allowed.find(q => q.id === id)!, values = answers[id]?.answers;
        if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string' || !values[0].trim() ||
          values[0].length > 10000 || /\u0000/.test(values[0]) ||
          (q.options?.length && !q.isOther && !q.options.some(option => option.label === values[0])))
          throw new WorkerApiError(400, 'Invalid question answers', 'invalid-request');
      }
      const claims = question.request.kind === 'async' ? ids.map(id => `${questionId}:${id}`) : [questionId];
      if (claims.some(key => claimedAnswers.has(key))) throw new WorkerApiError(409, 'Answer already submitted', 'conflict');
      for (const key of claims) claimedAnswers.add(key);
      const claimsSnapshot = JSON.stringify([...claimedAnswers]);
      claimsSaving = claimsSaving.then(() => writeFileAtomic(answerLedger, claimsSnapshot, { mode: 0o600 }));
      await claimsSaving;
      const snapshot = await reader.readThread(id), turn = snapshot.turns.at(-1);
      if (turn?.id !== question.request.turnId || turn.status !== 'inProgress') return false;
      const prompt = prompts.get(questionId);
      if (prompt) return prompt.respond(answers);
      if (question.request.kind !== 'async' || snapshot.status?.type !== 'active') return false;
      await reader.steerTurn(id, turn.id, serializeCodexAsyncAnswers(question.request, answers)); return true;
    },
    async close() { await autoContinue.stop(); await reader.stop(); },
  };
}
