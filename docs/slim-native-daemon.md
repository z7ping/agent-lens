# Slim Native Daemon (P0 transition)

Explicitly start the native-only HTTP/read plane against an **existing Slim v1**
database. This is not the complete desktop app and does not promote staged data.

```bash
AGENT_LENS_DB_PATH=/absolute/path/to/slim.sqlite npm run start:slim
```

This route initializes only the independent SlimDataRuntime, registered first-party
Source definitions, persisted CapturePolicy and native Reader/HTTP handlers.
It has **no Legacy Writer, v38 migrations, Canonical Observation, SQL transcript
or old SessionSummary projection**. An absent or v38 path fails before serving.

The existing Web build is now served by the same native-only HTTP process,
using `AGENT_LENS_WEB_ROOT` or the Daemon's bundled/web workspace directory;
SPA `/review/native:...` links resolve to the **same existing Review Task Surface**.
No parallel UI is introduced. The rest of the Web app still calls unported
APIs (501), so this is for incremental development, **not production cutover**.

Available: native sessions and deep links, native windows, authorized body search,
attachments, archived Hook pages, native statistics/rebuild, aggregate Usage/Insights,
the existing Pi Live create/send/stream/runtime controls and ephemeral attachment
API, **verified Pi native resume/whole-session fork and bounded fork-at**,
Facets, the existing Local Vault `/api/v1/backups` endpoints, existing source capture-policy
`GET/PUT /api/v1/capture-policy/sources`, `GET /api/v1/locales`, and
`/api/v1/agents/summary` registered-Source navigation and
`/api/v1/projects/launchable` project picker (with
validated workspace paths), health and readiness. **Legacy logical-session IDs remain unavailable**.
Pi native `native:...` Resume/Fork/Fork-at is resolved only through trusted Catalog,
CapturePolicy, the Source Reader's native root/inode checks, and Pi's original
JSONL session ID + absolute working directory. Fork-at additionally requires one
unique original assistant event ID within 128 pages of 32 records; partial
original tails, duplicate anchors, stalled cursors or over-budget sessions
are refused. No old SourceRecord query remains. No
startup audit event is written to an old Observation table. Other /api/v1/
routes explicitly return 501 instead of fake empty data or a Legacy fallback.

**Cutover not authorized:** default `start` still runs the old Daemon;
Slim standalone does not yet expose complete Live history continuation, full Task Center
or replace the active installed DB. Do not serve the full desktop
experience from this partial surface and do not delete any old DB. #617 remains open.

Source current-state asset discovery is attached to the same bounded startup
scope as native session indexing. It reuses `NativeOnlyAssetScanner`
and writes only definition/binding/current-state metadata plus a small scan
checkpoint through Slim worker methods. Assets/Evidence payloads are not
duplicated into event tables; discovery failure is isolated from session Capture.

On explicit Slim startup, the existing registered Source.detect() contracts
first discover local installations and Profiles into minimal Slim identities;
then indexed installations and their Profiles are processed **after HTTP listen**.
Failed detection does not erase previously indexed installations. Each Scope first runs a bounded 128-session
native Catalog scan, then starts Source-owned capture only when authorized.
At most 256 scopes run in one startup; excess scopes are counted as deferred.
Capture always verifies the original Source location. It does not sync old
transcript payloads into SQLite; missing/partial Hook coverage is not promoted
to a complete history claim. Stopping the Slim Daemon aborts scans and disposes
capture handles before terminating storage workers.

### Agent source file browser on Slim

Existing `/api/v1/agents/:sourceId/files|file` GET routes use read-only
Installation identity metadata from Slim, Source enabled-policy checks and the
same source-support root traversal/secret/native-session-file protections.
No arbitrary client path is accepted as a root; these handlers do not write
original files or Legacy events.

### Existing Local Vault on Slim

The same `LocalBackupService` + `ExplainableBackupService` +
`StaleWhileRevalidateBackupService` implementation now runs in Slim mode.
Its persisted state is original Vault files, the inventory manifest and **Slim
checkpoints/Host/Installation identities** only. Restore never writes Canonical
Observation/Evidence. The vault root is `AGENT_LENS_VAULT_PATH` or the normal
local default; it is NOT a Slim session archive recovery/cutover certification.
Snapshot creation/restoration is subject to the existing Vault's source-owned
path checks and verification contracts. Fully integrated per-session archive
and restore still requires M5 end-to-end validation.

### Slim Live ↔ native Review links

Existing `GET /api/v1/live/runtimes` now links a running native session to its
Review entry using the **same** Slim NativeSessionListReader. It only emits a
`historySessionId` when Source authorization, exact native ID, workspace
identity, complete bounded search, and uniqueness across installations all
agree. Ambiguous, disabled, missing, or truncated indexes return no link
rather than guessing a LogicalSession/SourceRecord identity. The result is
metadata-only and does not persist Live bodies.

### Codex Live on Slim

The SAME `CodexLiveAdapter` / App Server transport is registered beside Pi
in the Slim Live Registry, with only runtime recovery hints persisted into
Slim checkpoints. Create, send, stream, interrupt and native turn history
continue to use Codex's Source-owned thread. Native Codex Review `native:...` Resume now uses trusted Catalog, Source Reader
and original JSONL `session_meta` (thread ID and cwd) before App Server
`thread/read` verification. Legacy SQL logical-session ID Resume remains
unavailable; there is no
Legacy event fallback. Missing App Server availability remains an explicit
runtime error, not an invented session.

