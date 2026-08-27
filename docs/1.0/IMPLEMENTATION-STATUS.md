# AgentLens 1.0 Alpha 实现状态

更新日期：2026-08-27

本文只记录当前 1.0 实现事实。详细架构边界见 `ARCHITECTURE.md`、`docs/1.0/CORE-CONTRACT.md` 与 ADR；双发行运维见 `docs/1.0/DISTRIBUTION-OPERATIONS.md`；采集边界见 `docs/1.0/CAPTURE-POLICY.md`。

## 1. Core / Runtime

已实现：

- 全新的 1.0 Core Domain 与 Contract；
- 精确锁定 `@deepseek-ai/cordis@4.0.1`；
- AgentLens 作为 Cordis Application 运行；
- Source / Storage / Surface 入口采用 Cordis-native Plugin；
- Core Domain / Core Services、Repository Contract、Parser / Normalizer 与 Cordis 解耦；
- SQLite 1.0 Repository 与 Checkpoint；
- `SourceRecord -> normalize -> ObservationCandidate + EvidenceCandidate -> Canonical Observation + Evidence`；
- Asset Inventory 通过 Core Contract 暴露，Projection 不直接依赖 SQLite 实现；
- 独立 `@agent-lens/capture-policy` 统一控制来源启用与持久化隐私边界。

禁止恢复 0.x Adapter / Importer Runtime、旧 `timeline` / `overview_*` 规范表、旧 Service Manager / PID 架构。

## 2. Sources

当前已经作为独立 Cordis Source Plugin 注册到 Daemon：

- Claude Code；
- Codex；
- Pi；
- Hermes；
- OpenCode。

**注册不等于启用采集。** 当前默认来源允许列表只有 `claude-code`。通过 `AGENT_LENS_ENABLED_SOURCES` 可以显式启用其他来源，例如：

```text
AGENT_LENS_ENABLED_SOURCES=claude-code,codex,pi,hermes,opencode
```

`AGENT_LENS_ENABLED_SOURCES=none` 可以关闭全部来源。禁用来源在 `detect()` 前就被过滤，不进入 History / Runtime / Asset 流程；后续阶段也会再次检查来源开关，避免旧 Target 或错误调用绕过门禁。

### Claude Code

- 默认启用；
- History；
- Runtime Hook Durable Inbox；
- Assets；
- Hook 遵守同一来源允许列表，禁用 `claude-code` 后不再写 Inbox。

### Codex

- 默认关闭，需显式启用 `codex`；
- History；
- Runtime Hook Durable Inbox；
- Assets；
- Hook 遵守同一来源允许列表，默认不再写 Inbox。

### Pi

- 默认关闭，需显式启用 `pi`；
- History；
- 原生 Runtime Tail；
- Assets。

### Hermes

- 默认关闭，需显式启用 `hermes`；
- `state.db` History；
- `state.db` Native Tail：文件变化触发 + 周期兜底；
- 对消息行使用 rowid + fingerprint，允许识别原地更新；
- Skills / Plugins / MCP / Toolsets / Memories 静态资产发现；
- 可选 Hermes `agent-lens-observer` Plugin 形成 Runtime Hook Durable Inbox Evidence；
- Observer 只使用 Python 标准库写本地 Inbox，不访问 HTTP / SQLite / Core / Cordis，不返回行为修改指令；
- Observer 同样遵守来源允许列表，即使用户已经显式安装 / 启用插件，未启用 `hermes` 时也不写 Inbox；
- Hermes 第三方插件遵守显式启用模型，AgentLens 不在 `setup` 中静默启用。

### OpenCode

- 默认关闭，需显式启用 `opencode`；
- `opencode.db` History；
- 关联 `part + message + session` 恢复对话、角色、Workspace 与工具信息；
- 原生数据库变化驱动 Runtime Tail + 周期兜底；
- 对最近行使用 rowid + fingerprint，能够捕获同一 Tool Part 从 running 原地更新到 completed；
- 当前不虚构未验证的资产清单能力。

