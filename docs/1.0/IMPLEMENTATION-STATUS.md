# AgentLens 1.0 Alpha Implementation Status

Updated: 2026-08-20

## Implemented

### Core / Runtime

- Clean 1.0 Core Domain and contracts
- Cordis runtime adapter (`@deepseek-ai/cordis@4.0.1`)
- framework-independent Core Services
- fresh SQLite 1.0 repositories and checkpoints
- canonical Observation + Evidence commit pipeline

### Sources

- Codex: history, runtime Hook durable inbox, assets
- Claude Code: history, runtime Hook durable inbox, assets
- Pi: history, native runtime tail, assets

### Projections / Protocol

- TimelineProjection
- Session / Interaction Projection
- Tool / Asset Usage Projection
- versioned `@agent-lens/protocol` DTOs

### Surfaces

- `/api/v1/health`
- `/api/v1/timeline`
- `/api/v1/sessions`
- `/api/v1/usage`
- `/api/v1/events` SSE
- Vite Web: Timeline / Sessions / Tools & Assets

### Operations

- Hook Manager for Codex and Claude
- CLI: start / status / doctor / hook
- npm single-package distribution build
- GitHub Release -> npm artifact workflow
- Windows Electron shell + tray + NSIS installer workflow

## Intentionally not carried forward from 0.x

These are not part of the 1.0 baseline until reimplemented against the new contract:

- Hermes runtime Source
- OpenCode runtime Source
- Cursor runtime Source
- OpenClaw runtime Source
- 0.x Adapter/Importer runtime
- 0.x timeline/overview canonical tables
- 0.x service manager/PID architecture
- old HTTP API compatibility layer

## Key acceptance invariants

- A native event observed by history and runtime remains one Canonical Observation with multiple Evidence records.
- Generic Source runners contain no per-source business branches.
- Core is Cordis-independent.
- Web is Core/Storage/Source-independent and consumes Protocol DTOs only.
- Static Asset discovery is not counted as usage.
- Hook install/uninstall preserves third-party handlers.
- `unchanged` idempotent replay does not trigger SSE update noise.

## Release validation

The branch CI runs Linux and Windows typecheck/tests/distribution build/npm pack checks.

The release workflow repeats verification before publishing the exact packed tarball. Windows installer construction runs separately on `windows-latest` and attaches the NSIS artifact to the GitHub Release.

No merge, npm publication, or GitHub Release is implied by this document; those remain explicit repository-owner actions.
