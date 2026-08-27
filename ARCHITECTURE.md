# AgentLens 1.0 架构

> 状态：1.0 alpha 实现基线  
> 更新日期：2026-08-27

## 1. 产品定位

AgentLens 1.0 是一个面向 AI 编码 Agent 的本地可观测与执行轨迹查看器。它不试图成为通用 Agent 框架，也不接管 Codex、Claude Code、Pi 或其他 Agent 的执行循环。

它主要回答四个问题：

1. 发生了什么？
2. 哪个来源 / 哪份证据证明它发生了？
3. 它属于哪个任务 / 会话 / 交互？
4. 实际使用了哪些 Tool 和能力资产？

## 2. Clean Rebuild 边界

1.0 是一次彻底重建。0.x 实现仅作为参考材料存在。

0.x 可以复用：

- 已验证的解析算法；
- fixture 和回归用例；
- 有价值的 UI 思路；
- 迁移 / 导入规则。

0.x 不得作为兼容层继续存在于 1.0 运行时链路中。特别是，1.0 不会包装或保留旧 Adapter、Importer、timeline 表、overview 表、server 生命周期或 service manager。

不存在长期并存的双 Schema、双 Runtime，也不存在 `LegacyTimelineProjection`。

## 3. Canonical Pipeline

```text
Native Source
  |
  | history / runtime / static scan
  v
SourceRecord
  |
  v
SourceDefinition.normalize()
  |
  +--> ObservationCandidate
  +--> EvidenceCandidate
  +--> IdentityHints
  +--> DedupHints
  |
  v
IdentityService
  |
  v
ObservationService.commit()
  |
  +--> Evidence
  +--> CanonicalObservation
  |
  v
SQLite 1.0 repositories
  |
  +--> TimelineProjection
  +--> SessionProjection
  +--> ReviewProjection
  +--> ToolAssetUsageProjection
  +--> Facet / Agent / Relationship Projection
  |
  v
@agent-lens/protocol DTOs
  |
  +--> HTTP /api/v1/*
  +--> SSE /api/v1/events
  |
  v
AgentLens Web / Desktop
```

系统中的规范事实是 `CanonicalObservation`。原始 / 原生数据记录保留为 `SourceRecord`；它们是证据输入，不是展示模型。

## 4. Runtime 架构

Cordis 是唯一的 Plugin Runtime，AgentLens 1.0 本身是一个 Cordis Application。

```text
AgentLensApplication
  |
  +-- storage-sqlite      # Cordis Plugin
  +-- core-services       # Cordis Runtime Service Provider
  +-- source-codex        # Cordis Plugin
  +-- source-claude       # Cordis Plugin
  +-- source-pi           # Cordis Plugin
  +-- surface-http        # Cordis Plugin
```

绑定决策：

- 精确锁定依赖：`@deepseek-ai/cordis@4.0.1`；
- **Core is framework-agnostic; runtime extensions are Cordis-native**；
- Core Domain、Core Services、Repository Contract、Parser / Normalizer、Protocol DTO 不依赖 Cordis；
- Source / Storage / Surface 等运行时插件入口直接使用 Cordis Context / inject / lifecycle；
- 不在 Cordis 前再维护 `defineSourcePlugin / defineStoragePlugin / defineSurfacePlugin` 这类通用 Adapter；
- `runtime-cordis` 负责 Context Service typing、Application bootstrap、Core Service Provider、Compatibility Test 与少量 metadata compatibility helper，而不是再次抽象一套 Plugin Runtime；
- AgentLens 不在 Cordis 之外再实现第二套 DI / 生命周期 / Plugin Loader；
- DSH 仅作为架构与产品化参考，不是运行时依赖。

这意味着 Cordis 决定“组件如何运行”，而 AgentLens Core Contract 决定“组件可以表达什么事实”。Cordis-native Plugin 不得绕过 Canonical Pipeline 直接制造事实。

## 5. Package 职责