Hermes / OpenCode 的详细边界见 `docs/1.0/HERMES-OPENCODE-SOURCES.md`。

所有启用 Source 继续共用 Source Runner、Identity、Observation Commit、Evidence 与 Dedup；通用 Runner 不包含按具体 `sourceId` 分支，只通过 `CapturePolicyService.isSourceEnabled(sourceId)` 执行统一门禁。

## 3. Projections / Protocol

已实现：

- Timeline Projection；
- Session / Interaction Projection；
- Tool / Asset Usage Projection；
- Task Review Projection；
- Agent Overview / Facet / Session Relationship Projection；
- 使用洞察 Projection；
- 带版本的 `@agent-lens/protocol` DTO。

Web / Surface 只消费 Protocol DTO，不直接依赖 Core / Storage / Source。

## 4. HTTP / SSE

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
- `/api/v1/events`

SSE 当前：

- Canonical Observation、Source Detection、Asset 变化可产生事件；
- `unchanged` Replay 不产生刷新噪声；
- 15 秒心跳；
- 建议 1.5 秒重连；
- 已关闭、销毁或写异常的客户端会被清理；
- 浏览器识别真实断线后重连，并做一次去抖快照校准，补偿 EventSource 不回放断线窗口的问题；
- 任务复盘保留当前详情阅读上下文；使用洞察继续只标记“有新数据”。

## 5. Web 表现层

当前 Web：

- React 19 + Vite + Tailwind CSS；
- 独立 `@agent-lens/web` Cordis Surface Plugin；
- React 外 `AgentLensClientModel` 管理业务状态；
- `useSyncExternalStore` 消费 Snapshot；
- SSE 在首屏 Snapshot 请求前建立；
- 高频事件按区域合批，不反复整页替换；
- 任务复盘保持 Session List / Session Detail、高信息密度、Evidence、生命周期、工具执行和 Turn Rail；
- 用户消息右侧、智能体消息左侧；
- 会话列表与详情阅读区拥有独立滚动上下文；
- 已删除 `review-balanced*`、`review-polish.css`、`v2-1.css` 等退役最终覆盖层；
- 正式普通界面语义字号下限为 12px。

### 设计令牌与对比度

本轮已经把高保真原型 Token 变成正式运行时门禁：

- `packages/web/src/tokens.css` 在所有页面 / 历史样式之后、`color-system.css` 之前加载；
- 基础浅色 / 暗色 Token 必须与 `docs/design/mockups/v2/assets/tokens.css` 逐项一致；
- `check:web-presentation` 校验正式加载顺序；
- `check:web-presentation` 计算正文、次要文字、用户气泡、强调 / 成功 / 警告 / 危险实底的关键前景/背景对比度；
- 关键组合低于 4.5 直接失败；
- 来源色只用于小面积标记，不承担正文可读性；
- Hermes / OpenCode 已补正式来源名称和小面积来源色。

因此，页面不应再依赖旧色板加载顺序来“碰巧”得到正确前景色。

## 6. 任务复盘 / 工具 / 智能体 / 洞察

### 任务复盘

- Session / Interaction 为主要阅读单位；
- 用户 / Agent / 可观察过程片段；
- Tool Call 分组；
- Tool result / error / duration；
- Permission / Subagent / Context / Model / Lifecycle；
- Evidence / Raw Payload Inspector；
- Agent / 项目 / 时间 / 错误 / 关键字筛选。

### 工具分析

- Tool 调用次数；
- Session 数；
- 成功 / 失败；
- 总耗时 / 平均耗时；
- Skill / MCP 可靠归因使用统计。

### 智能体概览

- Agent 检测与 Installation；
- Capability；
- Asset Inventory / Binding / State；
- Evidence-backed Skill / MCP Usage；
- 静态资产状态与真实调用明确分离。

### 使用洞察

- 会话 / 交互 / 工具 / 失败范围聚合；
- 时间窗趋势和上周期比较；
- Agent 使用结构；
- 可可靠归因的资产采用；
- 跨会话重复工具序列；
- 不把会话跨度误解释为连续工作时间。

