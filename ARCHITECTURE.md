# AgentLens 1.0 Architecture

> Status: 1.0 alpha implementation baseline  
> Updated: 2026-08-20

## 1. Positioning

AgentLens 1.0 is a local observability and trajectory viewer for AI coding agents. It does not try to become a universal agent framework, and it does not own the execution loop of Codex, Claude Code, Pi, or other agents.

Its job is to answer four questions:

1. What happened?
2. Which source/evidence proves it happened?
3. Which task/session/interaction did it belong to?
4. Which tools and capability assets were actually used?

## 2. Clean Rebuild boundary

1.0 is a clean rebuild. The 0.x implementation is reference material only.

0.x may be reused for:

- validated parsing algorithms;
- fixtures and regression cases;
- useful UI ideas;
- migration/import rules.

0.x must not remain in the 1.0 runtime path as a compatibility layer. In particular, 1.0 does not wrap the old Adapter, Importer, timeline table, overview table, server lifecycle, or service manager.

There is no long-lived dual schema, dual runtime, or LegacyTimelineProjection.

## 3. Canonical pipeline

```text
Native Source
  |
  | history / runtime / static scan
  v
SourceRecord
  |
  v
SourceDefinition.normalize()
  |
  +--> ObservationCandidate
  +--> EvidenceCandidate
  +--> IdentityHints
  +--> DedupHints
  |
  v
IdentityService
  |
  v
ObservationService.commit()
  |
  +--> Evidence
  +--> CanonicalObservation
  |
  v
SQLite 1.0 repositories
  |
  +--> TimelineProjection
  +--> SessionProjection
  +--> ToolAssetUsageProjection
  |
  v
@agent-lens/protocol DTOs
  |
  +--> HTTP /api/v1/*
  +--> SSE /api/v1/events
  |
  v
AgentLens Web / Desktop
```

The canonical fact is `CanonicalObservation`. Raw/native records remain `SourceRecord`; they are evidence inputs, not presentation models.

## 4. Runtime architecture

Cordis is the sole plugin runtime.

```text
AgentLensApplication
  |
  +-- storage-sqlite
  +-- core-services
  +-- source-codex
  +-- source-claude
  +-- source-pi
  +-- surface-http
```

Binding decision:

- exact dependency: `@deepseek-ai/cordis@4.0.1`;
- all Cordis coupling is isolated in `packages/runtime-cordis`;
- Core Domain and Core Services do not depend on Cordis;
- AgentLens does not implement a second DI/lifecycle/plugin loader beside Cordis;
- DSH is an architecture/productization reference, not a runtime dependency.

## 5. Package responsibilities

```text
apps/
  daemon/           composition root
  cli/              start/status/doctor/hook commands
  web/              browser UI
  desktop/          Electron Windows shell
  hook-codex/       passive Codex hook process
  hook-claude/      passive Claude Code hook process

packages/
  core/             domain + public contracts
  core-services/    framework-independent service implementations
  runtime-cordis/   Cordis adapter/runtime boundary
  protocol/         external DTO boundary
  storage-sqlite/   fresh 1.0 persistence
  source-codex/     Codex source implementation
  source-claude/    Claude Code source implementation
  source-pi/        Pi source implementation
  projection-timeline/
  projection-session/
  projection-usage/
  surface-http/
  hook-manager/
```

## 6. Source model

Every source implements the same `SourceDefinition` contract:

```text
detect
  -> declareCapabilities
  -> ingestHistory?      
  -> startCapture?       
  -> discoverAssets?     
  -> normalize
```

The runtime runners are generic. They do not contain Codex/Claude/Pi branches.

### 6.1 Codex

- History: `~/.codex/sessions/**/*.jsonl`, byte-offset checkpoints.
- Runtime: Hook subprocess -> durable inbox -> `startCapture()`.
- Assets: Skill, MCP, Plugin, Hook, Rule/AGENTS.
- Stable native call IDs are preferred for history/runtime reconciliation.

### 6.2 Claude Code

- History: Claude project/session JSONL.
- Runtime: Hook subprocess -> durable inbox -> `startCapture()`.
- Assets: Skill, MCP, Plugin, Hook, Command.
- `tool_use_id` is the preferred reconciliation key.

### 6.3 Pi

- History: native Session JSONL.
- Runtime: continuous tailing of the native Session JSONL; no synthetic Hook is required.
- Assets: Skill, Extension, MCP, Memory-related assets discoverable from the Pi configuration root.
- Parent session, model change, compaction, and native tree structure are preserved when observable.

## 7. Runtime Hook rule

Hook processes must remain passive and cheap.

```text
Agent Hook subprocess
  -> sanitize
  -> atomic JSON write to ~/.agent-lens/1.0/inbox/<source>/
  -> exit
```

The daemon owns ingestion. Inbox files are deleted only after the record has successfully passed through the canonical pipeline. A daemon restart therefore does not require the originating agent process to replay the event.

Hook code must not depend on Cordis, SQLite, Core Services, or HTTP.

## 8. Identity model

The 1.0 identity graph separates source identity from product/task identity:

```text
Host
  -> AgentInstallation
     -> LogicalSession
        -> SourceSession
        -> AgentActor
        -> Interaction (derived/presentational boundary)
```

`SourceSession` owns the source-native session ID. `LogicalSession` is the canonical task/session scope used by projections.

Cross-session semantics use explicit relationships (`resume`, `continuation`, `fork`, `subagent`, `import-copy`, `related`) rather than overloading one string session key.