```text
apps/
  daemon/           组合根（composition root）
  cli/              setup/start/status/doctor/service/autostart/hook 命令
  desktop/          Electron Windows 桌面壳
  hook-codex/       被动式 Codex Hook 进程
  hook-claude/      被动式 Claude Code Hook 进程

packages/
  core/             领域模型 + 公共 Contract（Cordis-independent）
  core-services/    与框架无关的 Service 实现
  runtime-cordis/   Cordis Context / Application / Compatibility 边界
  protocol/         对外 DTO 边界
  storage-sqlite/   SQLite Repository + Cordis Storage Plugin 入口
  source-codex/     Codex 纯解析能力 + Cordis Source Plugin 入口
  source-claude/    Claude Code 纯解析能力 + Cordis Source Plugin 入口
  source-pi/        Pi 纯解析能力 + Cordis Source Plugin 入口
  projection-timeline/
  projection-session/
  projection-review/
  projection-usage/
  projection-overview/
  surface-http/     HTTP 能力 + Cordis Surface Plugin 入口
  hook-manager/
  web/              Vite + React 浏览器 UI

scripts/
  windows-hook-runner.ps1   # Windows Hook 无窗口进程包装；不属于 Runtime
```

## 6. Source 模型

所有 Source 都实现同一套 `SourceDefinition` Contract：

```text
detect
  -> declareCapabilities
  -> ingestHistory?
  -> startCapture?
  -> discoverAssets?
  -> normalize
```

Source package 的运行时入口直接是 Cordis Plugin，典型职责只是把自身 `SourceDefinition` 注册进 `ctx.sources`。Parser、Normalizer、History Reader、Asset Scanner 等实现应尽量保持纯 TypeScript / Core Contract，可脱离 Cordis 单独测试。

Runtime Runner 必须保持通用，不得出现 Codex / Claude / Pi 专用分支。

Daemon 启动时只执行一次来源探测并复用探测结果。实时采集优先启动，History Ingestion 与 Asset Discovery 随后并行执行；单个 Source 在探测、历史、资产或实时采集阶段失败时记录该来源错误，但不得阻止其他 Source 与 HTTP Surface 继续运行。

### 6.1 Codex

- History：`~/.codex/sessions/**/*.jsonl`，使用字节偏移 checkpoint。
- Runtime：Hook 子进程 -> durable inbox -> `startCapture()`。
- Assets：Skill、MCP、Plugin、Hook、Rule / AGENTS。
- 历史与运行时对账优先使用稳定的原生 call ID。

### 6.2 Claude Code

- History：Claude project / session JSONL。
- Runtime：Hook 子进程 -> durable inbox -> `startCapture()`。
- Assets：Skill、MCP、Plugin、Hook、Command。
- 优先使用 `tool_use_id` 作为历史 / 运行时对账键。

### 6.3 Pi

- History：原生 Session JSONL。
- Runtime：持续 tail 原生 Session JSONL，不人为增加 Hook。
- Assets：从 Pi 配置根可发现的 Skill、Extension、MCP、Memory 相关资产。
- 在来源可观测的前提下保留 parent session、model change、compaction 以及原生树结构。

## 7. Runtime Hook 规则

Hook 进程必须保持被动、廉价。

```text
Agent Hook subprocess
  -> sanitize
  -> atomic JSON write to ~/.agent-lens/1.0/inbox/<source>/
  -> exit
```

真正的数据摄取由 Daemon 负责。只有记录成功通过 Canonical Pipeline 后，Inbox 文件才会被删除。因此 Daemon 重启后，不要求原始 Agent 再次重放该事件。

Hook 代码不得依赖 Cordis、SQLite、Core Services 或 HTTP。

Windows npm 正式发行可以为 Hook 增加一个无窗口执行包装：

```text
Native Hook
  -> powershell.exe -WindowStyle Hidden
  -> dist/hooks/agent-lens-hook-runner.ps1
  -> ProcessStartInfo(CreateNoWindow=true)
  -> Node Hook
  -> durable inbox
```