## 7. 资产备份

已实现：

- 基于 Source / Asset Inventory 扫描可备份资产；
- 原始 Session / History 数据优先作为备份源；
- 本地不可变 Snapshot；
- Manifest 与逐文件 SHA-256；
- 导入 / 导出；
- 恢复差异预演；
- 敏感字段、凭据、私钥、符号链接和越界路径默认排除。

当前仍停在恢复预演，不直接写回用户环境。

## 8. npm / Windows Desktop 双发行

当前正式目标：**双发行、单运行时、共享数据、互斥生命周期**。

已实现：

- npm / CLI 与 Windows Desktop 共用默认数据根、数据库、协议和端口；
- 默认同一时刻只允许一个 Daemon；
- Desktop 探测并复用已有兼容 Daemon；
- Desktop 只停止自己拥有的 Daemon；
- Windows npm 后台使用当前用户 Task Scheduler；
- Linux 使用 `systemd --user`；
- macOS 使用用户级 `launchd`；
- 不维护 PID 文件；
- `status / doctor` 同时报告 Daemon 与系统托管状态；
- Windows 后台任务使用隐藏 PowerShell；
- Desktop 启动前对 Health 做有限重试并继续校验 Protocol，降低单次超时导致的双 Daemon 风险；
- Desktop 登录自启写入后重新读取 Windows 真实状态；
- `installations/npm.json` / `desktop.json` 是候选登记，不是安装事实；
- Windows Codex / Claude Native Hook 固定指向共享 Dispatcher；
- Dispatcher 每次验证真实 Provider 文件，Desktop 有效时优先，否则回退 npm；
- 两种发行方式卸载其一后，陈旧登记不得阻塞另一方。

详细规则见 `docs/1.0/DISTRIBUTION-OPERATIONS.md` 和 ADR-0004。

## 9. Hook 边界

Codex / Claude：

```text
Native Hook
-> source allowlist
-> passive shim
-> Durable Inbox
-> Source.startCapture()
-> Canonical Pipeline
```

Hermes 可选 Observer：

```text
Hermes Plugin Hook
-> source allowlist
-> passive observer
-> Durable Inbox
-> Hermes Source.startCapture()
-> Canonical Pipeline
```

所有 Hook / Observer 都不得直接写 AgentLens SQLite、不得加载 Cordis/Core、不得依赖 HTTP、不得阻断上游 Agent。来源未启用时必须在 Durable Inbox 之前停止采集。

OpenCode / Pi 不为实时采集额外安装 Native Hook，继续使用原生数据 Runtime Tail；来源关闭时不会启动对应 Tail。

## 10. 关键验收不变量

- 默认只启用 Claude Code 来源；其他来源必须显式加入 `AGENT_LENS_ENABLED_SOURCES`；
- 禁用 Source 在 `detect()` 之前被过滤，也不能进入 History / Runtime / Asset；
- Codex / Claude / Hermes Hook 或 Observer 必须遵守同一来源允许列表，禁用时不得继续写 Inbox；
- 同一原生事实由 History 与 Runtime 同时观察到时，应合并为 Canonical Observation 并增强 Evidence，而不是制造重复事实；
- Source Runner 不得出现来源业务分支；
- Core / Repository / Parser / Normalizer 不依赖 Cordis；
- Source / Storage / Surface 运行时入口直接是 Cordis Plugin；
- Source 不绕过 Canonical Pipeline；
- Web 只消费 Protocol DTO；
- 静态 Asset Discovery 不算 Usage；
- npm / Desktop 共存不产生第二个默认 Daemon 或第二套默认数据库；
- Windows Hook Dispatcher 只做 Provider 选择和无窗口执行包装；
- Hermes Observer 保持显式启用、被动、fail-open；
- Web 正式表现层不得重新引入历史最终覆盖层；
- 高保真基础 Token 与正式运行时 Token 不得漂移；
- 关键文字/背景对比度门禁不得被绕过；
- SSE 恢复必须补偿断线窗口，同时正常高频事件继续保持增量 / 提示式更新。

