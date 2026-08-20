# AgentLens 1.0 Alpha 实现状态

更新日期：2026-08-21

## 已实现

### Core / Runtime

- 全新的 1.0 Core Domain 与 Contract
- Cordis Runtime（`@deepseek-ai/cordis@4.0.1`）
- AgentLens 作为 Cordis Application 运行，Source / Storage / Surface 入口采用 Cordis-native Plugin
- Core Domain / Core Services、Repository Contract、Parser / Normalizer 保持与 Cordis 解耦
- 全新的 SQLite 1.0 Repository 与 Checkpoint
- Canonical Observation + Evidence Commit Pipeline

### Sources

- Codex：History、Runtime Hook Durable Inbox、Assets
- Claude Code：History、Runtime Hook Durable Inbox、Assets
- Pi：History、原生 Runtime Tail、Assets

三个 Source package 都保留独立 `SourceDefinition`，同时由各自 Cordis Plugin 入口注册到 `ctx.sources`；不存在通用 `defineSourcePlugin()` Adapter。

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
- Timeline SSE 增量 DOM 更新；Sessions / Tools & Assets 在有新数据时提示显式 Refresh，避免实时事件打断阅读上下文

### Operations

- Codex / Claude Hook Manager
- CLI：start / status / doctor / hook
- npm 单包分发构建
- GitHub Release -> npm Artifact Workflow
- Windows Electron 桌面壳 + 托盘 + NSIS 安装包 Workflow

## Repository Cleanup

1.0 工作树已移除旧 0.x Runtime / UI / Test：

```text
server/
src/
test/
index.html
vite.config.mjs
docs/superpowers/
docs/static/
```

0.x 历史实现仍可通过 Git 历史 / Tag 查阅，但不再作为 1.0 工作树的一部分，也不得被重新接回 1.0 Runtime。

历史 `CHANGELOG.md` 保留，用于记录已经发生过的 0.x 演进。

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
- Core Domain / Core Services、Repository Contract、Parser / Normalizer 不依赖 Cordis。
- Source / Storage / Surface 的运行时入口直接是 Cordis Plugin，不再经过通用类别 Adapter。
- Cordis Plugin 不得绕过 Canonical Pipeline 直接制造 Source 事实。
- Web 与 Core / Storage / Source 解耦，只消费 Protocol DTO。
- 静态 Asset Discovery 不计为 Usage。
- Hook install / uninstall 必须保留第三方 Handler。
- 幂等的 `unchanged` Replay 不触发 SSE 更新噪声。
- SSE 实时更新不能通过反复全量替换内容区破坏滚动位置、展开状态和阅读上下文。

## 尚待最终验证

当前实现状态不等于已经通过最终 Release Acceptance。合并 / 发布前仍需要在当前 HEAD 确认：

1. `npm run typecheck`
2. `npm test`
3. `npm run build:dist`
4. `npm pack --dry-run` 或 `npm run release:check`
5. Linux / Windows CI 当前 HEAD 全绿
6. Windows NSIS Installer 至少完成一次实际构建验证

本文不代表已经完成 Merge、npm Publish 或 GitHub Release；这些操作仍然必须由仓库所有者明确触发。
