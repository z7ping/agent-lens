# AgentLens 1.0 Alpha 实现状态

更新日期：2026-08-20

## 已实现

### Core / Runtime

- 全新的 1.0 Core Domain 与 Contract
- Cordis Runtime Adapter（`@deepseek-ai/cordis@4.0.1`）
- 与框架无关的 Core Services
- 全新的 SQLite 1.0 Repository 与 Checkpoint
- Canonical Observation + Evidence Commit Pipeline

### Sources

- Codex：History、Runtime Hook Durable Inbox、Assets
- Claude Code：History、Runtime Hook Durable Inbox、Assets
- Pi：History、原生 Runtime Tail、Assets

### Projections / Protocol

- `TimelineProjection`
- Session / Interaction Projection
- Tool / Asset Usage Projection
- 带版本的 `@agent-lens/protocol` DTO

### Surfaces

- `/api/v1/health`
- `/api/v1/timeline`
- `/api/v1/sessions`
- `/api/v1/usage`
- `/api/v1/events` SSE
- Vite Web：Timeline / Sessions / Tools & Assets

### Operations

- Codex / Claude Hook Manager
- CLI：start / status / doctor / hook
- npm 单包分发构建
- GitHub Release -> npm Artifact Workflow
- Windows Electron 桌面壳 + 托盘 + NSIS 安装包 Workflow

## 明确没有从 0.x 直接带入的能力

以下内容在按照新 Contract 重新实现之前，不属于 1.0 基线：

- Hermes Runtime Source
- OpenCode Runtime Source
- Cursor Runtime Source
- OpenClaw Runtime Source
- 0.x Adapter / Importer Runtime
- 0.x timeline / overview 规范表
- 0.x service manager / PID 架构
- 旧 HTTP API Compatibility Layer

## 关键验收不变量

- 同一个原生事件分别被 History 与 Runtime 观察到时，仍然只产生一条 Canonical Observation，并保留多份 Evidence。
- 通用 Source Runner 不包含任何按 Source 区分的业务分支。
- Core 与 Cordis 解耦。
- Web 与 Core / Storage / Source 解耦，只消费 Protocol DTO。
- 静态 Asset Discovery 不计为 Usage。
- Hook install / uninstall 必须保留第三方 Handler。
- 幂等的 `unchanged` Replay 不触发 SSE 更新噪声。

## Release 验证

分支 CI 会在 Linux 与 Windows 上执行 Typecheck、Test、Distribution Build 与 npm pack 检查。

Release Workflow 会在发布前重复验证，并发布实际打包出的同一份 tarball。Windows Installer 在独立的 `windows-latest` Job 中构建，并把 NSIS Artifact 附加到 GitHub Release。

本文不代表已经完成 Merge、npm Publish 或 GitHub Release；这些操作仍然必须由仓库所有者明确触发。
