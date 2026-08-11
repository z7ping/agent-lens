# Runtime Layout Implementation Plan

> 状态：已由 `docs/superpowers/specs/2026-08-10-runtime-layout-design.md` 中的分层安装布局取代。当前实现保留 `~/.agent-lens` 统一根目录，但程序位于 `app/`、Windows 命令入口位于 `bin/`，运行数据位于根目录的 `data/`、`logs/`、`state/`、`run/`，并包含历史布局迁移。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the installed application and all runtime files under `~/.agent-lens/` while separating `app/`, `bin/`, and runtime data.

**Architecture:** Add `server/runtime-paths.js` as the single source of truth for runtime paths. Update CLI install/start/stop, HTTP server, adapters, hooks, importers, scripts, and docs to consume these paths.

**Tech Stack:** Node.js CommonJS, PowerShell verification commands, Node test runner.

---

### Task 1: Path Contract

**Files:**
- Create: `server/runtime-paths.js`
- Create: `test/runtime-paths.test.js`

- [ ] Write tests that assert source layout uses `<repo>/.agent-lens/{data,logs,state,run}`.
- [ ] Write tests that assert installed layout uses `~/.agent-lens/app` for program files, `bin/` for Windows commands, and `~/.agent-lens/{data,logs,state,run}` for runtime data.
- [ ] Implement `getRuntimePaths()` with injectable `homeDir` and `projectDir`.

### Task 2: Runtime Consumers

**Files:**
- Modify: `server/agent-lens-db.js`
- Modify: `server/adapters/base.js`
- Modify: `server/adapters/claude-code.js`
- Modify: `server/adapters/hermes.js`
- Modify: `server/importers/base.js`
- Modify: `server/importers/claude-code.js`
- Modify: `server/importers/codex.js`
- Modify: `server/routes.js`
- Modify: `server/server.js`
- Modify: `server/hooks/prelog.js`
- Modify: `server/hooks/log.js`
- Modify: `server/hooks/server-guard.js`
- Modify: `server/scripts/migrate-jsonl.js`
- Modify: `server/scripts/verify-integrity.js`

- [ ] Replace direct project-root runtime paths with `runtime-paths`.
- [ ] Ensure all parent directories are created before writing files.
- [ ] Keep API routes `/projects.json`, `/logs/*`, and `/states/*` working by serving from the new runtime paths.

### Task 3: Install Layout

**Files:**
- Modify: `server/cli.js`
- Modify: `server/install-hooks.js`
- Modify: `server/sources-status.js`

- [ ] Stage and install app files into `~/.agent-lens/app/`.
- [ ] Install runtime data into `data/`, `logs/`, `state/`, and `run/`.
- [ ] Create Windows command shims from `~/.agent-lens/bin/`.
- [ ] Point hook commands at `~/.agent-lens/app/hooks/*.js`.
- [ ] Use `run/server.pid` for start/stop/status.

### Task 4: Docs And Verification

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CHANGELOG.md`
- Modify: `test/package-files.test.js`
- Modify: `test/cli-package.test.js`

- [ ] Document the development and installed runtime layouts.
- [ ] Ensure package tests exclude `.agent-lens/` runtime data.
- [ ] Run `npm test`, `npm run build`, and `npm pack --dry-run --json`.
