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
continue to use Codex's Source-owned thread. Old SQL logical-session Resume
is not advertised until the native Catalog resolver is verified; there is no
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