## 11. 自动验收

基线使用 Node.js `>=22.23.0`，主 CI 在 Linux / Windows / macOS 执行：

1. `npm install --no-audit --no-fund`
2. `npm run check:web-presentation`
3. `npm run check:desktop-shell`
4. `npm run typecheck`
5. `npm test`
6. `npm run build:dist`
7. Windows 共享 Hook Dispatcher 验证
8. Windows npm 生命周期验证
9. npm 包内容 / 发行相关检查

本轮新增自动测试包含：

- 来源允许列表默认值、显式启用与全部关闭；
- 禁用 Source 在 Detect 前被过滤；
- 禁用的旧 Target 在后续 History 阶段仍被忽略；
- Codex Hook 默认不写 Inbox，显式启用后才持久化；
- OpenCode 原生 SQLite History；
- OpenCode 同一 Tool Part 原地更新后的 Runtime Tail；
- OpenCode History Replay 幂等；
- Hermes `state.db` History；
- Hermes 用户 / 智能体 / Tool Call / Tool Result 规范化；
- Hermes 资产发现；
- Hermes Runtime Hook Durable Inbox；
- Hermes History Replay 幂等；
- Web 高保真 Token 逐项一致性；
- Web 关键前景/背景 4.5 对比度门禁。

本轮最新 `main` 的三平台 CI 结果在最终确认前不写成“已通过”。

## 12. 仍需实机验收

重点仍是：

- Windows 是否有黑色控制台闪现；
- Desktop 登录自启；
- 托盘与退出；
- npm / Desktop 共存时是否只有一个 Daemon；
- 来源默认值是否确实只采 Claude Code；
- 显式启用 Codex / Pi / Hermes / OpenCode 后，Detect / History / Runtime / Asset 是否按来源能力正确恢复；
- Codex / Claude Hooks 是否严格跟随来源开关；
- 卸载任一发行后另一发行是否继续工作；
- 真实 Hermes / OpenCode 本机数据是否完整映射；
- Hermes Observer 显式启用且来源开启后的 Hook 延迟、稳定性和与 `state.db` Evidence 对账；
- 明暗主题、长会话、工具密集场景下的文字/背景对比度。

本文不代表已经完成 npm Publish 或 GitHub Release；发布仍必须由仓库所有者明确触发。

## 13. 多机 Hub（架构已定，尚未实现）

ADR-0007 已接受 AgentLens 1.0 Alpha 的多机 Hub 架构，但当前代码尚未实现 Node / Hub 角色、Replication Protocol、Remote Ingest 或配对流程。

已确定的实现边界：

- Node / Hub 是同一 AgentLens Runtime 的不同 Cordis Plugin Composition，不拆成两套程序；
- Hub 默认可以同时采集本机，允许 `localCapture=false` 的 Pure Hub；
- Node 保持 Local-first，本机 Canonical Store 是本机事实产生链，Hub 是 Canonical Replica + Aggregator；
- Canonical ID 在 Node 生成并在 Hub 保持不变；
- Hub 使用统一 Canonical Store，不按 Node 分数据库；
- Replication Metadata 属于独立 Control Plane，不写成 Agent 行为 Observation；
- Node 只主动向 Hub 发起 HTTPS 出站连接；现有 `127.0.0.1:56789` Local Surface 不直接暴露到网络；
- Pairing / TLS / Node Key / Hub Identity 与远程 Web 登录边界分离；Alpha 默认不开放远程 Web；
- AgentLens Version、Replication Protocol、Storage Schema 独立演进；协议不兼容只暂停同步，不阻塞 Node 本地采集。

建议实现顺序：Role-driven Composition Root -> Persistent Node / Host Identity -> Replication Wire DTO / Handshake -> Durable Outbox -> Hub Node Registry / Remote Ingest -> Pairing / TLS -> Projection Scope -> Web 多机视图。

完整决策、被拒绝方案和验证标准见 `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`。
