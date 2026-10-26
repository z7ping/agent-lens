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

Available: native sessions and deep links, native windows, authorized body search,
attachments, archived Hook pages, native statistics/rebuild, aggregate Usage/Insights,
Facets, health and readiness. Other /api/v1/ routes explicitly return 501 instead
of fake empty data or a Legacy fallback.

**Cutover not authorized:** default `start` still runs the old Daemon;
Slim standalone does not yet expose Live/Backup/Task Center, automatically start
Source capture, or replace the active installed DB. Do not serve the full desktop
experience from this partial surface and do not delete any old DB. #617 remains open.