该包装只解决 Windows 进程窗口问题：

- 不解析 Hook 业务事件；
- 不访问 Core、SQLite、HTTP 或 Daemon；
- 不负责拉起后台运行时；
- 子进程继承原有 stdin / stdout，保持 Hook 协议的数据路径；
- 包装失败不得阻断上游 Agent Hook 流程。

因此 Windows Hook Runner 不是第二套 Runtime，也不是 0.x Service Manager 的恢复。

## 8. Identity 模型

1.0 的身份图将来源身份与产品 / 任务身份分离：

```text
Host
  -> AgentInstallation
     -> LogicalSession
        -> SourceSession
        -> AgentActor
        -> Interaction (derived/presentational boundary)
```

`SourceSession` 持有来源原生 Session ID。`LogicalSession` 是 Projection 使用的规范任务 / 会话范围。

跨 Session 语义通过显式关系表达（`resume`、`continuation`、`fork`、`subagent`、`import-copy`、`related`），而不是继续把语义塞进某个字符串 session key。

多机 Hub 引入的 `NodeIdentity` 属于 Replication 实例身份，不替代 Canonical `Host`。当前 Host / Installation / Workspace 等本机 Canonical ID 规则在 Hub Alpha 中暂不强制迁移；跨机器唯一性由 Replication Namespace / Replica Key 解决，详见 ADR-0007。

## 9. Observation 与 Evidence

`CanonicalObservation` 表达 AgentLens 认为“发生了什么”。

`Evidence` 表达 AgentLens“为什么认为它发生了”。

Evidence 保留以下信息：

- capture method：runtime-hook / native-log / native-db / static-scan / external-import；
- derivation：observed / reported / derived / estimated / inferred；
- source locator；
- source record ID；
- parser version；
- event / capture time；
- confidence；
- 必要时的 missing reason。

同一个语义事件可以拥有多份 Evidence。例如，一个原生 Tool Call 既被 Hook 实时观察到，后来又出现在 JSONL 中，它仍然只是一条 Canonical Observation，但会拥有两份 Evidence。

## 10. 去重

规范身份的优先级为：

1. native event ID；
2. native call ID；
3. shared event key；
4. source sequence；
5. payload fingerprint + event time；
6. 确定性的语义 fallback。

去重范围由 source、installation、logical session 和 observation kind 共同限定。

History / Runtime 合并的目标是增强 Evidence，而不是制造重复事实。

## 11. Storage

1.0 使用全新的 SQLite Schema。旧 `timeline` 和 `overview_*` 表不属于 1.0 Runtime Model。

当前规范表包括：

- hosts
- agent_products
- agent_installations
- projects
- workspaces
- logical_sessions
- source_sessions
- session_relationships
- agent_actors
- interactions
- source_records
- observations
- evidence
- observation_evidence
- coverage
- capability_declarations
- asset_definitions
- asset_bindings
- asset_state_observations
- tool_definitions
- source_checkpoints

Schema 通过 Core Repository 接口访问。业务功能不得绕过 Repository 直接写临时 SQL。

SQLite Repository 实现本身保持 Cordis-independent；`storage-sqlite` 的插件入口使用 Cordis 生命周期创建、提供并释放 `ctx.storage`。

Storage 可以暴露只读的 Projection 优化 Reader。当前 SQLite 提供会话摘要聚合 Reader，避免任务列表为每个会话重复加载全部 Observation；它不保存第二份事实，结果仍完全由 Canonical 表重建。

## 12. Projections

Projection 是派生读模型，不是第二份事实来源。

当前 Projection 都是按请求从 Canonical Repository 重建的只读计算，不注册到 Cordis Context，也没有伪造的 rebuild 生命周期。Core 中的 `ProjectionService` 仅为未来真正引入可物化、可失效的 Projection Cache 保留；在出现实际缓存前，不作为运行时服务提供。

