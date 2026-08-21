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
- Asset Inventory 通过 Core 只读 Contract 暴露，Projection 不直接依赖 SQLite 实现

### Sources

- Codex：History、Runtime Hook Durable Inbox、Assets
- Claude Code：History、Runtime Hook Durable Inbox、Assets
- Pi：History、原生 Runtime Tail、Assets

三个 Source package 都保留独立 `SourceDefinition`，同时由各自 Cordis Plugin 入口注册到 `ctx.sources`；不存在通用 `defineSourcePlugin()` Adapter。

Source 检测后会先幂等解析 Installation 并立即发送 `source/detected`，不再等待长时间 History Sync 完成后才让 Web 知道 Agent 已被发现。History / Asset / Runtime Capture 完成后仍会更新最终状态。

### Projections / Protocol

- `TimelineProjection`
- Session / Interaction Projection
- Tool / Asset Usage Projection
- Task Review Projection
- Agent Overview / Facet / Session Relationship Projection
- 带版本的 `@agent-lens/protocol` DTO

### HTTP / SSE Surface

当前公开读接口包括：

- `/api/v1/health`
- `/api/v1/timeline`
- `/api/v1/sessions`
- `/api/v1/usage`
- `/api/v1/review`
- `/api/v1/review/:logicalSessionId`
- `/api/v1/facets`
- `/api/v1/agents`
- `/api/v1/relationships`
- `/api/v1/events` SSE

SSE 当前覆盖 Canonical Observation、Source Detection 和 Asset 变化。幂等 `unchanged` Observation 不产生实时刷新噪声。

### Web Plugin

Web 已从 `apps/web` 提升为独立 `packages/web` 包，并作为 `@agent-lens/web` Cordis Surface Plugin 运行。

- `surface-http` 通过 `ctx.http.mountStatic()` 提供动态 SPA 挂载能力；
- 不加载 Web Plugin 时 HTTP/API 仍可独立运行；
- Web 只消费 `@agent-lens/protocol`，不直接访问 Core / Storage / Source；
- React 19 + Vite + Tailwind CSS；
- 业务状态由 React 外的 `AgentLensClientModel` 管理；
- React 使用 `useSyncExternalStore` 消费稳定 Snapshot；
- SSE 在首屏 Snapshot 请求前建立，消除启动阶段 API → SSE 事件盲区；
- 高频实时事件分区域短窗口合批，不通过整页 DOM 替换制造“自动刷新页面”的体验；
- 页面退出时主动关闭 SSE。

当前顶部采用两级结构：

1. 一级：任务复盘 / 工具分析 / Agent 概览；
2. 二级：Agent 快捷入口 + 页面筛选。

Agent 快捷入口按本机检测结果自动初始化，同时允许用户 Pin 常用 Agent；此配置只影响 UI，不控制 Source 是否加载。

#### 任务复盘

- `Session List | Session Detail` 左右布局
- Session / Interaction 为主要阅读单位
- 用户 / Agent / Thinking 消息
- 连续 Tool Call 分组
- Tool result / error / duration
- Permission / Subagent / Context / Model / Lifecycle 事件穿插展示
- Codex / Claude Code / Pi 专属语义标签
- Pi 原生 parent/session relationship
- Evidence / Raw Payload 临时 Inspector
- Agent / 项目 / 时间 / 错误状态 / 关键字筛选

#### 工具分析

- Tool 调用次数
- 涉及 Session 数
- 成功 / 失败
- 总耗时 / 平均耗时
- Agent / 项目 / 时间筛选
- Skill / MCP 可可靠归因使用统计

0.x 的价值分、风险分、工作流候选等启发式分析暂未直接搬回 1.0；当前优先展示可由 Canonical Observation / Evidence 支撑的事实。

#### Agent 概览

- Agent 检测状态与 Installation 信息
- Capability 声明
- Skill / MCP / Plugin / Extension / Hook 等 Asset Inventory
- Asset Binding path / version / source
- installed / configured / enabled / discoverable 等 Asset State
- Evidence-based Skill / MCP 实际使用记录

静态资产状态与实际调用记录保持明确分离。

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
- 0.x Tool Stack Map 的价值分 / 风险分 / 工作流推荐算法

## 关键验收不变量

- 同一个原生事件分别被 History 与 Runtime 观察到时，仍然只产生一条 Canonical Observation，并保留多份 Evidence。
- 通用 Source Runner 不包含任何按 Source 区分的业务分支。
- Core Domain / Core Services、Repository Contract、Parser / Normalizer 不依赖 Cordis。
- Source / Storage / Surface 的运行时入口直接是 Cordis Plugin，不再经过通用类别 Adapter。
- Cordis Plugin 不得绕过 Canonical Pipeline 直接制造 Source 事实。
- Web 与 Core / Storage / Source 解耦，只消费 Protocol DTO。
- Web 作为独立 Cordis Surface Plugin，可与 HTTP/API Surface 分开装配。
- 静态 Asset Discovery 不计为 Usage。
- Asset Inventory 的“已安装 / 已配置”和 Evidence-backed Usage 的“实际用过”必须分开表达。
- Hook install / uninstall 必须保留第三方 Handler。
- 幂等的 `unchanged` Replay 不触发 SSE 更新噪声。
- SSE 实时更新不能通过反复全量替换内容区破坏滚动位置、展开状态和阅读上下文。
- SSE 必须在首屏 Snapshot 之前建立，避免启动扫描期间出现事件盲区。

## 自动验收状态

当前 1.0 自动验收基线使用 Node.js `>=22.23.0`。

此前完整 1.0 基线已在 Linux / Windows GitHub Actions 上实际通过：

1. `npm run typecheck`
2. `npm test`
3. `npm run build:dist`
4. 构建后 Daemon / Web 启动冒烟测试
5. `npm pack --dry-run` / npm 包内容检查
6. Cordis compatibility tests
7. Codex / Claude Code / Pi Source tests
8. Canonical Observation + 多 Evidence 去重验收

本轮 Web Feature Parity 新增了以下自动回归覆盖：

- Task Review Interaction / Tool Result / Error / Preview；
- Agent Overview Asset Inventory 与 Usage 分离；
- SQLite Asset Inventory Reader；
- HTTP `mountStatic()` 动态 SPA 挂载 / 卸载。

本轮改动已经进入同一套 typecheck / test / distribution build 路径；本文不把尚未最终确认的最新 PR Check 状态写成“已通过”。

Windows 安装包此前已经完成一次真实流水线验证：

- electron-builder / NSIS 构建成功；
- 实际产出 `AgentLens-1.0.0-alpha.0-Setup-x64.exe`；
- 生成 `SHA256SUMS.txt`；
- GitHub Actions Artifact 上传成功；
- 验收 Artifact：`agent-lens-windows-32427597438`。

## 仍需人工体验 / 发布决策

以下内容不适合仅凭自动验收宣称完成：

- 在真实 Windows 桌面环境中点击安装、启动、托盘、退出和卸载；
- 使用真实 Codex / Claude Code / Pi 本机数据体验任务复盘的信息密度、Interaction 分组、Tool Group 与 Agent 专属事件表达；
- 检查 Agent 概览中真实 Skill / MCP / Plugin / Extension / Hook 的扫描状态是否符合实际安装环境；
- 根据实际体验决定是否继续调整 UI。

本文不代表已经完成 Merge、npm Publish 或 GitHub Release；这些操作仍然必须由仓库所有者明确触发。
