<p align="center">
  <img src="https://raw.githubusercontent.com/z7ping/agent-lens/main/docs/brand/logo/agentlens-logo.svg" width="128" alt="AgentLens Logo" />
</p>

<h1 align="center">AgentLens | The Lens for AI Agents</h1>

<p align="center"><strong>See every observable action taken by your AI coding agents.</strong></p>

<p align="center">A local-first tool for AI coding agent observability, evidence tracing, and task review.</p>

<p align="center">
  <a href="README.md">简体中文</a> ·
  <a href="README.en.md"><strong>English</strong></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@z7ping/agent-lens"><img alt="npm version" src="https://img.shields.io/npm/v/@z7ping/agent-lens?logo=npm&color=cb3837" /></a>
  <img alt="Node.js version" src="https://img.shields.io/node/v/@z7ping/agent-lens?logo=node.js&logoColor=white" />
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/npm/l/@z7ping/agent-lens" /></a>
  <img alt="Local first" src="https://img.shields.io/badge/data-local--first-005DFF" />
  <img alt="Status alpha" src="https://img.shields.io/badge/status-alpha-FF8A1F" />
</p>

> [!IMPORTANT]
> AgentLens 1.0 is currently in alpha. It is a clean rebuild centered on Canonical Observation + Evidence. The 0.x line is retained only as a source of validated behavior and design references; its runtime does not carry into 1.0.

## Why AgentLens

Codex, Claude Code, Pi, Hermes, OpenCode, and similar tools scatter sessions, tool calls, and capability configuration across JSONL, SQLite, Hooks, and local configuration. AgentLens turns those **observable facts** into a consistent, traceable view that helps you answer:

- What did the agent just do, and where did it fail?
- Which turns, tool calls, and lifecycle events made up a long-running task?
- Did a fact come from history, a native tail, or a Runtime Hook?
- Which Skills, MCP servers, and Plugins are installed, and which were actually invoked?
- Which data is complete, partial, unavailable at the source, or unknown?

AgentLens shows only what its Sources can support with evidence. It does not claim access to hidden reasoning or present inference as fact.

## Start in 30 seconds

### Desktop