### TimelineProjection

输出按时间排序的 Canonical Observation，并附带完整 Evidence DTO。排序优先使用有效事件时间，而不是持久化插入顺序。

### SessionProjection

按 LogicalSession 聚合 Canonical Observation，并派生 Interaction 边界。用户消息会开启一个 user-triggered Interaction；首次用户输入之前的自主活动可以归入 background Interaction。单独的 session lifecycle 事件不会凭空制造一次 turn。

### ToolAssetUsageProjection

Tool Usage 直接从 `tool.call` / `tool.result` Observation 派生。

只有归因足够可靠时才生成 Asset Usage，目前包括：

- 类似 `mcp__server__tool` 的 MCP 命名；
- Claude `Skill` Tool 中明确给出的 Skill 参数。

普通 Bash / Read / Write 调用不会被强行归入某种 Asset。

## 13. Protocol 与 HTTP Surface

`@agent-lens/protocol` 是对外边界。Web 不直接 import Core、SQLite 或 Source package。

当前 HTTP API：

```text
GET /api/v1/health
GET /api/v1/facets
GET /api/v1/agents
GET /api/v1/review
GET /api/v1/review/:logicalSessionId
GET /api/v1/relationships
GET /api/v1/timeline
GET /api/v1/sessions
GET /api/v1/usage
GET /api/v1/events       # SSE
```

HTTP Server 固定监听 loopback `127.0.0.1`，默认端口 `56789`。

API 路由优先于 SPA / 静态资源 fallback。

`/api/v1/health` 除 Protocol 与 Storage 状态外，新版 Daemon 还报告运行时管理来源、运行模式、PID 与启动时间。该 `runtime` 字段在 1.0 协议中按向后兼容方式扩展：新版 Daemon 必须返回，新版客户端仍需容忍较早的 1.0 Daemon 未返回该字段。

`surface-http` 的 Server / DTO 处理逻辑保持普通 TypeScript；其插件入口直接作为 Cordis Plugin 订阅 `observation/committed` 并管理 Surface 生命周期。

## 14. 实时更新

当 Canonical Observation 新建或新增 Evidence 后，Core Services 通过 Cordis Event Bridge 发布 `observation/committed`。

幂等的 `unchanged` commit 不广播事件。

HTTP 层把该事件转换为 SSE。Web Client 对 Timeline 使用增量 DOM 协调，不允许每个 SSE 事件触发整页 / 整块内容区重绘；暂未实现安全增量更新的视图只提示存在新数据，由用户显式刷新。

## 15. Web

1.0 Web 使用 Vite + React + TypeScript。

当前视图：

- 任务复盘；
- 工具分析；
- 使用洞察；
- 智能体概览；
- 资产备份。

顶部以五个页面直达入口呈现，只通过顺序、留白和分隔表达“任务 / 使用 / 资产”的关联，不增加分类层或产品内二级导航。任务复盘左侧始终是实际会话列表，不把来源或状态场景伪装成导航。

Web 仅消费 `/api/v1/*` 的 Protocol DTO。

## 16. Hook 管理

`packages/hook-manager` 负责 Codex 与 Claude Code 的 Hook 配置。

支持操作：

- status
- install
- uninstall

规则：

- 安装必须幂等；
- 只移除 / 替换 AgentLens 自己的 handler；
- 同一 Hook group 中的第三方 handler 必须保留；
- Codex trusted hash 只维护 AgentLens 自己的条目；
- 配置写入必须原子化。

Hook 配置属于 AgentLens，而不是某一种发行方式。npm 与 Desktop 可以提供不同的 Hook 可执行入口，但必须写入同一套 1.0 durable inbox 语义；Hook 不负责拉起 Daemon。

Windows 正式 npm 包的 `setup` / `hook install` 会在无窗口 Runner 和正式 Hook 脚本都存在时写入隐藏执行命令；若正式 Runner 缺失，则诊断必须明确报告，不能假装无窗口能力可用。

