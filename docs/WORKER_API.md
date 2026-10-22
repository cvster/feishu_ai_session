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
| Kilo | Yes | Yes | Yes | Yes, VS Code/CLI | No |
| ZCode | Paired title or CLI labels | Catalog only | Yes | Paired mode | No |
| DSH | Yes | Yes | Yes | No | No |

Native stop is available for Codex with a usable shared writer, Kilo, and paired
ZCode. Workers recheck cwd, current turn and archive state before stopping.

## Group and native session names

`nativeSessionNames` advertises automatic title synchronization. Personal groups
have one-to-one native bindings; shared routes do not own the native title. The
bridge checks group titles every 10 seconds and uses worker list/rename APIs.
Initial and simultaneous changes prefer the group title. State survives restart;
failed operations retain the previous baseline. No model is invoked to rename.

## Concurrency and durability

Job acceptance is persisted before execution. Stable request keys, original
message IDs and event sequences prevent duplicate execution. A bridge restart
detaches observers and keeps worker jobs alive; reconnect reuses reply IDs and
CardKit sequences. Uncertain sends retain their receipt and never switch native
endpoint to replay a mutation. Metadata mutations are serialized against admission
and rejected when a job owns the target session; paired transports also require
an idle connection. Blocking native questions pause the worker idle watchdog.

Worker/host restart does not guarantee task continuation. Unfinished uncertain
jobs are marked unknown and never automatically rerun. Codex still submits to its
existing native queue/shared writer inside its worker. This migration does not
change the separate worker-shutdown lifecycle contract.

Errors have `{error, code, retryable}`. Codes are `invalid-request`, `unauthorized`,
`not-found`, `unsupported-operation`, `busy`, `conflict`, `unavailable`, and
`internal-error`. Old workers missing the common manifest/capabilities require
upgrade. See [migration instructions](WORKER_MIGRATION.md).
