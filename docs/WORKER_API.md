# Unified execution worker API

Claude, Kilo, ZCode and DSH use the same authenticated loopback HTTP server and
client. Provider selection belongs to worker construction, not request routing.
Codex remains on its native app-server/queue transport; this change does not add
a Codex worker or move ownership of Codex turns.

## Discovery and capabilities

Each worker writes `endpoint.json` in its own state directory, containing the
loopback URL, bearer token and PID. All routes require the bearer token. Before
calling operations, `WorkerClient` verifies `/health` against the expected
`toolId`, `sourceId` and `botAppId`.

`GET /health` retains `version: 1` and the old compatibility flags, and adds:

```json
{
  "capabilities": {
    "apiVersion": 2,
    "jobs": { "submit": true, "read": true, "stop": true, "eventCursor": true },
    "models": true,
    "sessions": { "list": true, "history": true, "rename": true, "archive": false, "fork": false },
    "nativeTurnStop": false
  }
}
```

`GET /capabilities` returns the capability object alone. The above values are an
example; clients must use the worker's actual values. A false capability means
the common route returns HTTP 501 with `code: "unsupported-operation"`.

## Common routes

| Method | Route | Request / result |
| --- | --- | --- |
| GET | `/health` | Identity, compatibility flags, capabilities |
| GET | `/capabilities` | Capability object |
| GET | `/models?cwd=...` | `ModelOption[]` |
| POST | `/jobs` | `WorkerSubmission` → durable `WorkerJob` |
| GET | `/jobs` | Jobs accepted by this worker; **not** the native session roster |
| GET | `/jobs/:id?after=N` | Job and normalized `AgentEvent` records after sequence N |
| POST | `/jobs/:id/stop` | `{}` → `{ "ok": true }` |
| GET | `/sessions` | Native `ToolSession[]`, using `nativeId`, name, cwd and timestamps |
| GET | `/sessions/:nativeId/history` | Native history export described below |
| POST | `/sessions/:nativeId/rename` | `{ "name": "...", "cwd": "..." }` → `{ "ok": true }`; cwd optional for session providers |
| POST | `/sessions/:nativeId/archive` | `{}` → `{ "ok": true }`, only if native archival is supported |
| POST | `/sessions/:nativeId/fork` | `{}` → `{ "nativeId": "...", "name": "...", "cwd": "..." }` |
| POST | `/sessions/:nativeId/turn-stop` | `{ "turnId": "...", "cwd": "..." }` → `{ "stopped": true/false }` |

Encode native session IDs as one URL component. IDs remain opaque at the
transport boundary; provider adapters validate their own native formats.
`/session-name` and `/native-turn-stop` remain aliases for installed clients.

History exports have a common envelope:

```json
{ "nativeId": "...", "format": "jsonl", "content": "...native records..." }
```

`format` is `jsonl` for Claude and `json` for Kilo, ZCode and DSH. Native records
retain their provider format: this API does not normalize all historic messages
into a browser transcript. Executing jobs already expose normalized `AgentEvent`
records through `/jobs/:id`. Exports are limited to 32 MiB and omit a partial
JSONL tail. Clients cannot supply a file path to read.

## Capability differences

| Worker | Native session rename | Native archive | Fork | Native desktop turn stop |
| --- | --- | --- | --- | --- |
| Claude | Writes CLI custom-title metadata | Unsupported; bridge catalog owns archival | Unsupported | Unsupported |
| Kilo | Native API | Native API | Native API | Available; validates cwd, current turn and native input origin |
| ZCode | Native title in paired mode; local labels in CLI mode | Unsupported; bridge catalog owns archival | Native fork | Available in paired mode |
| DSH | Native API | Native API | Native API | Unsupported |

All workers expose model discovery when their adapter supplies it. Supporting
the same interface does not imply inventing a native feature absent from a tool.

## Group and native session names

Personal whole-group bindings synchronize names in both directions:

| Tool | Automatic name synchronization | Observation |
| --- | --- | --- |
| Codex | Yes, in Codex primary profiles | Native thread reader |
| Kilo | Yes | Native conversation reader |
| Claude | Yes, with worker session list/rename capabilities | Native metadata polling through worker API |
| DSH | Yes, with worker session list/rename capabilities | Native metadata polling through worker API |
| ZCode | Yes, in paired desktop mode | Native metadata polling through worker API |

Metadata polling runs every 10 seconds without submitting model input. The
first observation adopts the live group name; later edits flow from either
side, with the group winning simultaneous changes. Baselines survive restarts
in `<tool>-name-sync.json`. Failed reads or renames leave the baseline intact
for a later retry, including worker `busy` rejections.

Archived, topic and auxiliary bindings (including legacy FF groups) are excluded, as are other accounts,
bots and data sources. The metadata pollers and Kilo reader pause name
synchronization when multiple personal groups own the same native session.
CLI-mode ZCode
labels remain local aliases. Claude native archive/fork and Claude/DSH desktop
turn observation remain unsupported; name synchronization does not add them.

Kilo mirror stop requests use the common worker turn-stop route when advertised.
For installed workers without that capability, compatibility is selected before
the write and uses the existing native reader. A false stop result or a lost
acknowledgement never triggers a second stop via another transport. The worker
rereads the native session and refuses archived, completed, bridge-origin,
stale-turn or mismatched-directory requests; closing its reader detaches from
attached editor/desktop services.

Personal bindings are unique within the current bot/profile by `(toolId,
sourceId, nativeId)`. Both the tool-binding ledger and runtime catalog writes
enforce this rule; a new conversation retires the group's old live catalog rows
while retaining history. Manual and automatic group creation share a lease for
the native session across remote group creation and binding. Missing chat-list
entries do not release ownership; confirmed group cleanup or explicit closure
does. Resume conflicts are rejected before interrupting the current run.

Startup reconciles stale catalog/tool-ledger state and legacy duplicates before
intake starts. It retains the earliest established active personal binding
(ties use scope ID order), closes other duplicate bridge scopes, and preserves
groups and native histories. Shared auxiliary routes do not count as personal
owners. New FF native sessions and FF personal groups remain disabled; existing
FF groups are compatibility routes to the original session.

## Concurrency, durability and upgrades

Metadata mutations are serialized against task admission and rejected with a
retryable `busy` error for an active target session, including IDs discovered
after new-session creation. Paired transports also block model discovery and
mutations while a job owns the paired connection. Independent native history
readers remain available during execution.

Job acceptance, request-key deduplication, durable event sequence numbers and
detachable observers retain their existing behavior. Loss of an acknowledgement
does not trigger another write, an alternative endpoint or a task cancellation.

Errors retain the existing `{ "error": "...", "retryable": false }` fields and
add `code`: `invalid-request`, `unauthorized`, `not-found`,
`unsupported-operation`, `busy`, `conflict`, `unavailable` or `internal-error`.

The bridge uses `WorkerSessionClient` for native session discovery/operations and
`WorkerClient.models` for model discovery. When `/health` lacks capabilities,
it selects the existing v1 path **before** an operation. It never falls back
after an attempted mutation. Catalog-only archival stays in the bridge rather
than claiming native data was archived.

The bridge and workers can be upgraded independently. Building and pushing this
change does not update running services; deploy each intended worker separately.
