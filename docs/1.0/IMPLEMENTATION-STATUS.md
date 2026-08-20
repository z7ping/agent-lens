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
- Vite Web：执行轨迹 / 会话 / 工具与能力
- Web 主界面已完成简体中文化
- 执行轨迹 SSE 使用增量 DOM 更新，保留滚动位置、Evidence 展开状态和阅读上下文
- 会话 / 工具与能力在不能安全增量更新时只提示有新数据，由用户显式刷新

### Operations

- Codex / Claude Hook Manager
- CLI：start / status / doctor / hook
- npm 单包分发构建
- 构建后 Daemon / Web 发行包启动冒烟测试
- GitHub Release -> npm Artifact Workflow
- Windows Electron 桌面壳 + 中文托盘 + NSIS 安装包 Workflow
- Windows 桌面图标已更新为符合 electron-builder 要求的 256×256 AgentLens 图标

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

## 自动验收状态

当前 1.0 自动验收基线使用 Node.js `>=22.23.0`。

已在 Linux / Windows GitHub Actions 上实际通过：

1. `npm run typecheck`
2. `npm test`
3. `npm run build:dist`
4. 构建后 Daemon / 中文 Web 启动冒烟测试
5. `npm pack --dry-run` / npm 包内容检查
6. Cordis compatibility tests
7. Codex / Claude Code / Pi Source tests
8. Canonical Observation + 多 Evidence 去重验收

Windows 安装包也已经完成一次真实流水线验证：

- electron-builder / NSIS 构建成功；
- 实际产出 `AgentLens-1.0.0-alpha.0-Setup-x64.exe`；
- 生成 `SHA256SUMS.txt`；
- GitHub Actions Artifact 上传成功；
- 验收 Artifact：`agent-lens-windows-32427597438`。

## 仍需人工体验 / 发布决策

以下内容不适合仅凭 CI 宣称完成：

- 在真实 Windows 桌面环境中点击安装、启动、托盘、退出和卸载；
- 使用真实 Codex / Claude Code / Pi 本机数据观察中文 Web 的信息密度、交互和轨迹可读性；
- 根据实际体验决定是否继续调整 UI。

本文不代表已经完成 Merge、npm Publish 或 GitHub Release；这些操作仍然必须由仓库所有者明确触发。