## 17. CLI 与 npm 后台生命周期

当前 CLI：

```text
agent-lens setup [--json]
agent-lens start
agent-lens status [--json]
agent-lens doctor [--json]
agent-lens service start|stop|restart|status [--json]
agent-lens autostart enable|disable|status [--json]
agent-lens hook status [codex|claude|all]
agent-lens hook install [codex|claude|all]
agent-lens hook uninstall [codex|claude|all]
```

`setup` 是一次性初始化入口，职责限定为：

1. 校验 Node.js 最低版本；
2. 创建并检查 `~/.agent-lens/1.0` 数据目录；
3. 识别本机 Codex / Claude Code / Pi 默认数据根；
4. 对实际存在的 Codex / Claude Code 只补齐 AgentLens 自己缺失或不完整的 Hook；
5. Pi 使用原生 History / Runtime Tail，不安装 Hook；
6. 探测并报告现有 Daemon 与管理方式。

`setup` 不自动启动长期 Daemon，也不默认打开 npm 登录自启。

`start` 明确采用前台运行。启动前先探测默认 HTTP 地址；如果已经存在兼容 AgentLens Daemon，则直接复用并报告现有运行状态，不启动第二个 Daemon。

npm 后台模式通过操作系统原生的**用户级托管能力**实现，而不是恢复 0.x Service Manager：

```text
Windows -> 当前用户 Task Scheduler
Linux   -> systemd --user
macOS   -> LaunchAgent / launchd
```

统一内部入口为：

```text
agent-lens service run
```

该入口由系统托管器调用，启动同一个 `dist/daemon.mjs`，并向 Health 报告：

```text
owner = service
mode  = managed
```

关键边界：

- 不维护 PID 文件；
- 不另建数据库或运行时；
- `service start` 只负责当前后台运行；
- `autostart enable` 只控制下次登录是否自动启动；两者语义分离；
- Windows 计划任务可以在无登录触发器时独立注册，因此“已注册后台任务”不等于“已开启登录自启”；
- Windows 正式计划任务通过隐藏 PowerShell 调用 `service run`，不直接以可见 `node.exe` 作为任务动作；
- Windows 计划任务状态会检查定义中是否包含隐藏窗口参数，旧定义由 `doctor` 标记为警告；
- Linux 写入 `~/.config/systemd/user/agent-lens.service`，使用 `systemctl --user` 管理；
- macOS 写入 `~/Library/LaunchAgents/com.agentlens.daemon.plist`，使用 `launchctl` 管理；
- `service restart` 若发现当前 Daemon 由 Desktop 或前台 CLI 所有，不强制杀掉或接管；
- 系统托管定义只指向正式 `dist/cli.mjs`。源码模式必须先执行 `npm run build:dist`，不得把临时 `tsx` 入口写进登录启动项。

`status` 与 `doctor` 的职责也明确分层：

- `status` 同时报告 Daemon 在线状态与系统托管状态；
- 系统托管状态包含托管器、定义是否注册、当前是否运行、登录自启，以及 Windows 隐藏窗口状态；
- `doctor` 检查 `owner=service` 与系统托管状态是否一致、系统显示运行但 Health 不可达等矛盾，以及 Windows 是否仍使用旧后台定义；
- Windows `doctor` 额外检查正式发行的无窗口 Hook Runner 是否可用。

这些诊断事实只属于运维层，不进入 Canonical Observation / Evidence。

Windows / Linux / macOS 的系统托管配置只属于发行 / 运维层，不进入 Core、Source、Storage、Projection 或 Cordis Plugin Runtime。

## 18. 分发

AgentLens 1.0 正式支持两种一等发行方式：

- npm / CLI；
- Windows Desktop / NSIS 安装包。

npm 包名为 `@z7ping/agent-lens`。

两种发行方式复用同一套 Core、Cordis Runtime、Protocol、Web、Canonical 数据模型和默认数据根：

