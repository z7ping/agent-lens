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
Facets, the existing `/api/v1/projects/launchable` project picker (with
validated workspace paths), health and readiness. Other /api/v1/ routes explicitly return 501 instead
of fake empty data or a Legacy fallback.

**Cutover not authorized:** default `start` still runs the old Daemon;
Slim standalone does not yet expose Live/Backup/Task Center or replace the active installed DB. Do not serve the full desktop
experience from this partial surface and do not delete any old DB. #617 remains open.

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
