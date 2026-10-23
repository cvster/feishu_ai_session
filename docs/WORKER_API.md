# Unified execution worker API

Codex, Claude, Kilo, ZCode and DSH all use the same authenticated loopback HTTP
API. The bridge discovers workers and reads their capabilities; native protocols,
local executable paths, account directories and provider configuration belong to
workers. Only Codex currently advertises native question/answer support.

## Discovery and identity

The bridge scans immediate real subdirectories of `profiles/<profile>/workers/`
for `endpoint.json`. Directory names are arbitrary. A worker publishes:

```json
{ "version": 1, "url": "http://127.0.0.1:12345", "token": "random-bearer-token", "pid": 123 }
```

Every route requires `Authorization: Bearer <token>`. Discovery authenticates
`GET /health`, validates the common protocol and bot application, then registers
the returned `toolId`, `sourceId`, manifest and capabilities. A sanitized tool ID
may identify an external worker; adding it requires no bridge provider switch or
provider configuration. `sourceId` identifies the native account/history source.

```json
{
  "version": 1,
  "toolId": "codex",
  "sourceId": "/home/user/.codex",
  "botAppId": "cli_example",
  "manifest": {
    "label": "Codex", "nativeField": "threadId", "sessionKind": "codex-thread",
    "historyFormat": "jsonl", "nativeHistory": false
  },
  "capabilities": {
    "apiVersion": 2,
    "jobs": { "submit": true, "read": true, "stop": true, "eventCursor": true },
    "models": true,
    "sessions": { "list": true, "history": true, "rename": true, "archive": true, "fork": true },
    "nativeTurnStop": true,
    "conversation": true, "questions": true, "nativeSessionNames": true
  }
}
```

Values above are illustrative; callers use each live worker's advertised values.
`workers/registry.json` retains validated identities while offline. Missing
endpoints do not remove native histories or group bindings. Duplicate live tool
IDs disable that tool. Changed source, directory or native identity metadata is
rejected rather than rebinding existing groups. The bridge refreshes discovery
every 10 seconds and when opening the session panel. It can start with no workers.

## Common routes

| Method | Route | Request / result |
| --- | --- | --- |
| GET | `/health` | Identity, manifest, capabilities |
| GET | `/capabilities` | Capability object |
| GET | `/models?cwd=...` | `ModelOption[]` |
| POST | `/jobs` | `WorkerSubmission` → durable `WorkerJob` |
| GET | `/jobs` | Worker receipts, distinct from the native session roster |
| GET | `/jobs/:id?after=N` | Job and normalized events after sequence N |
| POST | `/jobs/:id/stop` | `{}` → `{ "ok": true }` |
| GET | `/sessions` | Native IDs, titles, cwd, timestamps and archive state |
| GET | `/sessions/:id/history` | `{ "nativeId": "...", "format": "jsonl", "content": "..." }` |
| GET | `/sessions/:id/conversation` | Normalized snapshot described below |
| GET | `/sessions/:id/questions` | Available questions with origin and delivery scope |
| POST | `/sessions/:id/answer` | `{ "questionId": "...", "answers": { "q": { "answers": ["A"] } } }` → `{ "accepted": true/false }` |
| POST | `/sessions/:id/rename` | `{ "name": "...", "cwd": "..." }` → `{ "ok": true }`; cwd optional for session providers |
| POST | `/sessions/:id/archive` | `{}` → `{ "ok": true }` |
| POST | `/sessions/:id/fork` | `{}` → `{ "nativeId": "...", "name": "...", "cwd": "..." }` |
| POST | `/sessions/:id/turn-stop` | `{ "turnId": "...", "cwd": "..." }` → `{ "stopped": true/false }` |

Encode IDs as one URL component. IDs remain opaque to the bridge. Unsupported
operations return HTTP 501 with `code: "unsupported-operation"`; there is no
local native fallback. `/session-name` and `/native-turn-stop` remain wire aliases.
History exports retain native formats, are bounded to 32 MiB, and accept no file
path. Codex/Claude use JSONL; other built-in workers use JSON snapshots.

Conversation snapshots contain `{id, name?, cwd, archived, turns}`; each turn has
`{id, createdAtMs, bridge, input, state}`. `state` is the common run-card state.
Bridge-owned turns are delivered by the job journal, while native external turns
are mirrored only to the personal owner group. Shared groups receive replies to
their own requests.

Questions contain `{id, request, available, origin, delivery?}`. The request
retains `threadId/turnId/itemId` names for wire and card-ledger compatibility.
`origin: "worker"` requires the original authenticated delivery scope;
`origin: "native"` targets the personal owner group; unknown origins are not
published. Answer callbacks revalidate token, message, binding, source, application,
archive state and current native turn. Secret fields stay in the native UI.
Workers persist answer claims before RPC; lost acknowledgements are never replayed.
Answer text is not stored in the answer-claim or question-delivery ledger.

## Capability differences

