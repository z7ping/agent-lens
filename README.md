<h1 align="center">AgentLens</h1>

<p align="center">
  <strong>AI 智能体透镜</strong>
</p>

<p align="center">
  <em>See every action your AI agents take.</em>
</p>

<p align="center">
  <a href="README.md"><strong>English</strong></a>
  ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@z7ping/agent-lens"><img alt="npm version" src="https://img.shields.io/npm/v/@z7ping/agent-lens?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@z7ping/agent-lens"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@z7ping/agent-lens?logo=npm"></a>
  <a href="https://www.npmjs.com/package/@z7ping/agent-lens"><img alt="Node.js" src="https://img.shields.io/node/v/@z7ping/agent-lens?logo=node.js&logoColor=white"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/npm/l/@z7ping/agent-lens"></a>
  <a href="https://github.com/z7ping/agent-lens/actions/workflows/npm-publish.yml"><img alt="Publish to npm" src="https://github.com/z7ping/agent-lens/actions/workflows/npm-publish.yml/badge.svg"></a>
</p>

<p align="center">
  <a href="https://github.com/z7ping/agent-lens/releases"><img alt="GitHub release" src="https://img.shields.io/github/v/release/z7ping/agent-lens?logo=github"></a>
  <a href="https://github.com/z7ping/agent-lens/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/z7ping/agent-lens?style=social"></a>
  <a href="https://github.com/z7ping/agent-lens/issues"><img alt="Issues" src="https://img.shields.io/github/issues/z7ping/agent-lens"></a>
  <img alt="Platform support" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-2f6f9f">
  <img alt="Local first" src="https://img.shields.io/badge/local--first-yes-0f766e">
  <img alt="Privacy by default" src="https://img.shields.io/badge/privacy-redaction%20by%20default-7c3aed">
</p>

AgentLens is a local observability and replay tool for AI coding agents. It reconstructs the observable actions and execution path of each task, counts Skill, Tool, and MCP calls, and clearly distinguishes runtime capture, static discovery, inference, and information that cannot be observed.

> **In one line:** `npx @z7ping/agent-lens install` → open the dashboard in your browser.

## Install and use

Requires Node.js 18 or later.

### Recommended: install from npm