Visit [GitHub Releases](https://github.com/z7ping/agent-lens/releases) and download the package matching your platform and architecture:

- Windows x64: `AgentLens-<version>-Setup-x64.exe`
- macOS: DMG for Apple Silicon or Intel
- Linux: AppImage or DEB for x64 or arm64

Desktop and npm distributions share the same Runtime, default data root, and data model. Installing both does not create a second database.

### npm / CLI

Node.js 22.23.0 or newer is required:

```bash
npm install -g @z7ping/agent-lens
agent-lens setup
agent-lens service start
```

Open <http://127.0.0.1:56789>.

`setup` performs one-time initialization only. It does not start a long-running Daemon or enable login autostart. Use `agent-lens start` for foreground debugging.

Check the runtime:

```bash
agent-lens status
agent-lens doctor
```

## What you will see

| View | Purpose |
| --- | --- |
| **Task Review** | Reconstruct user messages, agent messages, tool execution, errors, Evidence, and lifecycle events by session and turn. Long sessions retain a turn rail. |
| **Tool Analysis** | Inspect call volume, success and failure, Source distribution, and reliably attributed capability usage. |
| **Usage Insights** | Review usage by time, Source, and activity trend without treating missing data as zero. |
| **Agent Overview** | See local agent detection, capture modes, installation details, asset inventory, and proven usage. |
| **Asset Backup** | Manage local backup and restore boundaries for recognized assets. |

The product UI defaults to Simplified Chinese and keeps agent-specific information such as Evidence, coverage, errors, and Source health visible. Live updates use SSE. Task Review favors incremental coordination so a refresh does not destroy the current reading position.

## Supported Sources

| Source | History | Runtime | Assets |
| --- | --- | --- | --- |
| Codex | Native Session JSONL | Runtime Hook + Durable Inbox | Skills, MCP, Plugins, Hooks, Rules |
| Claude Code | Project / Session JSONL | Runtime Hook + Durable Inbox | Skills, MCP, Plugins, Hooks, Commands |
| Pi | Native Session JSONL | Continuous native JSONL tail | Skills, Extensions, MCP, Memory-related assets |
| Hermes | Native SQLite session history | Native SQLite tail + optional Runtime Hook | Skills, MCP, Plugins, Memory-related assets |
| OpenCode | Native session / runtime data | Incremental native runtime collection | Assets recognized through the 1.0 Source Contract |
| DeepSeek Harness | Profile Session JSONL / JSONL.ZST | Incremental collection by event sequence | Profile Bundles, out-of-tree Plugins, configuration overrides |

Sources expose different facts. AgentLens explicitly distinguishes complete, partial, source-unavailable, and unknown coverage instead of filling gaps with synthetic data.

## Evidence: every fact should be explainable

The AgentLens 1.0 canonical data flow is:

```text
SourceRecord
  -> SourceDefinition.normalize()
  -> ObservationCandidate + EvidenceCandidate
  -> IdentityService
  -> ObservationService.commit()
  -> CanonicalObservation + Evidence
  -> Projection
  -> Protocol DTO
  -> Web / Surface
```

A second capture path for the same fact strengthens Evidence instead of creating a duplicate Observation. Native IDs, event types, sequence numbers, timestamps, and file or table locations are retained whenever the Source can provide them.

## Installed does not mean used

AgentLens separates asset state from proven usage:

```text
installed / configured / enabled / discoverable
                      !=
              evidence-backed usage
```

For example, discovering an MCP configuration proves only that the asset exists. It counts as MCP Usage only after AgentLens observes an attributable `mcp__server__tool` call. A generic Bash, Read, or Write call is not attributed to an installed Skill without explicit Evidence.

## Local-first privacy boundaries

- Default data root: `~/.agent-lens/1.0/`
- Default database: `~/.agent-lens/1.0/agent-lens.db`
- Default HTTP listener: `127.0.0.1:56789`
- Hooks only perform lightweight cleanup, redaction, and atomic Durable Inbox writes
- Canonical persistence belongs to the Daemon; Inbox entries are acknowledged only after successful ingestion
- Prompt, Tool, Config, and Environment use independent capture levels; sensitive fields are redacted before persistence

AgentLens does not silently enable the optional third-party Hermes Plugin, and static discovery is never treated as actual invocation.

## Common commands

```bash
# One-time initialization
agent-lens setup [--json]

# Foreground runtime
agent-lens start

# Status and diagnostics
agent-lens status [--json]
agent-lens doctor [--json]

# System-managed background runtime
agent-lens service start|stop|restart|status [--json]

# Login autostart
agent-lens autostart enable|disable|status [--json]

# AgentLens-owned Native Hooks
agent-lens hook status [codex|claude|all] [--json]
agent-lens hook install [codex|claude|all]
agent-lens hook uninstall [codex|claude|all]
```

Background management maps to the current user's Task Scheduler on Windows, `systemd --user` on Linux, and user-level `launchd` on macOS. AgentLens does not maintain PID files or restore the 0.x Service Manager.

## FAQ

<details>
<summary><strong>Why did collection not start after installation?</strong></summary>

`agent-lens setup` initializes the installation only. For npm, run `agent-lens service start`, or use `agent-lens start` for foreground debugging. Desktop probes for and reuses an existing compatible Daemon when it starts.

</details>

<details>
<summary><strong>Can the npm and Desktop distributions coexist?</strong></summary>

Yes. They share the default data root and endpoint, with only one active Daemon at a time. Desktop stops only a Daemon that it owns and will not terminate an external npm or service-managed runtime.

</details>

<details>
<summary><strong>Why is an asset installed but showing no usage?</strong></summary>

Presence is not usage. AgentLens records usage only when an invocation is supported by explicit Evidence.

</details>

<details>
<summary><strong>Why does a Source show only partial data?</strong></summary>

Tools expose different native facts, and capture policy may further limit coverage. AgentLens reports the real coverage state instead of guessing missing content.

</details>

<details>
<summary><strong>What should I do if the Windows app shows no window after installation?</strong></summary>

Check the system tray first and inspect `<installation directory>\logs\desktop.log`. If the installation directory is not writable, logs fall back to `%APPDATA%\AgentLens\logs`; `AGENT_LENS_LOG_DIR` can explicitly select another location. If npm / CLI is also installed, run `agent-lens status` and `agent-lens doctor` to inspect the Daemon, storage, and managed-service state. If the issue remains, open a [GitHub Issue](https://github.com/z7ping/agent-lens/issues) with the AgentLens version, Windows version, and relevant redacted log lines.

</details>

## Architecture and development

AgentLens 1.0 is a Cordis Application and pins `@deepseek-ai/cordis@4.0.1` as its only Plugin Runtime. Core remains framework-agnostic. Sources, Storage, and Surfaces compose through the Cordis lifecycle but may not bypass the Canonical Data Flow.

Read more:

- [Architecture](ARCHITECTURE.md)
- [1.0 Core Contract](docs/1.0/CORE-CONTRACT.md)
- [Distribution operations](docs/1.0/DISTRIBUTION-OPERATIONS.md)
- [Desktop release matrix](docs/1.0/DESKTOP-RELEASES.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

Local development:

```bash
npm install
npm run check:web-presentation
npm run typecheck
npm test
npm run build:dist
```

## License

[MIT](LICENSE)