| Worker | Native rename | Native archive | Fork | Conversation mirror | Questions |
| --- | --- | --- | --- | --- | --- |
| Codex | Yes | Yes | Yes | Yes | Yes, when the native connection can answer |
| Claude | CLI title metadata | Catalog only | No | No | No |
| Kilo | Yes | Yes | Yes | Yes, configured VS Code/CLI or App | No |
| ZCode | Paired title or CLI labels | Catalog only | Yes | Paired mode | No |
| DSH | Yes | Yes | Yes | No | No |

Native stop is available for Codex with a usable shared writer, Kilo, and paired
ZCode. Workers recheck cwd, current turn and archive state before stopping.

## Group and native session names

`nativeSessionNames` advertises automatic title synchronization. Personal groups
have one-to-one native bindings; shared routes do not own the native title. The
bridge checks group titles every 15 seconds and uses worker list/rename APIs.
Initial and simultaneous changes prefer the group title. State survives restart;
failed operations retain the previous baseline. No model is invoked to rename.
Codex title writes use the live shared writer so the native Desktop also receives
the name update notification.

## Concurrency and durability

Job acceptance is persisted before execution. Stable request keys, original
message IDs and event sequences prevent duplicate execution. A bridge restart
detaches observers and keeps worker jobs alive; reconnect reuses reply IDs and
CardKit sequences. Uncertain sends retain their receipt and never switch native
endpoint to replay a mutation. Metadata mutations are serialized against admission
and rejected when a job owns the target session; paired transports also require
an idle connection. Blocking native questions pause the worker idle watchdog.

The shared worker runner also checks stale observers every 15 seconds after two
minutes without events. Adapters may provide an optional read-only `checkLiveness`
hook together with `detach`. Three consecutive checks must confirm the same
inactive observer evidence before the runner detaches its observer, records an `unknown`
terminal event and releases the job/session lease. New events, native blocking
input, unknown status, failed reads or live native work reset confirmation.
The bridge's existing job reconciliation then admits subsequent pending messages.
The original accepted request remains deduplicated and is never automatically
resubmitted; recovery does not call native interrupt or queue deletion.

Codex additionally checks bridge-observed native conversations every 15 seconds,
independently of worker job activity. For an idle interrupted conversation confirmed
by durable interruption records, pending native input must exist before it uses
`thread/queue/start` on the existing queue head, matching the Codex desktop Resume
button. Submitted input that has not started is pending in this native queue;
unsent bridge input follows normal intake before it is eligible. Active responses
are left running, and terminal interrupted responses are not pending work. Queue
head and thread state are checked again before reserving a start receipt, so removed
or already-consumed input does not trigger resume. Empty queues do not start a turn;
maintenance never adds user input or changes goal state. Each native queue item has
a persisted start receipt, so later input under the same interrupted turn remains
eligible. Uncertain writes are not replayed on later polls or worker restart;
explicit RPC rejections can retry after fresh state checks. Completed, active,
archived and no-longer-observed conversations are not resumed. Maintenance remains
confined to the Codex worker; bridge APIs and other workers retain their behavior.

Codex queued runs, including the first message of a new session, currently supply
this evidence: the corresponding shared-writer session must report idle and its
native queue must be empty. A projected unfinished tail requires durable terminal
confirmation. Queue and status are checked again after reading history. The tail
identity/status and durable execution IDs participate in the proof, so new native
activity resets the three-check sequence. Executed history does not prevent lease
release, and idle does not prove successful execution of every accepted request:
unassociated results remain `unknown`. An independent history reader, elapsed time
alone or a missing queue acknowledgement cannot prove this condition. Other
adapters keep their current behavior; no provider branches are added to the bridge.

Codex queue observers read through the same shared writer used for settings.
Local durable `task_started`/`item_completed`/`task_complete` records recover newer
turns omitted by a stale native history index. Recovery requires matching native
thread IDs and recorded user input; existing projected turns are not duplicated.
New durable execution evidence resets inactive-observer confirmation even when
the index is behind. This is a read-only fallback: it does not edit native files/databases,
restart the writer, or resubmit accepted input.

Before submission, temporary archive/status lookup failures retain the bridge
inbox receipt and defer it for five seconds. The normal worker reconciliation
retries after service recovery and notifies once. Confirmed archival, identity
mismatch, missing native sessions and changed workspace bindings remain permanent
rejections; uncertain already-accepted worker jobs are never retried this way.

Worker/host restart does not guarantee task continuation. Unfinished uncertain
jobs are marked unknown and never automatically rerun. Codex still submits to its
existing native queue/shared writer inside its worker. This migration does not
change the separate worker-shutdown lifecycle contract.

Errors have `{error, code, retryable}`. Codes are `invalid-request`, `unauthorized`,
`not-found`, `unsupported-operation`, `busy`, `conflict`, `unavailable`, and
`internal-error`. Old workers missing the common manifest/capabilities require
upgrade. See [migration instructions](WORKER_MIGRATION.md).

`capabilities.sessionListAuthoritative` is optional. When true, a successful `/sessions`
response is the complete set the current worker configuration accepts. The bridge hides
missing bindings in Web and skips their native message synchronization, without deleting
bindings, archiving native history, or dissolving groups. Failed lists do not imply archive;
Web retains the last confirmed roster. Workers without this flag retain existing offline
binding behavior. Kilo advertises it for the exclusive configured client mode.