[@z7ping/agent-lens on npm](https://www.npmjs.com/package/@z7ping/agent-lens)

```bash
npx @z7ping/agent-lens install
```

The installer places the application and production dependencies in `~/.agent-lens/app/`, configures Hooks, command entry points, and the platform background service. The database, logs, and importer state remain under `~/.agent-lens/data|logs|state/`, so application upgrades do not overwrite runtime data. When installation finishes, open **http://localhost:56789/**.

When upgrading an older version, the installer recognizes both the former flat `.agent-lens` layout and older AppData/XDG layouts. It stops the old daemon, migrates missing runtime data, and updates paths. Existing database or state files at the destination are preserved and are never silently overwritten.

### Install directly from GitHub

```bash
npx github:z7ping/agent-lens install
```

> The repository does not track `dist/`. A direct GitHub install must be able to install development dependencies and run the Vite build. Use the npm package when the build environment is uncertain.

You can also install from a cloned repository:

```bash
git clone https://github.com/z7ping/agent-lens.git
cd agent-lens
npm install
npm run build
node server/cli.js install
```

## Interface preview

### Overview: capability assets

Inspect Skills, MCPs, Plugins, Extensions, and built-in capabilities by AI tool, together with observed usage counts.

![AgentLens capability assets overview](https://raw.githubusercontent.com/z7ping/agent-lens/main/docs/static/1.webp)

### Overview: assembly paths

Check whether configuration directories, settings, Hooks, Skills, plugin caches, and session directories are assembled correctly for each tool.

![AgentLens assembly paths overview](https://raw.githubusercontent.com/z7ping/agent-lens/main/docs/static/2.webp)

### Tool stack map

Generate explainable scores from call frequency, workflow value, duration, and failure risk.

![AgentLens tool stack map](https://raw.githubusercontent.com/z7ping/agent-lens/main/docs/static/3.webp)

### Task replay

Filter sessions by source and project. Each user instruction becomes a complete Turn. User and AI messages, thinking signals, lifecycle events, and tool calls appear in one chronological execution flow. Consecutive tool calls are collapsed by default, while errors remain prominent.

![AgentLens task replay](https://raw.githubusercontent.com/z7ping/agent-lens/main/docs/static/4.webp)

### Common commands

After installation, manage the service with `agent-lens`:

```bash
agent-lens status          # Show runtime status
agent-lens start --daemon  # Start in the background
agent-lens stop            # Stop the service
agent-lens uninstall       # Uninstall and clean up
```

Installation registers a system service or daemon with automatic startup and recovery. For foreground debugging, run `agent-lens start` and press Ctrl+C to stop it.

| Platform | Service mechanism | Configuration path |
|----------|-------------------|--------------------|
| Linux | systemd user service | `~/.config/systemd/user/agent-lens.service` |
| macOS | launchd agent | `~/Library/LaunchAgents/com.agent-lens.plist` |
| Windows | Current-user Startup folder + daemon/Hook recovery | `~/.agent-lens/` (no administrator rights required) |

> **Linux:** `sudo loginctl enable-linger <user>` is required to keep the service running while the user is logged out. The installer detects this condition and displays guidance.
>
> **Windows:** installation writes `AgentLens.vbs` to the current user's Startup folder for hidden startup without administrator rights. Installation, service management, Hook recovery, and overview version detection use hidden child processes. Real-time Hooks run Node scripts through the GUI-subsystem `~/.agent-lens/bin/agent-lens-hook.exe` launcher, preventing a console window from flashing for every event while remaining compatible with PowerShell and `cmd.exe`. Restart any running AI coding tools after an upgrade so they pick up the new Hook command and PATH. Hook-based recovery remains a fallback when the service exits unexpectedly.

## Features

- **Multi-agent tracing** — Count Skill, Tool, and MCP calls and reconstruct evidence-backed observable call chains.
- **Unified task flow** — Arrange conversation bubbles, thinking signals, lifecycle events, and tool calls on one Turn-based timeline.
- **Codex lifecycle lens** — Observe sessions, prompt submission, permission requests, context compaction, subagents, and Turn stop events in real time.
- **Native Pi session lens** — Rebuild branches, derived sessions, model/thinking-level changes, compaction, and parallel tool pairing from tree-structured Session JSONL.
- **Analytics dashboard** — Total calls, error rate, tool ranking, and slow calls.
- **Overview** — One card per AI tool with version, configuration directory, official links, capability assets, installation paths, and assembly diagnostics.
- **Multiple data sources** — Hermes/OpenCode SQLite polling, Claude Code/Codex real-time Hooks and history imports, Pi tree JSONL incremental imports, and Cursor real-time Hooks.
- **Observable Timeline** — Stable event identity, source-isolated Sessions, separate Tool Use/Result events, evidence metadata, and automatic error classification.
- **Local security** — Listen on `127.0.0.1` by default, restrict browser origins, and apply configurable redaction before persistence.
- **Live refresh** — Incremental updates every three seconds.
- **Dark theme** — One-click light/dark switching.

## Data source configuration

| Source | Method | Configuration |
|--------|--------|---------------|
| **Hermes** | Poll `~/.hermes/state.db` | None; works on startup |
| **Claude Code** | Real-time Hooks + `~/.claude/projects` history import | See below |
| **Codex** | 11 real-time Hook types + `~/.codex/sessions` history import | Configured by the installer; rerun `install` after upgrading |
| **Cursor** | Real-time Hooks | Same as Claude Code |
| **Pi** | Incremental Pi tree Session JSONL import + optional runtime extension | History import works without setup; runtime capture uses `agent-lens pi-extension install` |
| **OpenCode** | Poll `~/.local/share/opencode/opencode.db` | None |

### Overview asset scanning

The Overview page displays stable capability assets for each AI tool: tool version, configuration directories, Skills, MCPs, Plugins, Extensions, Hooks, Adapters, and capabilities found through built-in definitions or historical calls.

Asset cards show installation or configuration paths and provide a copy-path action. The Assembly Paths view checks whether important configuration directories, files, Hooks, Skills, plugin caches, session directories, and state databases exist. It also shows installed, discoverable, and used Skill counts plus local/plugin source distribution. Tool cards link to available official websites, GitHub repositories, and documentation.

Source tabs default to Pi, Codex, Claude Code CLI, OpenCode, Hermes, OpenClaw, and Cursor. You can drag them into another order; the browser stores the order locally and applies it to overview cards and high-frequency asset comparison columns. The project picker shows each project's sources and session count, and filters itself when you select a source tab.

Overview data uses a database snapshot followed by background refresh:

1. `/api/overview` first returns the latest asset snapshot from `agent-lens.db` in the runtime data directory.
2. Each request to `/api/overview` triggers a background scan and database update.
3. After the core HTTP service is ready, periodic scans keep configuration changes from going stale. History imports and asset scans are not part of the installer's core readiness check.
4. Call counts, frequently used assets, and cross-tool coverage continue to be aggregated from `timeline`; call facts are not stored twice.

Configure the scan interval in milliseconds with:

```bash
AGENT_LENS_OVERVIEW_SCAN_INTERVAL_MS=600000 node server/cli.js start
```

The default is `600000` (10 minutes). Set it to `0` to disable periodic server scans; opening the Overview page still triggers a background refresh.

### Security and sensitive-data capture

AgentLens v0.4 and later listen only on `127.0.0.1` by default. The API rejects non-loopback Hosts, remote connections, and unapproved browser Origins. `/api/hook` also requires an installation-specific local token:

```text
X-AgentLens-Token: <token from run/hook-token in the runtime directory>
```

The token file is only for local integrations. Do not commit it, copy it into logs, or share it publicly. Remote and LAN access are not currently supported.

Prompt, tool, configuration, and environment capture have separate switches. Each accepts `off`, `redacted`, or `full`:

```bash
AGENT_LENS_PROMPT_CAPTURE=redacted
AGENT_LENS_TOOL_CAPTURE=redacted
AGENT_LENS_CONFIG_CAPTURE=redacted
AGENT_LENS_ENV_CAPTURE=off
AGENT_LENS_ENV_ALLOWLIST=SAFE_CUSTOM_NAME,ANOTHER_SAFE_NAME
```

Prompts, tool input/output, and configuration are redacted by default; environment variables are not captured by default. Even when environment capture is enabled, only the built-in safe list and names explicitly listed in `AGENT_LENS_ENV_ALLOWLIST` are read. `full` stores the corresponding original text and should only be used after confirming access controls around the local database and logs. Historical content created before v0.4 is preserved, marked as having an unknown legacy capture policy, and is not silently rewritten during upgrades.

When `AGENT_LENS_CONFIG_CAPTURE=off`, the Overview page does not scan or display configuration paths or static capability assets, and clears cached inventory on the next refresh. Minimal metadata from observed runtime tool events remains available for counts and data-completeness reporting.

#### Codex overview scan rules

The Codex configuration root is `CODEX_HOME`, or `~/.codex` when it is unset. AgentLens scans:

| Path | Type | Description |
|------|------|-------------|
| `~/.codex/skills` | Skill | User-level Skills, recursively recognizing `SKILL.md` |
| `~/.codex/plugins/cache/**/.codex-plugin/plugin.json` | Plugin | Installed plugin manifests and paths |
| `~/.codex/plugins/cache/**/SKILL.md` | Skill | Skills bundled with plugins |
| `~/.codex/plugins` | Plugin | Installed entries in the plugin root |
| `[mcp_servers.*]` in `~/.codex/config.toml` | MCP | Codex MCP configuration |
| `[plugins.*]` in `~/.codex/config.toml` | Plugin | Codex plugin enablement configuration |
| `~/.codex/config.json` | MCP | JSON configuration format |

#### Codex lifecycle and data boundaries

v0.5 installs 11 Codex Hook types: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, and `Stop`. Task replay arranges lifecycle events, conversation bubbles, and tool calls into a Turn-based execution flow while preserving source-provided `turn_id`, `agent_id`, tool call identifiers, model, permission mode, and related fields.

These Hooks only observe. They do not approve or block tools, modify prompts, or add context for the model. `Stop` and `SubagentStop` return neutral empty JSON, and transcript paths are not written to the Timeline. Prompts and final assistant messages follow `AGENT_LENS_PROMPT_CAPTURE`; tool parameters in permission requests follow `AGENT_LENS_TOOL_CAPTURE`.

At Session start, AgentLens statically discovers the current instruction chain using the Codex precedence of `AGENTS.override.md`, `AGENTS.md`, and fallback files. It labels this as a current-environment discovery rather than claiming it entered a historical Turn. `AGENT_LENS_CONFIG_CAPTURE=off` disables this discovery entirely.

Some boundaries remain: hosted tools such as WebSearch do not trigger tool Hooks; some special tool paths may bypass default Hooks; subagent transcripts are not always available; `SessionEnd` may arrive only after closing, archiving, or idling; and AgentLens never reads or infers hidden chain-of-thought. The Overview page and top source status show actual Codex Hook coverage. If an older installation reports fewer than `11/11`, rerun the install command.

#### Pi overview scan rules

The Pi configuration root comes from `PI_CODING_AGENT_DIR`, or `~/.pi/agent` when unset. AgentLens identifies the actual Pi agent root before scanning assets instead of assuming a single machine-specific `~/.pi` layout.

Candidate Pi agent roots include:

- Environment variables: `PI_CODING_AGENT_DIR`, `PI_HOME`, `PI_AGENT_HOME`, `PI_CONFIG_HOME`, `PI_DATA_HOME`
- General defaults: `~/.pi/agent`, `~/.pi`
- Linux: `~/.config/pi`, `~/.local/share/pi`
- Windows: `%APPDATA%\Pi`, `%APPDATA%\pi`, `%LOCALAPPDATA%\Pi`, `%LOCALAPPDATA%\pi`
- macOS: `~/Library/Application Support/Pi`, `~/Library/Application Support/pi`

After finding the agent root, AgentLens scans the following locations. Skill directories recognize root-level `.md` files and recursively find subdirectories containing `SKILL.md`. Extension directories recognize subdirectories and `.js`, `.ts`, `.mjs`, and `.cjs` files.

| Path | Type | Description |
|------|------|-------------|
| `<agentDir>/skills` | Skill | Default Pi user-level Skill directory |
| `~/.agents/skills` | Skill | Shared user-level Pi / Agent Skills |
| `skills` in `<agentDir>/settings.json` | Skill | Explicitly loaded Skill directories |
| `extensions` in `<agentDir>/settings.json` | Extension | Explicitly loaded Extension paths |
| `packages` in `<agentDir>/settings.json` | Plugin / Skill / Extension | Explicitly installed packages, including `npm:<package>` |
| `<agentDir>/npm/package.json` + `<agentDir>/npm/node_modules/<package>` | Plugin | Pi npm dependencies identified by `pi-*`, `*/pi-*`, keywords, or `pkg.pi` |
| `<agentDir>/npm/node_modules/<package>/skills` | Skill | Traditional Skill directory bundled with a Pi plugin |
| `pi.skills` / `skills` in a package manifest | Skill | Skill resources declared by a Pi package |
| `<agentDir>/extensions` | Extension | Pi Extension directory |
| `<agentDir>/npm/node_modules/<package>/extensions` | Extension | Traditional Extension directory bundled with a Pi plugin |
| `pi.extensions` / `extensions` in a package manifest | Extension | Extension resources declared by a Pi package |
| `<agentDir>/pi-hermes-memory/skills` | Skill | Global/process-memory Skills from Pi Hermes Memory |
| `<agentDir>/projects-memory/<project>/skills` | Skill | Project-level memory Skills |

### Configure Claude Code / Codex / Cursor Hooks

`node server/cli.js install` configures Hooks for all supported tools. With the npm release, use `npx @z7ping/agent-lens install`.

Codex v0.5 and later require all 11 Hook types and an updated Codex trust state, so the install command is always recommended. The following is only a manual Claude Code example; its paths point to `~/.agent-lens/app/hooks/`.

On Windows, do not copy the `node` commands below directly. The installer uses `agent-lens-hook.exe` from PATH while preserving Hook standard input, output, and exit codes.

```json
{
  "hooks": {
    "PreToolUse": [{
      "hooks": [{
        "command": "node ~/.agent-lens/app/hooks/prelog.js",
        "type": "command",
        "timeout": 5
      }]
    }],
    "PostToolUse": [{
      "hooks": [{
        "command": "node ~/.agent-lens/app/hooks/log.js",
        "type": "command",
        "timeout": 10
      }]
    }]
  }
}
```

---

## CLI reference

In the source repository, use `node server/cli.js`. After installation, replace it with `agent-lens`; for example, `node server/cli.js status` and `agent-lens status` are equivalent.

### Full command list

```bash
node server/cli.js install                       # Install the app, dependencies, Hooks, and start the service
node server/cli.js start                         # Start in foreground on port 56789
node server/cli.js start --daemon                # Start in background
node server/cli.js start -d                      # Short background option
node server/cli.js start 8080                    # Set port with a positional argument
node server/cli.js start --port 8080             # Set port with an option
node server/cli.js start --port 8080 --open      # Open the browser after starting
node server/cli.js stop                          # Stop the background service
node server/cli.js status                        # Show default service status
node server/cli.js pi-extension status           # Check Pi runtime extension state
node server/cli.js pi-extension install          # Add the AgentLens-managed Pi runtime extension entry
node server/cli.js pi-extension upgrade          # Refresh the managed Pi extension path, version, and hash
node server/cli.js pi-extension uninstall        # Remove only the AgentLens-managed Pi extension entry
node server/cli.js package                       # Build an npm-compatible .tgz
node server/cli.js package --output ./release    # Select the package output directory
node server/cli.js uninstall                     # Remove configuration and runtime data
node server/cli.js help                          # Show help
node server/cli.js --help                        # Show help
node server/cli.js -h                            # Show help
```

Notes:

- `start` runs `npm run build` when it cannot find `dist/`.
- `status` currently checks and displays the default port 56789. For a custom port, visit that address directly; a valid PID still identifies the process.
- `pi-extension` only manages the AgentLens-owned Pi runtime extension entry. It backs up Pi `settings.json` before writing and stops when the JSON is damaged or the `extensions` schema is not an array.
- `uninstall` asks for confirmation, then removes the AgentLens installation, Hook configuration, and all runtime data.

### System service and background daemon

Linux uses a systemd user service and macOS uses a launchd agent. Both support the complete `service` command group:

```bash
agent-lens service install       # Register the service and enable auto-start
agent-lens service start         # Start the service
agent-lens service stop          # Stop the service
agent-lens service status        # Show service, auto-start, version, and runtime details
agent-lens service enable        # Enable auto-start
agent-lens service disable       # Disable auto-start
agent-lens service uninstall     # Stop and remove the service
```

Windows uses the current user's Startup folder and supports the same command group:

```bash
agent-lens service install     # Register and enable login startup
agent-lens service start       # Start now
agent-lens service disable     # Disable login startup
agent-lens service enable      # Re-enable login startup
agent-lens service status      # Show startup, process, version, and runtime details
agent-lens service uninstall   # Remove the startup entry
```

`agent-lens install` registers auto-start and performs the first start. The commands above are primarily for later manual management.

`service status` shows the current command version, the installed on-disk version, and the version returned by the live HTTP service. It reports mismatches and includes the Node.js version, service manager, default address, and installation directory, making it easier to verify which copy is actually running after an upgrade.

---

## FAQ

### The dashboard is blank or only shows backend logs

The `dist/` directory is missing. Source files under `src/` must be processed by Vite.

Fix it by either:

- Running `npm start` or `node server/cli.js start`, which builds automatically.
- Rerunning `node server/cli.js install` when using a system service.

### Port 56789 is already in use

```bash
node server/cli.js start 8080          # Positional port
node server/cli.js start --port 8080   # Equivalent option
```

`status` currently checks the default port 56789. After starting on a custom port, open `http://localhost:8080/` to confirm the service.

---

## Development and contribution

- [Contributing](https://github.com/z7ping/agent-lens/blob/main/CONTRIBUTING.md) — Issues, branches, commits, pull requests, and validation requirements.
- [Architecture](https://github.com/z7ping/agent-lens/blob/main/ARCHITECTURE.md) — Current data sources, storage, data flow, and known limitations.
- [Security policy](https://github.com/z7ping/agent-lens/blob/main/SECURITY.md) — Private vulnerability reporting and sensitive-data guidance.
- [Changelog](CHANGELOG.md) — Released changes.

Public collaboration happens through [GitHub Issues](https://github.com/z7ping/agent-lens/issues), Milestones, Projects, and Pull Requests. The public Gitea repository is only a mirror or backup and does not maintain a separate editable task state.

### Development mode

```bash
npm install               # Install dependencies
npm run dev               # Start backend 56789 and Vite 5173 together
npm run dev:frontend      # Start only Vite 5173; start the backend separately
npm run build             # Build the production frontend into dist/
npm test                  # Run importer and Node.js tests
```

`npm run dev` starts both frontend and backend. Open **http://localhost:5173/** for hot reload; Vite proxies `/api`, `/logs`, `/states`, and `/projects.json` to the backend on port 56789.

### npm scripts

```bash
npm run dev                                  # Backend + Vite development
npm run dev:frontend                         # Vite only
npm run build                                # Build frontend
npm start                                    # Start in foreground
npm start -- --daemon                        # Start in background, forwarding CLI arguments
npm stop                                     # Stop service
npm run status                               # Show status
npm run install-hooks                        # Run the complete install command
npm run package -- --output ./release        # Build a package and forward the output directory
npm test                                     # Run all tests
```

> `install-hooks` is a historical script name. It now runs the complete installation flow, not only Hook configuration.

### Directory structure

```text
agent-lens/
├── server/                    # Backend (plain Node.js, no build step)
│   ├── server.js              # HTTP service on port 56789
│   ├── cli.js                 # CLI entry point
│   ├── routes.js              # API routes
│   ├── agent-lens-db.js       # SQLite storage
│   ├── migrations.js          # Versioned database migrations
│   ├── event-model.js         # Unified event identity and evidence fields
│   ├── privacy.js             # Capture policy and pre-persistence redaction
│   ├── security.js            # Local HTTP boundary and Hook token
│   ├── capabilities.js        # Source data-completeness matrix
│   ├── config.js              # Service configuration
│   ├── schema.sql             # Database schema
│   ├── overview.js            # Asset scanning and database snapshots
│   ├── adapters/              # Tool adapters (Hermes / Claude Code / Cursor / Pi ...)
│   ├── hooks/                 # Real-time Hooks (prelog.js / log.js)
│   └── scripts/               # Utility scripts
├── src/                       # Frontend (Vite + Tailwind)
│   ├── app.js                 # Main logic
│   ├── config.js / utils.js   # Configuration and utilities
│   ├── style.css              # Styles
│   ├── callchain/             # Task replay tab
│   ├── dashboard/             # Tool stack tab (including Chart.js charts)
│   └── overview/              # Capability overview tab
├── dist/                      # Build output (generated by npm run build)
├── index.html                 # Entry page
├── package.json
├── vite.config.mjs
└── tailwind.config.mjs
```

## Data model

### Timeline table (core)

| Field | Description |
|-------|-------------|
| event_id | Stable AgentLens event identifier |
| source / source_event_id | Data source and native source event identifier |
| session_key / session_id | Source-namespaced Session key and native source Session identifier |
| agent_id / turn_id | Source-provided Agent and Turn identifiers, when available |
| parent_event_id | Confirmed parent event identifier |
| timestamp / source_sequence | Display time and stable source ordering |
| event_type / role | `user`, `assistant`, `tool_use`, `tool_result`, `tool_error`, and other event semantics |
| call_id | Links Tool Use with Tool Result |
| tool_name | Tool name |
| capture_method | `runtime_hook`, `native_log`, `local_database`, `static_scan`, `inference`, or `legacy_import` |
| visibility / confidence | Captured, statically discovered, inferred, or unobservable state and confidence |
| missing_reason | Explicit reason when data is incomplete |
| error_type | `windows_command`, `path_not_found`, `permission`, `timeout`, `syntax`, or `unknown` |
| error_detail | Error detail JSON |

### SQLite tables (`agent-lens.db`)

Development runtime data lives under `.agent-lens/` in the project root:

```text
.agent-lens/
├── data/      # agent-lens.db, projects.json
├── logs/      # JSONL call logs and debug logs
├── state/     # Call stacks and importer watermarks
└── run/       # server.pid, hook-token
```

Installed applications use `~/.agent-lens/` on every platform, separating the application, command entry points, and runtime data:

```text
~/.agent-lens/
├── app/                             # Independently updatable app and production dependencies
│   ├── cli.js, server.js
│   ├── dist/                        # Frontend built before release
│   ├── hooks/                       # Hooks
│   ├── adapters/                    # Tool adapters
│   ├── importers/                   # History importers
│   └── node_modules/                # Production dependencies only
├── bin/                             # Windows command entry points
├── data/                            # agent-lens.db, projects.json
├── logs/                            # JSONL and service logs
├── state/                           # Call stacks and importer watermarks
└── run/                             # server.pid, hook-token
```

On Windows this is `C:\Users\<username>\.agent-lens\`. After a successful upgrade from the flat layout, the installer removes obsolete application files and the old root `node_modules` while preserving runtime data. Conflicting data in older platform-specific directories is preserved for manual review.

| Table | Purpose |
|-------|---------|
| schema_meta | Database schema version |
| sessions | Session summaries isolated by `source + session_id` |
| daily_stats | Daily and per-tool aggregates |
| recent_errors | The 50 most recent errors |
| timeline | Unified observable events, lifecycle attributes, tool calls, and evidence metadata |
| overview_tools | Tool identity and runtime environment snapshots |
| overview_assets | Capability asset snapshots |
| overview_scan_runs | Asset scan history, status, and errors |

---

## License

MIT License