```text
~/.agent-lens/1.0/
```

分发构建会把内部 workspace 打包进：

```text
dist/cli.mjs
dist/daemon.mjs
dist/web/
dist/hooks/
  agent-lens-hook-codex.mjs
  agent-lens-hook-claude.mjs
  agent-lens-hook-runner.ps1   # Windows 无窗口 Hook 执行包装
```

Cordis 与 `better-sqlite3` 保留为外部 Runtime Dependency。

Release Workflow 会分别在 Linux / Windows 验证，打出唯一 npm tarball，生成 SBOM / checksum，将产物附加到 GitHub Release，最后发布同一份 tarball。

Windows CI 除普通 typecheck / test / distribution smoke 外，还验证两条真实运维链：

1. 无窗口 Hook Runner 能把 stdin JSON 完整传给 Claude Hook，并实际写入 Durable Inbox；
2. `autostart enable -> service start -> Health owner=service -> doctor -> service stop` 能形成闭环，并验证计划任务为隐藏窗口定义。

自动化验证不能替代真实桌面视觉验收。注销 / 登录是否完全没有可见控制台闪现，以及真实 Codex / Claude Code Hook 的窗口体验和时延，仍属于 Windows 实机验收项。

同一台机器可以同时安装 npm 与 Desktop，但同一默认数据根 / 默认端口同一时刻只允许一个有效 Daemon。兼容时复用现有 Daemon；不兼容时必须明确报告版本 / Protocol 冲突，不允许通过换端口偷偷启动第二套 1.0 事实链。

## 19. Windows Desktop

Electron 只是桌面壳，不是另一套 AgentLens Runtime。

职责：

- 单实例；
- BrowserWindow；
- 托盘生命周期；
- 启动 / 停止 / 重启自己拥有的 Daemon；
- 启动前探测并复用已有兼容 Daemon；
- Windows 登录后自动运行；
- 本地日志访问；
- NSIS 安装包。

Desktop 启动时先探测 `127.0.0.1:56789`：

- 没有兼容 Daemon：Desktop 启动并管理自己的 Daemon；
- 已有兼容 Daemon：Desktop 直接连接，不启动第二个 Daemon；
- 已有不兼容 Daemon：明确报告冲突，不接管、不换端口绕过；
- Desktop 退出时，只停止由当前 Desktop 启动的 Daemon，不误杀 npm / service 管理的外部 Daemon。

Windows 登录自启启动 Electron 到托盘，再由 Desktop 按上述规则决定复用或创建 Daemon；不恢复 0.x VBS + PID + detached daemon 作为正式桌面生命周期。

如果同一台 Windows 机器同时启用了 Desktop 登录自启与 npm `autostart`，两边都必须先探测默认运行时。先成功建立兼容 Daemon 的一方成为当次运行时所有者，另一方复用已有 Daemon，不启动第二套。

Daemon 仍然提供同一套 `127.0.0.1:56789` HTTP / SSE Surface。卸载 Desktop App 不会自动删除 `~/.agent-lens/1.0` 下的观测数据。

完整决策见 `docs/adr/0004-dual-distribution-single-runtime-lifecycle.md`。

## 20. 1.0 基线的非目标

当前 1.0 基线不声称继续支持 0.x 的全部 Adapter。Hermes、OpenCode、Cursor、OpenClaw 在按照稳定 Source Contract 重新实现之前，都不属于 1.0 Runtime。

1.0 也不承诺获取隐藏思维链，或重建来源本身没有暴露的信息。

## 21. 架构验收规则

新增一个 Source，正常情况下只需要新增一个 Source package，并在 Composition Root 中注册其 Cordis Plugin；Parser / Normalizer / SourceDefinition 仍按 Core Contract 实现。

如果新增 Source 必须修改 Core 语义类型、Canonical Identity、Evidence 语义或 Plugin Runtime 所有权，这就不是普通接入，而是一次 Contract Review。

