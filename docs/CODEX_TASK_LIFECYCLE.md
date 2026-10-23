# Codex tasks survive bridge restart

The standard runtime sends both first and follow-up messages through the
official `codex queue` entry point. The Desktop/shared writer owns execution;
the Codex worker submits or reads. First messages create idle history with
public `thread/start`, materialize it using `thread/name/set`, validate it with
`thread/read`, then close that creator before queueing. No bridge-owned
`turn/start` is used. The standalone CLI's compatible `legacy` history mode is
used for this idle preparation; `threadSource` remains `lark-channel-bridge`.
The group name replaces the temporary title through existing name sync.

## Uniform worker boundary

The bridge discovers the Codex worker through `workers/*/endpoint.json` and uses
common job, conversation, model, title, archive and question APIs. Native queue
submission and public shared-reader handling now belong to the worker. Codex
installation and account options live in `workers/codex/config.json`; deploying
only other tools needs no Codex installation. See [migration](WORKER_MIGRATION.md).

`/stop` targets the current worker job, or the exact mirrored native turn through
the common turn-stop endpoint. Stale native cards never stop a later task.
Unsubmitted bridge intake remains queued; archive closes and rejects that route's
input. Native job cancellation semantics still belong to the Codex queue adapter.
Bridge restart detaches observers; worker restart recovery is not guaranteed and
unfinished ambiguous worker receipts are marked unknown without automatic replay.

## Legacy run adapters

`AgentRun.stop()` means explicit cancellation. It still interrupts a running
turn or removes an accepted queued submission through the shared writer.
The history reader must not perform writer mutations, and its connection is
not closed before an in-flight cancellation acknowledgement.

`AgentRun.detach()` means bridge service exit/restart/reconnect. It stops only
observation. It never interrupts, deletes the queued submission, or kills the
submission client while its acknowledgement is in flight. `ActiveRuns`
marks it detached, not interrupted; stream/executor cleanup must not issue a
fallback stop or publish a false terminal state. System metadata is drained
and the session catalog is flushed before exit. The existing snapshot
synchronizer recovers live output on startup through the worker journal without resubmitting input.

This preserves tasks already accepted by Codex, not unsubmitted in-memory
message batches. It does not survive stopping Desktop/the writer, rebooting
the host, or an independent writer failure. If no official queue writer is
available, submission fails explicitly; there is no stdio execution fallback
in the standard runtime. Deprecated library compatibility flags can still
select non-durable stdio/exec, and non-Codex adapters retain their previous
shutdown behaviour. Under `AGENTS.md`, user-requested bridge deployments and
restarts run directly without active-task checks or extra confirmation; only
the bridge services restart, and service health is verified afterward.

Verification includes process fixtures for accepted first/follow-up tasks,
non-cancelling detach, explicit cancellation, and executor cleanup. An opt-in
test uses an installed CLI with an isolated offline provider (no model call)
to verify idle history can be read by a new process after the creator exits:
set `CODEX_IDLE_TEST_BINARY` and run
`pnpm test tests/process/codex-idle-materialization.test.ts`.

## Archived Feishu groups stay closed

A true Codex archive (from Feishu, Desktop, or another client) is distinct
from retiring a bridge binding during workspace changes or AA version upgrades.
The synchronizer checks the public `thread/list` archive filter, exhausting
pagination, before reply/name synchronization. Ordinary group input performs
a fresh check before submission; a failed lookup rejects input with a retry
notice instead of starting a new thread.

An app-server rejection of one stored thread (for example, invalid paginated
history lineage after history maintenance) is confined to that RPC request.
The reusable reader stays connected so concurrent archive checks and healthy
thread reads can finish. Only transport failures/timeouts reset the owned
reader connection. This does not repair the rejected history or bypass the
fresh archive check.

Archive tombstones live in `<session-catalog-path>.archives.json`, beside the
existing catalog. They survive history GC and bridge restarts. Keep this file
when backing up or migrating a profile. A malformed archive ledger prevents
startup rather than silently reopening groups. Existing archived bindings are
reconciled against Codex's archived list on first observation.

After archival, the retained group only replies that the conversation is
archived. It does not submit tasks, reopen the conversation, or recreate its
AA group. Stale creation cards cannot create a group for a known archived
thread. Only an explicit resume selection of another unarchived thread clears
the group's tombstone; late system events from the old task are ignored.

Archive confirmation offers two red buttons in Feishu and Web. **归档** keeps
its group and history; **归档并解散群** archives first, then dissolves the group
and immediately applies the cleanup below. Only the owner or an administrator
can choose dissolution. A native archive failure prevents deletion; a deletion
failure leaves the session archived and retains its group routes. New groups
are created using bot identity without a human `owner_id`, making that bot the
owner; existing groups retain their original ownership and permission limits.
AA discovery, automatic group creation and native archive checks run every
15 seconds through the same generic worker scan.

## Dissolved groups lose their live bridge routes

At startup and every minute, the bridge checks up to 50 associated Feishu
groups using `im.v1.chat.get`, rotating batches when there are more groups.
Only explicit `dissolved` / `dissolved_save` statuses or error `232009` confirm
dissolution. Absence from the chat list, invalid IDs, bot removal, missing
permissions, network failures, and unknown/partial responses preserve bindings
and are retried. Groups tagged for another bot are not checked.

Confirmed dissolution closes the group and all its topic scopes, rejects
bridge intake that has not been submitted, removes session/tool/workspace
routes and the explicit allowed-chat entry, and closes the auxiliary entrance
if present. It does not archive native conversations, interrupt accepted
tasks, delete native history or project files, or close other linked groups.
Shared canonical tool entries needed by other entrances are retained.

The catalog retains archived relationship records. Dissolved-chat markers and
automatic-group suppression are written to `<session-catalog-path>.archives.json`
before route cleanup; they survive GC and restart, and incomplete cleanup is
retried. A manually dissolved personal AA group is not automatically replaced.
The native conversation can still be explicitly attached to a new group.
An owned binding missing from a partial chat list is held until this check,
rather than creating a replacement group immediately.


## Current bindings and historical revisions

The session catalog uses schema version 2: `current` is an object keyed by routing
scope (a group or topic ID), and `history` is an array of retired revisions.
Replacing a binding atomically replaces that scope's current entry and moves the
previous revision into history. Workspace and policy fingerprints identify
revisions; they cannot create additional current routes. Historical records are
never used to deliver messages or synchronize names. Native archival tombstones
remain separate from retired relationship history.

Personal workgroups retain one-to-one native-session ownership through the tool
binding store's reverse index and shared creation lease. Shared groups are
additional routes to the same conversation, with one current entry per scope.
History GC keeps current routes even when the configured record limit is smaller
than the number of live scopes.

Legacy array catalogs migrate on load, retaining the latest established binding
per scope and retiring earlier policy revisions. The original file is saved as
`<catalog-path>.v1-backup`. Conflicting active tools within one legacy scope fail
closed for manual reconciliation. Do not run an older bridge against schema 2;
restore the catalog and archive ledger backups together when rolling back.

For offline association cleanup, stop only the bridge writer and run the bundled
`tools/migrate-session-catalog.ts` maintenance entry point with the profile path
and optional group IDs. It backs up local state, removes selected group routes
and name baselines, rejects unsubmitted inbox entries, and saves durable
suppression markers. It does not archive native conversations or dissolve groups.