### Existing Pi Live on Slim

The existing Pi Worker-backed LiveAdapter and DefaultLiveService serve
`/api/v1/live` and `/api/v1/live/attachments` directly in Slim mode, with
Runtime recovery identity stored as Slim checkpoints. Native runtime creation,
streaming, sending, cancellation, queue and attachment upload reuse the same
implementations as the main product. The old SQL LogicalSession/SourceRecord
history selector is never injected. Validated native Pi `resume` and
whole-session `fork` now use Catalog + Reader + original JSONL header instead;
old logical-session resume and `fork-at` remain unavailable. This is an explicit capability gap, not a success or an
empty history result. Live/HTTP integration requires M5 validation before a
production/default Daemon cutover.


Agent navigation summaries contain only registered source manifests, effective
enablement and indexed installation IDs/counts. They make no claim about
unverified runtime capabilities, asset-usage evidence or full Agent details;
those consumers remain under M5 migration.

### Authorized native Live composition

Slim now mounts the existing Pi, Codex and Hermes Live adapters on the **same**
`/api/v1/live` surface, only when the product Source is enabled **and** its
persisted Integration authorization grants `live`. A new/unknown machine does
not gain live process or API-server rights just because the Source was found.
Codex runtime recovery uses Slim checkpoints; historical continuation first
verifies native Catalog/Source profile/file identity, a unique trusted workspace,
then a read-only Codex App Server `thread/read` before obtaining a writer.
Unsupported Codex Desktop rollouts remain read-only in Review.
Hermes continues to use its original API Server settings and adapter; no
separate transcript store is introduced. Changes to Source enablement take
effect on restart (as in the existing configuration service).

### Agent detail and asset inventory in Slim

The existing `/api/v1/agents`, `/api/v1/agents/:sourceId`,
`/api/v1/agents/coverage`, and enrichment endpoints read registered
Source definitions and actual indexed Installation/current Asset states.
The state-only asset rows pass through the same
`projectAgentAssetInventory` mapper used by the original overview.
The Slim response explicitly declares native usage/capability enrichment
unavailable rather than recreating an event-store projection or claiming
unknown counters as zero. Disabled Sources do not expose asset contents.

### Integration settings and permissions in native mode

The existing Integration management, official tool discovery, preferences,
source enablement and explicit Live authorization handlers now run against
their original configuration services. Discovery is asynchronous and never
blocks HTTP readiness. Preferences/permissions remain in their original
configuration files; no legacy Event database is written. New authorization
grants and source enablement take effect after restart; previously running
Live adapters are not silently elevated. Physical Integration package install
and update operations remain separate M5 work and are not misrepresented as
installed when the package runtime is unavailable.

### M3 offline cutover activation (preparatory, currently blocked)

`scripts/slim-cutover-activation.ts` provides separate `activate` and
`rollback` actions. The original v38 database and its backup are never
overwritten or deleted. Promotion uses an exclusive hard link from a closed
Slim staging DB to a new installed DB file, then atomically writes the active
database pointer by same-directory rename. A crash before pointer publication
leaves Legacy active. Rollback changes only the pointer and keeps both files.

**Not yet authorized:** the comprehensive M3 gate still returns
`readyToSwitch:false` because Writer freeze, original Hook/archive coverage
and runtime retirement remain uncertified. The CLI has no bypass flag.
The M4 default Daemon/CLI must consume the pointer before this mechanism can
become the real application's activation path. Rollback requires the new
Daemon to be stopped and does not replay Slim-only writes into v38.

### M3 active pointer consumption

An explicit Slim start can consume the exact M3 activated DB pointer via
`AGENT_LENS_ACTIVE_DB_POINTER=/absolute/path/to/active.json npm run start:slim`.
A corrupt/missing pointer or one rolled back to Legacy fails closed. The
pointer takes precedence over stale `AGENT_LENS_DB_PATH`; the Slim worker
still asserts v1 Schema at startup. This is the same storage helper used by
the activation command; it does not replace the default Daemon/desktop launch
until M4 and does not certify M3 on its own.

### One-time installed migration (M3)

After stopping the old **Desktop and CLI/service Daemon**, use the installed
`agent-lens migrate` command (the same orchestration is available in sources
as `npm run storage:slim:migrate`). This command creates unique, consistent
v38 backup and new Slim staging files, builds the native Catalog and numeric
statistics from the Source-owned originals, verifies Hook archives and old
Session metadata, and only activates Slim if the *final* gate passes while
holding the legacy SQLite writer lock. It never copies SourceRecord,
Observation, Evidence or the transcript itself into the new DB.

If any old-only event, missing/partial transcript, Hook archive, disabled
source, stale numeric snapshot or live Daemon is detected, the command stops
without publishing a pointer. The original v38 file and any backup remain
untouched, while staging is retained for diagnosis. Default CLI and Desktop
then **refuse** to launch the legacy runtime until a verified cutover finishes.

`agent-lens migrate --max-sessions 5000 --max-pages 16384` controls the bounded
single-run verification budget. These are safety ceilings, not override flags.
If there are more sessions than the budget, the audit fails closed. The active
pointer normally lives alongside the user's existing `agent-lens.db` as
`active-database.json`. Native-only default boot consumes it without a second
legacy database copy.
