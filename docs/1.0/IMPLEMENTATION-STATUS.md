# AgentLens 1.0 Alpha 实现状态

更新日期：2026-08-24

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
- `/api/v1/health` 报告运行时管理来源、运行模式、PID 与启动时间；`runtime` 字段保持 1.0 向后兼容，新客户端允许较早 1.0 Daemon 未返回该字段

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

当前顶部采用扁平直达结构：

1. 页面导航：任务复盘 / 工具分析 / 使用洞察 / 智能体概览 / 资产备份；
2. 页面工具栏：Agent 快捷入口 + 页面筛选。

工具分析与使用洞察、智能体概览与资产备份只通过导航顺序、留白和分隔表达关联，不增加“使用分析”或“资产中心”分类层。

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

#### 使用洞察

- 会话 / 交互 / 工具调用 / 明确失败的范围聚合；
- 固定时间窗趋势与等长上周期比较；
- 先展示统计范围、会话样本和是否采样，再展示变化百分比；
- Agent 使用结构、可可靠归因的能力资产采用和跨会话重复工具序列；
- 会话时长明确标为 `endedAt - startedAt` 的跨度，不解释为连续工作时间；
- 采样范围不足以支撑完整上一周期时不生成比较。

#### 资产备份

- 扫描 Source 暴露的原始 Session 与资产路径；
- 按智能体与资产类型选择范围，生成本地不可变快照；
- Manifest 与逐文件 SHA-256 校验；
- 本地备份包导入 / 导出；
- 恢复差异预演；当前不提供直接写回；
- 默认排除凭据、令牌、私钥、符号链接和越界路径。

### Operations

- Codex / Claude Hook Manager
- CLI：setup / start / status / doctor / service / autostart / hook
- `agent-lens setup` 一次性初始化：校验 Node.js、准备 `~/.agent-lens/1.0`、识别 Codex / Claude Code / Pi、只为本机实际存在的 Codex / Claude Code 补齐 AgentLens Hook、报告已有运行时
- Pi 初始化明确不安装 Hook，继续使用原生 History / Runtime Tail
- `setup` 不自动启动长期 Daemon，也不默认开启 npm 登录自启
- `start` 启动前先探测默认 HTTP 地址；已有兼容 Daemon 时直接复用，不重复启动
- npm 后台命令：`service start / stop / restart / status`
- npm 登录自启命令：`autostart enable / disable / status`
- Windows npm 后台使用当前用户 Task Scheduler；后台任务可无登录触发器独立注册，`autostart` 只控制登录触发器
- Linux npm 后台使用 `systemd --user`，服务文件位于 `~/.config/systemd/user/agent-lens.service`
- macOS npm 后台使用 LaunchAgent / `launchd`，定义位于 `~/Library/LaunchAgents/com.agentlens.daemon.plist`
- 系统托管统一进入内部 `service run`，Daemon 报告 `owner=service`、`mode=managed`
- npm 后台生命周期不维护 PID 文件，不恢复 0.x Service Manager
- `service restart` 遇到 Desktop / 前台 CLI 所有的当前运行时不会强行接管
- 本地 `lifecycle.json` 只保存自启偏好，不保存 PID；系统托管配置成功后再写偏好，避免本地状态领先于系统真实状态
- `service start` 会保留已存在的系统自启设置，避免重新注册后台定义时意外关闭登录自启
- npm 与 Windows Desktop 共用默认数据根和默认端口；Desktop 只停止自己拥有的 Daemon
- Windows Desktop 首次正式安装运行时默认启用登录 Windows 后自动运行，可从托盘关闭；登录自启以隐藏窗口进入托盘
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

注意：1.0 已经重新实现“后台常驻 / 登录自启”这一**产品能力**，但实现方式是操作系统原生用户级托管，不代表恢复了上述 0.x service manager / PID 架构。

## 已实现能力：本地 AI 资产备份

资产备份已经按照本地优先、安全优先的边界进入 1.0 实现。它是独立运维资产，不写入 Canonical Observation，也不把 Projection 当作原始备份源。

目标不是简单复制某个 Agent 的整个配置目录，而是基于 AgentLens 已有的资产发现与清单能力，让用户明确知道“有什么重要 AI 资产、哪些会被备份、备份是否完整”，并生成可验证的本地 Backup Snapshot。

### MVP 备份范围

P0：

- Skill
- Rule / Memory，例如 `CLAUDE.md`、`AGENTS.md`、自定义 Rules / Memory
- Session / History 原始数据
- MCP 配置

P1：

- Plugin / Extension 配置
- Hook 配置
- Agent Settings / Config / Model 等用户级配置

默认不把缓存、程序本体、`node_modules`、临时文件等运行产物作为备份资产；API Key、Token、Credential 等敏感信息不得默认进入备份。

