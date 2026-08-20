<h1 align="center">AgentLens</h1>

<p align="center"><strong>Local observability and trajectory replay for AI coding agents.</strong></p>

<p align="center">
  <a href="README.md"><strong>English</strong></a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

> **1.0 alpha:** AgentLens 1.0 is a clean rebuild around Canonical Observation + Evidence. The 0.x runtime is reference material only and is not part of the 1.0 execution path.

## What AgentLens does

AgentLens observes what local AI coding agents expose and turns those native records into one evidence-backed model.

It answers:

- what happened during a task/session;
- which native source proves it happened;
- how history and runtime observations reconcile;
- which tools were called and which calls failed;
- which Skills/MCP assets were actually attributable to observed usage.

AgentLens does **not** execute the agent and does not claim access to hidden chain-of-thought.

## 1.0 source support

| Source | History | Runtime | Assets |
| --- | --- | --- | --- |
| Codex | Native session JSONL | Runtime Hooks + durable inbox | Skills, MCP, Plugins, Hooks, Rules |
| Claude Code | Project/session JSONL | Runtime Hooks + durable inbox | Skills, MCP, Plugins, Hooks, Commands |
| Pi | Native Session JSONL | Continuous native JSONL tail | Skills, Extensions, MCP, Memory-related assets |

0.x integrations such as Hermes, OpenCode, Cursor, and OpenClaw are **not** automatically considered 1.0 support. They must return through the 1.0 Source Contract.

## Quick start

Requires Node.js **22.23+**.

### npm

```bash
npm install -g @z7ping/agent-lens

agent-lens doctor
agent-lens hook install all
agent-lens start
```

Open:

```text
http://127.0.0.1:56789/
```

`agent-lens start` intentionally runs the daemon in the foreground. Background lifecycle on Windows is owned by the desktop application rather than a second cross-platform service manager.

### Source checkout

```bash
npm install
npm run typecheck
npm test
npm run build:web
npm run dev
```

For the CLI from a checkout:

```bash
npm run cli -- doctor
npm run cli -- hook install all
npm run cli -- start
```

## Windows desktop

The Windows release workflow builds an x64 NSIS installer:

```text
AgentLens-<version>-Setup-x64.exe
```

The Electron application is only a desktop shell. It owns:

- single-instance behavior;
- BrowserWindow;
- system tray;
- daemon start/stop/restart;
- log/data-folder access.

The daemon and HTTP/SSE architecture remain the same as the CLI/npm distribution.

Uninstalling the desktop application does not automatically delete `~/.agent-lens/1.0` observation data.

## UI

The current 1.0 Web shell is localized in Simplified Chinese and exposes three projections:

### 执行轨迹 (Timeline)

Canonical observations ordered by effective event time, including Evidence records, capture method, derivation, confidence, and source locator. Raw payload and Evidence details are collapsed by default.

### 会话 (Sessions / Interactions)

Logical sessions derived from canonical observations. User messages define user-triggered Interaction boundaries; observable autonomous activity can form background interactions. Sessions can jump directly to the matching execution trajectory.

### 工具与能力 (Tools & Assets)

Tool calls/results, success/failure counts, duration, source/product attribution, and defensible Skill/MCP usage attribution.

The UI receives live updates through Server-Sent Events. Timeline updates use incremental DOM reconciliation so new observations do not destroy scroll position or expanded Evidence state. Sessions and Tools & Assets show a new-data indicator when a safe incremental update is not available. Idempotent `unchanged` commits do not trigger refresh noise.

## CLI

```text
agent-lens start
agent-lens status [--json]
agent-lens doctor [--json]
agent-lens hook status [codex|claude|all] [--json]
agent-lens hook install [codex|claude|all]
agent-lens hook uninstall [codex|claude|all]
```

Hook installation is idempotent. AgentLens removes/replaces only its own handlers and preserves third-party handlers in the same configuration.

## Architecture in one picture

```text
Native source
  -> SourceRecord
  -> SourceDefinition.normalize()
  -> ObservationCandidate + EvidenceCandidate
  -> IdentityService
  -> ObservationService.commit()
  -> CanonicalObservation + Evidence
  -> SQLite repositories
  -> Projections
  -> @agent-lens/protocol
  -> HTTP / SSE
  -> Web / Desktop
```

Cordis is the sole plugin runtime and is pinned to `@deepseek-ai/cordis@4.0.1`. AgentLens Core remains framework-independent; runtime extension entrypoints such as Source, Storage, and Surface are Cordis-native plugins. `packages/runtime-cordis` owns shared Context typing, metadata helpers, and compatibility tests rather than wrapping runtime extensions behind a second AgentLens plugin runtime.

See:

- [Architecture](ARCHITECTURE.md)
- [Core Contract](docs/1.0/CORE-CONTRACT.md)
- [ADR-0001: Clean Rebuild and Cordis Runtime Ownership](docs/adr/0001-agentlens-1.0-clean-rebuild-and-cordis-runtime.md)

## Evidence model

A Canonical Observation states what AgentLens believes happened. Evidence states why.

Evidence preserves capture method and derivation, for example:

```text
runtime-hook + observed
native-log  + reported
static-scan + observed
```

If one native tool call is seen by both a runtime Hook and history JSONL, AgentLens should produce one canonical `tool.call` with two Evidence records rather than two facts.

## Assets are not usage

Static discovery can prove that a Skill/MCP/Plugin/Hook is installed or configured. It does not prove it ran.

Asset usage is emitted only when attribution is defensible. Current examples include:

- `mcp__server__tool` -> MCP server usage;
- explicit Claude `Skill` tool input -> Skill usage.

Generic Bash/Read/Write calls are not forced into an Asset category.

## Local data

Default 1.0 data root:

```text
~/.agent-lens/1.0/
├── agent-lens.db
└── inbox/
    ├── codex/
    └── claude/
```

The HTTP server binds to `127.0.0.1` only by design. Default port: `56789`.

Runtime Hook processes sanitize sensitive-key fields before writing durable inbox records. The daemon owns canonical persistence.

## Development

Useful commands:

```bash
npm install
npm run typecheck
npm test
npm run build:dist
npm pack --dry-run
npm run desktop:win        # Windows runner
```

Repository layout:

```text
apps/
  cli/ daemon/ web/ desktop/ hook-codex/ hook-claude/
packages/
  core/ core-services/ runtime-cordis/ protocol/
  storage-sqlite/
  source-codex/ source-claude/ source-pi/
  projection-timeline/ projection-session/ projection-usage/
  surface-http/ hook-manager/
```

## Release model

A GitHub Release triggers:

1. Linux + Windows verification;
2. typecheck/tests/distribution build;
3. exact npm tarball packing;
4. SBOM + SHA-256 checksums;
5. GitHub Release artifact upload;
6. publish of that exact tarball to npm;
7. a separate Windows workflow that builds and attaches the NSIS installer.

The release tag must match `package.json` exactly (`v` prefix is allowed).

## License

MIT