发行方式不得改变 Canonical Data Flow。npm 与 Desktop 共存时，不得因为生命周期管理来源不同而创建第二套 Runtime、第二套 Schema、第二份默认数据库或重复采集链路。

后台生命周期定义只能引用正式发行入口，并由操作系统用户级托管器负责当前进程的启动 / 停止 / 恢复；AgentLens 不把 PID 文件重新提升为生命周期事实来源。

Windows 无窗口后台任务与 Hook Runner 都只是运维 / 执行包装。任何实现不得把它们扩展为新的 Runtime、Source 或数据写入链路。

## 22. 多机 Hub 架构

状态：**架构已接受并完成实现前复核，Alpha 实现尚未开始。** 完整决策见 `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`。

每个 AgentLens 实例都是一个持久 Node。Standalone、普通接入节点、Hub、Pure Hub 只是同一个 `AgentLensApplication` 的能力组合，不是四套程序，也不在 Core 中维护互斥角色：

```text
AgentLens Node
  localCapture        true | false
  replicationUpstream true | false
  hubAccept           true | false
```

Hub 继续遵守 Local-first。本机 Source 先形成 Local Canonical Store；只有经过独立 Replication Policy 允许的数据才进入 Hub：

```text
Native Source
  -> Capture Policy
  -> Local Canonical Store
  -> Replication Policy
  -> Bootstrap / Incremental Replication
  -> Hub Unified Canonical Store
  -> Projection
  -> Unified Web
```

当前本机 Canonical ID 不被直接提升为跨机全局主键。现有 `Host.id` 仍有单机身份算法约束，因此机器作用域实体通过确定性的 Replication Namespace 映射：

```text
ReplicaKey = stable(nodeId, entityType, originEntityId)
```

Hub 保存 `originNodeId` / `originEntityId` 用于追溯，但不重新运行 Source Parser 或 `IdentityService` 来猜测远程事实。Project、AgentProduct、AssetDefinition 等 Shared Entity 使用各自的 Shared Identity + 字段级确定性 Merge Contract 汇聚；禁止通用 last-write-wins。

Alpha 固定单 Hub 星型拓扑：一个 Node 最多一个 upstream Hub，不支持 Hub Federation、级联 Hub 或一个 Node 同时同步多个 Hub。

首次连接不是只同步“从现在开始”的新数据，而是：

```text
Pair
  -> Bootstrap Sync（可恢复）
  -> Incremental Sync
```

Cordis `observation/committed` 等事件只用于低延迟 fast path；Durable Replication 还必须通过 Canonical Reconciliation 查漏补缺。删除必须使用持久 Tombstone，不能因为一次扫描“没看到”就推断删除。

Hub 使用统一 Canonical Store，不按 Node 分数据库；Node Registry、Cursor、Replica Source、Conflict、Tombstone 等属于 Replication Control Plane，不混入 Agent 行为 Observation。

安全边界保持分离：

- 现有 `surface-http` 继续只监听 `127.0.0.1:56789`；
- 新增独立 Hub HTTPS Replication Surface；
- Node 只主动连接 Hub，Hub 不反向访问 Node；
- Pairing 使用短期一次性凭证，长期 Node 身份使用持久非对称密钥；
- Hub 支持 TLS 与 Hub Identity Fingerprint 绑定；
- Capture Policy 与 Replication Policy 分离，Alpha 至少支持 `metadata-only / redacted / full`；复制策略只能进一步收紧本机数据，不能恢复已关闭 / 脱敏内容；
- Alpha 默认不开放远程 Web，也不提供远程 Agent / Shell / Hook / Skill 管理能力。

产品版本、Replication Protocol 与 Storage Schema 独立演进。协议不兼容时只暂停 Replication，本机采集、Canonical Commit、SQLite 与 Web 必须继续工作。推荐升级顺序为先 Hub、后 Node，支持滚动升级。