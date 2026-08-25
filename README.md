<p align="center">
  <img src="docs/brand/logo/agentlens-logo.svg" width="128" alt="AgentLens Logo" />
</p>

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
- which Skills/MCP assets are installed or configured, and which can be defensibly attributed to actual usage.

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

agent-lens setup
```

`agent-lens setup` performs one-time initialization: it validates Node.js and the data directory, detects local Codex / Claude Code / Pi roots, and installs or repairs only AgentLens-owned Hooks for detected Codex / Claude Code installations. Pi uses native history/runtime tailing and does not receive a Hook.

After setup, choose foreground or managed background operation:

```bash
# Foreground, useful for debugging
agent-lens start

# Managed background runtime
agent-lens service start

# Optional: start automatically after user login
agent-lens autostart enable
```

Check state with:

```bash
agent-lens status
agent-lens service status
agent-lens autostart status
agent-lens doctor
```

`setup` only initializes integration. It does not automatically enable background operation or login autostart. `service` controls whether AgentLens is running in the background now; `autostart` controls whether it starts after the next user login.

The npm distribution maps background lifecycle directly to native user-level operating-system facilities:

- Windows: current-user Task Scheduler;
- Linux: `systemd --user`;
- macOS: user-level `launchd`.

AgentLens does not restore the 0.x PID/service-manager architecture and does not create a second runtime or database for managed mode.

Open:

```text
http://127.0.0.1:56789/
```

`agent-lens start` intentionally runs the daemon in the foreground. It probes the default AgentLens endpoint first and reuses a compatible existing daemon instead of starting a second one. npm and Windows Desktop may coexist while sharing the same default data root and runtime.

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
npm run cli -- setup
npm run cli -- doctor
npm run cli -- start
```

Before testing `service` / `autostart` from a source checkout, build the formal distribution entrypoint so a temporary `tsx` command is never registered with the operating system:

```bash
npm run build:dist
npm run cli -- service status
npm run cli -- autostart status
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
- starting/reusing/stopping only the daemon it owns;
- Windows login autostart;
- log/data-folder access.

On startup Desktop probes `127.0.0.1:56789`: it reuses a compatible daemon already owned by npm/service, and starts its own daemon only when no compatible runtime exists. Exiting Desktop does not kill an externally managed daemon.

The daemon and HTTP/SSE architecture remain the same as the CLI/npm distribution.

Uninstalling the desktop application does not automatically delete `~/.agent-lens/1.0` observation data.

## Web 1.0

The Web UI is itself a Cordis Surface Plugin: `@agent-lens/web`. It mounts the React SPA through `ctx.http.mountStatic()`, so the HTTP/API surface can run without the Web plugin. Web consumes only `@agent-lens/protocol` DTOs and does not directly depend on Core, SQLite, or Source implementations.

Current stack: React 19 + Vite + Tailwind CSS. Product state lives outside React in `AgentLensClientModel`; React subscribes with `useSyncExternalStore`, keeping live event processing independent from component-local state.

The shell uses a two-level top layout: primary product navigation, then Agent shortcuts plus page-specific filters. Agent shortcuts are initialized from detected local agents and can be pinned by the user. Pinning only changes UI visibility; it does not enable or disable Sources.

### Task Review

Task Review uses a `Session List | Session Detail` split layout and treats Session / Interaction as the main reading structure:

- user and Agent messages are rendered conversationally;
- consecutive tool calls are grouped as an execution process with results, errors, and duration;
- permission, subagent, context, model, and lifecycle events remain interleaved in the execution stream;
- Codex, Claude Code, and Pi retain source-specific event semantics where they matter;
- Pi can expose native parent/session relationships;
- Evidence and Raw Payload live in a temporary Inspector instead of dominating the main reading flow.

Filtering is by Agent, project, time range, error state, and search text. Users no longer need to type installationId or logicalSessionId manually.

### Tool Analysis

Tool Analysis derives factual usage metrics from Canonical Observations: call count, affected Sessions, success/failure, total duration, and average duration, with Agent/project/time filters.

The 1.0 baseline favors evidence-backed facts. The old 0.x value scores, risk scores, and workflow candidates are not copied back without a redesigned analyzer contract.

### Agent Overview

Agent Overview exposes:

- detected state and installation metadata;
- Source-declared observation capabilities;
- statically discovered Skills, MCP, Plugins, Extensions, Hooks, and related assets;
- asset binding path/version plus installed/configured/enabled/discoverable state observations;
- Skill/MCP usage that can be defensibly attributed from Evidence.

“Installed/configured” and “actually used” remain separate concepts in both the model and the UI.

### Live updates

Web receives Observation, Source Detection, and Asset changes over SSE. The SSE connection is established before the initial snapshot requests so startup scans do not fall into an API-to-SSE blind window.

`AgentLensClientModel` batches high-frequency updates over short windows for Task Review, usage analytics, and Agent inventory separately. React renders stable snapshots rather than replacing the full page DOM on every event. The client closes the SSE connection when the page exits.

## CLI

```text
agent-lens setup [--json]
agent-lens start
agent-lens status [--json]
agent-lens doctor [--json]
agent-lens service start|stop|restart|status [--json]
agent-lens autostart enable|disable|status [--json]
agent-lens hook status [codex|claude|all] [--json]
agent-lens hook install [codex|claude|all]
agent-lens hook uninstall [codex|claude|all]
```

`setup` is the recommended first-run entrypoint. Hook installation remains idempotent: AgentLens removes/replaces only its own handlers and preserves third-party handlers in the same configuration.

Managed background lifecycle is owned by native user-level OS facilities rather than AgentLens PID files. `service restart` also refuses to seize a runtime currently owned by Windows Desktop or a foreground CLI process.

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
  -> @agent-lens/web / Desktop
```

Cordis is the sole plugin runtime and is pinned to `@deepseek-ai/cordis@4.0.1`. AgentLens Core remains framework-independent; runtime extension entrypoints such as Source, Storage, and Surface are Cordis-native plugins. `packages/runtime-cordis` owns shared Context typing, metadata helpers, and compatibility tests rather than wrapping runtime extensions behind a second AgentLens plugin runtime.

See:

- [Architecture](ARCHITECTURE.md)
- [Core Contract](docs/1.0/CORE-CONTRACT.md)
- [ADR-0001: Clean Rebuild and Cordis Runtime Ownership](docs/adr/0001-agentlens-1.0-clean-rebuild-and-cordis-runtime.md)
- [ADR-0002: Web Plugin and Client State Model](docs/adr/0002-web-plugin-and-client-state-model.md)
- [ADR-0004: Dual distribution, single runtime, and lifecycle ownership](docs/adr/0004-dual-distribution-single-runtime-lifecycle.md)

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
  cli/ daemon/ desktop/ hook-codex/ hook-claude/
packages/
  core/ core-services/ runtime-cordis/ protocol/
  storage-sqlite/
  source-codex/ source-claude/ source-pi/
  projection-timeline/ projection-session/ projection-usage/
  projection-review/ projection-overview/
  surface-http/ web/ hook-manager/
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