### 当前产品闭环

第一阶段只要求形成以下闭环：

1. 扫描可备份资产；
2. 展示备份清单、来源与大小；
3. 支持全部备份或选择性备份；
4. 生成本地 Backup Snapshot；
5. 通过 Manifest / Hash 等信息校验备份完整性；
6. 导入 / 导出备份包；
7. 预演恢复差异与阻止项。

当前恢复能力停在预演阶段，不直接覆盖用户现有环境。

### 关键原则

- 复用现有 Source / Asset Inventory 已发现的“资产是什么、在哪里”等事实，不为 Backup 再造一套独立资产扫描体系。
- Session 等动态数据优先备份 Agent 的原始数据，而不是把 AgentLens Projection 结果当作备份源；Canonical Observation / Projection 用于观察与分析，不替代用户的原始 AI 资产。
- Backup Snapshot 应包含独立 Manifest，至少记录 Agent、资产类型、资产名称、原始路径、备份路径、版本、Hash、大小、修改时间、敏感信息状态与 Backup Format Version。
- 备份必须显式区分“发现到了”“选择备份”“备份成功”“校验通过”等状态，避免把资产可见性误认为已经安全保存。
- 第一阶段保持本地优先，不同时引入云同步、Git 同步、WebDAV、NAS、自动跨设备迁移、增量备份、多版本历史等扩展能力。

长期产品链路可以从现有的“观察 / 分析”继续延伸为：发现 AI 资产 → 理解使用情况 → 保存重要资产 → 恢复 / 迁移，但后续能力必须按实际需求逐步实现。

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
- CLI 初始化只修改 AgentLens 自己负责的集成配置，不为未检测到的 Agent 强行安装 Hook。
- npm / Desktop 共存不得产生第二个默认 Daemon、第二套默认数据库或重复采集链路。
- npm 后台托管不得通过 PID 文件成为第二套生命周期事实来源。
- 登录自启状态必须以系统托管定义成功为前提，本地偏好不得领先于系统真实状态。
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

本轮新增自动回归覆盖：

- CLI 运行时所有者字段兼容旧 Health Payload；
- CLI `setup` 只为实际检测到且缺失 / 不完整的 Codex / Claude Hook 选择安装目标；
- Codex trusted 配置缺失时允许 `setup` 幂等修复；
- Windows 用户级计划任务定义生成：后台任务与登录触发器分离；
- Linux `systemd --user` Unit 生成与 `KillMode=control-group`；
- macOS LaunchAgent `RunAtLoad` 与异常恢复定义生成；
- HTTP Health Runtime 元数据；
- Task Review Interaction / Tool Result / Error / Preview；
- Agent Overview Asset Inventory 与 Usage 分离；
- SQLite Asset Inventory Reader；
- HTTP `mountStatic()` 动态 SPA 挂载 / 卸载。

本轮改动已经进入同一套 typecheck / test / distribution build 路径；本文不把尚未最终确认的最新 `main` CI 状态写成“已通过”。

Windows 安装包此前已经完成一次真实流水线验证：

- electron-builder / NSIS 构建成功；
- 实际产出 `AgentLens-1.0.0-alpha.0-Setup-x64.exe`；
- 生成 `SHA256SUMS.txt`；
- GitHub Actions Artifact 上传成功；
- 验收 Artifact：`agent-lens-windows-32427597438`。

## 仍需人工体验 / 发布决策

以下内容不适合仅凭自动验收宣称完成：

- 在真实 Windows 桌面环境中点击安装、启动、登录自启、托盘、退出和卸载；
- 在真实 npm 全局安装环境执行 `agent-lens setup`，确认 Codex / Claude / Pi 检测结果与 Hook 补齐行为符合预期；
- Windows npm：`service start/stop/restart`、`autostart enable/disable`、注销重新登录以及后台 Node 是否出现控制台闪现；
- Linux npm：常见发行版与 WSL 的 `systemd --user` 启动、停止、enable/disable；
- macOS npm：LaunchAgent bootstrap / bootout / kickstart 与登录加载；
- npm 与 Windows Desktop 同时启用登录自启时，确认竞争启动最终仍只有一个默认 Daemon；
- 使用真实 Codex / Claude Code / Pi 本机数据体验任务复盘的信息密度、Interaction 分组、Tool Group 与 Agent 专属事件表达；
- 检查 Agent 概览中真实 Skill / MCP / Plugin / Extension / Hook 的扫描状态是否符合实际安装环境；
- 根据实际体验决定是否继续调整 UI。

本文不代表已经完成 npm Publish 或 GitHub Release；这些操作仍然必须由仓库所有者明确触发。