## 9. Observation and Evidence

A `CanonicalObservation` says what AgentLens believes happened.

`Evidence` says why AgentLens believes it.

Evidence records preserve:

- capture method: runtime-hook / native-log / native-db / static-scan / external-import;
- derivation: observed / reported / derived / estimated / inferred;
- source locator;
- source record ID;
- parser version;
- event/capture time;
- confidence;
- missing reason where applicable.

The same semantic event may have several evidence records. Example: one native Tool Call may be observed by a Hook and later reported in JSONL; it stays one Canonical Observation with two Evidence records.

## 10. Deduplication

The canonical identity preference is:

1. native event ID;
2. native call ID;
3. shared event key;
4. source sequence;
5. payload fingerprint + event time;
6. deterministic semantic fallback.

Deduplication is scoped by source, installation, logical session, and observation kind.

History/runtime merging must strengthen evidence; it must not manufacture duplicate facts.

## 11. Storage

1.0 uses a fresh SQLite schema. The old `timeline` and `overview_*` tables are not part of the runtime model.

Current canonical tables include:

- hosts
- agent_products
- agent_installations
- projects
- workspaces
- logical_sessions
- source_sessions
- session_relationships
- agent_actors
- interactions
- source_records
- observations
- evidence
- observation_evidence
- coverage
- capability_declarations
- asset_definitions
- asset_bindings
- asset_state_observations
- tool_definitions
- source_checkpoints

The schema is accessed through Core repository interfaces. Feature code does not reach around repositories with ad-hoc SQL.

## 12. Projections

Projections are derived read models, not second sources of truth.

### TimelineProjection

Produces ordered canonical observations with full Evidence DTOs. Ordering uses effective event time first, not storage insertion order.

### SessionProjection

Groups canonical observations by LogicalSession and derives Interaction boundaries. A user message starts a user-triggered Interaction; pre-user autonomous activity can become a background Interaction. Session lifecycle events alone do not fabricate a turn.

### ToolAssetUsageProjection

Tool usage is derived directly from `tool.call` / `tool.result` observations.

Asset usage is emitted only when attribution is defensible, currently including:

- MCP naming such as `mcp__server__tool`;
- explicit Claude `Skill` input.

Generic Bash/Read/Write calls are not forced into an Asset category.

## 13. Protocol and HTTP surface

`@agent-lens/protocol` is the external boundary. Web code does not import Core, SQLite, or Source packages.

Current HTTP API:

```text
GET /api/v1/health
GET /api/v1/timeline
GET /api/v1/sessions
GET /api/v1/usage
GET /api/v1/events       # SSE
```

The HTTP server is fixed to loopback `127.0.0.1`; default port is `56789`.

API routes have priority over SPA/static fallback.

## 14. Live updates

Core Services publish `observation/committed` through the Cordis event bridge after a canonical observation is created or gains new evidence.

`unchanged` idempotent commits do not broadcast.

HTTP converts this event to SSE. The Web client batches bursts before refreshing projections, so a Hook burst does not cause one full repaint per record.

## 15. Web

The 1.0 Web app is Vite + native TypeScript.

Views:

- Timeline
- Sessions / Interactions
- Tools & Assets

The Web consumes only `/api/v1/*` protocol DTOs.

## 16. Hook management

`packages/hook-manager` owns Codex and Claude Code Hook configuration.

Supported operations:

- status
- install
- uninstall

Rules:

- installation is idempotent;
- only AgentLens handlers are removed/replaced;
- third-party handlers in the same Hook group are preserved;
- Codex trusted hashes are maintained only for AgentLens entries;
- configuration writes are atomic.

## 17. CLI

Current CLI surface:

```text
agent-lens start
agent-lens status [--json]
agent-lens doctor [--json]
agent-lens hook status [codex|claude|all]
agent-lens hook install [codex|claude|all]
agent-lens hook uninstall [codex|claude|all]
```

`start` is foreground by design. The CLI does not pretend to be a cross-platform service manager.

## 18. Distribution

The npm package is `@z7ping/agent-lens`.

The distribution build bundles internal workspaces into:

```text
dist/cli.mjs
dist/daemon.mjs
dist/web/
dist/hooks/
```

Cordis and `better-sqlite3` remain external runtime dependencies.

The release workflow verifies Linux and Windows, packs one exact npm tarball, creates SBOM/checksums, attaches artifacts to the GitHub Release, then publishes that exact tarball.

## 19. Windows desktop

Electron is a shell, not an alternative AgentLens runtime.

Responsibilities:

- single instance;
- BrowserWindow;
- tray lifecycle;
- start/stop/restart daemon;
- local log access;
- NSIS installer packaging.

The daemon still serves the same `127.0.0.1:56789` HTTP/SSE surface. Uninstalling the desktop app does not automatically delete `~/.agent-lens/1.0` observation data.

## 20. Non-goals for 1.0 baseline

The current 1.0 baseline does not claim runtime support for every 0.x adapter. Hermes, OpenCode, Cursor, and OpenClaw remain outside the 1.0 runtime until implemented against the stable Source Contract.

It also does not promise hidden chain-of-thought access or reconstruct information that the source does not expose.

## 21. Architecture acceptance rule

A new Source should normally require only a new Source package plus registration in the composition root.

If a new Source requires changes to Core semantic types, canonical identity, evidence semantics, or Plugin Runtime ownership, that is a Contract Review, not an ordinary adapter task.
