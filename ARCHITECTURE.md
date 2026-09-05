# AgentLens 1.0 架构

> 状态：1.0 Alpha 实现基线  
> 更新日期：2026-09-06

本文只维护 AgentLens 1.0 的长期系统设计与关键边界。精确运行、发行、Hub、安全和采集规则分别引用对应权威文档，不在这里重复完整操作步骤或协议字段。

## 1. 产品定位

AgentLens 是面向本地 AI 编码 Agent 的可观测与执行轨迹查看器，主要回答：

1. 发生了什么；
2. 哪个来源 / 哪份证据证明它发生了；
3. 它属于哪个任务 / 会话 / 交互；
4. 实际使用了哪些 Tool 和能力资产。

AgentLens 不接管 Codex、Claude Code、Pi、Hermes、OpenCode 等 Agent 的执行循环，也不把自己扩展成通用 Agent 编排 / 远程控制平台。

## 2. 1.0 Clean Rebuild

1.0 是对 0.x 的彻底重建。

0.x 可以作为参考复用：

- 已验证的解析算法；
- fixture / 回归用例；
- 有价值的 UI 思路；
- 迁移规则。

0.x 不作为兼容层继续存在于 1.0 Runtime。禁止恢复：

- 旧 Adapter / Importer Runtime；
- 旧 `timeline` / `overview_*` 规范表；
- 旧 Service Manager / PID 架构；
- 旧 HTTP Response Shape；
- 双 Schema / 双 Runtime。

长期决策见 ADR-0001。

## 3. Canonical Data Flow

```text
Native Source
  -> SourceRecord
  -> SourceDefinition.normalize()
       -> ObservationCandidate
       -> EvidenceCandidate
       -> IdentityHints
       -> DedupHints
  -> IdentityService
  -> ObservationService.commit()
       -> CanonicalObservation
       -> Evidence
  -> Repository Contract
  -> Data Runtime Writer
  -> SQLite Canonical Store
  -> Projection / Reader
  -> @agent-lens/protocol DTO
  -> HTTP / SSE
  -> Web / Desktop
```

长期不变量：

- `CanonicalObservation` 表达 AgentLens 认为“发生了什么”；
- `Evidence` 表达“为什么认为它发生了”；
- `SourceRecord` 是原生证据输入，不是展示模型；
- Source 不得绕过 Canonical Pipeline 直接制造展示事实；
- Projection 是可重建读模型，不是第二事实源。

详细领域契约见 `docs/1.0/CORE-CONTRACT.md`。

## 4. Cordis Runtime

Cordis 是唯一 Plugin Runtime；AgentLens 1.0 本身是一个 Cordis Application。

```text
AgentLensApplication / Daemon Control Plane
  ├─ data-runtime-storage
  │    ├─ Writer Worker -> storage-sqlite (唯一 writable SQLite)
  │    └─ Reader Worker -> storage-sqlite (readonly SQLite)
  ├─ core-services
  ├─ capture-policy
  ├─ sources/*
  ├─ projections/*
  ├─ pi-live-runtime
  ├─ surface-http
  └─ web
```

规则：

- 精确锁定 `@deepseek-ai/cordis@4.0.1`；
- **Core is framework-agnostic; runtime extensions are Cordis-native**；
- Core Domain / Core Services / Repository Contract / Parser / Normalizer / Protocol DTO 不依赖 Cordis；
- Source / Storage / Surface 等运行时入口可以使用 Cordis Context / inject / lifecycle；
- 不在 Cordis 前再维护第二套通用 Plugin Adapter / DI / Lifecycle；
- Data Runtime IPC 是执行边界，不是第二业务模型；
- `runtime-cordis` 只承担 AgentLens Application 与 Cordis 的薄集成边界。

普通新增 Source 不应修改 Runtime 机制；如果必须改变 Core 语义、Canonical Identity、Evidence 或 Plugin Ownership，应进入 Contract Review。

## 5. Source 模型

所有 Source 实现同一 `SourceDefinition`：

```text
detect
 -> declareCapabilities
 -> ingestHistory?
 -> startCapture?
 -> discoverAssets?
 -> normalize
```

Source Runner 保持通用，不允许按具体 `sourceId` 增加业务分支。

当前已实现并注册到 Cordis Runtime 的 Source：

| Source | History | Runtime | Assets / 说明 |
| --- | --- | --- | --- |
| Claude Code | JSONL | Hook -> Durable Inbox | Skill / MCP / Plugin / Hook / Command |
| Codex | Session JSONL | Hook -> Durable Inbox | Skill / MCP / Plugin / Hook / Rule |
| Pi | Session JSONL | 原生文件 Tail | Skill / Extension / MCP / Memory |
| Hermes | `state.db` | Native DB Tail；可选 Observer -> Inbox | Skills / Plugins / MCP / Toolsets / Memories |
| OpenCode | `opencode.db` | Native DB Tail | 当前不虚构未验证资产能力 |

默认只启用 Claude Code；其他 Source 需要显式允许。采集门禁见 `docs/1.0/CAPTURE-POLICY.md`，Hermes / OpenCode 特有边界见 `docs/1.0/HERMES-OPENCODE-SOURCES.md`。

Cursor、OpenClaw 等只有在按照 1.0 Source Contract 正式实现后才属于 Runtime；不能因为 0.x 曾支持就视为当前能力。

## 6. Runtime Capture / Hook

Hook / Observer 只是被动采集 Shim：

```text
Native Hook / Observer
 -> source allowlist
 -> sanitize
 -> Durable Inbox
 -> Source.startCapture()
 -> Canonical Pipeline
 -> Data Runtime Writer
```

Hook / Observer 不依赖 Cordis、SQLite、Core Services、HTTP 或 Daemon 生命周期，不执行远程控制，也不得阻断上游 Agent。

Windows 的隐藏 PowerShell / Process Runner 只解决无窗口启动和 Provider 选择，不是第二套 Runtime。

Hook 安装、双发行 Provider 选择和后台生命周期见 `docs/1.0/DISTRIBUTION-OPERATIONS.md`。

## 7. Identity / Observation / Evidence

本机主要身份图：

```text
Host
 -> AgentInstallation
    -> LogicalSession
       -> SourceSession
       -> AgentActor
       -> Interaction (derived)
```

`SourceSession` 保存来源原生 Session ID；`LogicalSession` 表达 AgentLens 任务 / 会话范围。

跨 Session 语义用显式关系表示，例如：`resume / continuation / fork / subagent / import-copy / related`，不继续把语义塞进某个字符串 Session Key。

同一原生事实由 History 与 Runtime 两条路径观察到时，应合并为同一 Canonical Observation 并增强 Evidence，而不是创建重复事实。

典型去重优先级：native event ID -> native call ID -> shared event key -> source sequence -> payload fingerprint/time -> deterministic fallback。

## 8. Storage / Data Runtime

1.0 使用 SQLite Canonical Store，并通过 Core Repository Interface 访问。

正式运行时边界：

```text
Daemon / Control Plane
  ├─ HTTP / SSE / Pi
  ├─ Reader Data Runtime
  │    └─ readonly SQLite
  └─ Writer Data Runtime
       └─ 唯一 writable SQLite
```

硬约束：

- Daemon 主线程不直接打开 SQLite；
- 同一数据库只有 Writer Data Runtime 持有 writable connection；
- Reader 只读；
- Schema migration、Canonical 写入、History persistence、Projection rebuild、Replay、Compression、Deferred Index 都进入 Writer；
- Task Center / Unified Read / Usage 等只读查询优先进入 Reader；
- 远程 Repository 事务保持 BEGIN / COMMIT / ROLLBACK 原子边界；
- Data Runtime unavailable 不应带崩 Daemon Control Plane。

业务代码不得绕过 Repository 直接写功能专用 SQL；SQLite Repository 实现保持 Cordis-independent。IPC 只改变执行位置，不改变 Repository / Service 业务契约。

`/ready` 不依赖 Data Runtime 重查询；`/health` 合并 Writer / Reader 状态与 Event Loop / IPC / SQLite 指标。前台 Data Runtime 读请求有明确查询预算，失败时快速降级而不是无限等待。

大库维护、容量策略和真实验收见 `docs/1.0/STORAGE-MAINTENANCE.md`；运行时隔离长期决策见 `docs/adr/0010-data-runtime-control-plane-isolation.md`。

Local Canonical Store 保持真实本机领域不变量。Projection 优化 Reader 可以存在，但不能成为第二事实源。

Hub Alpha 新增 Remote Replica 时仍使用一个默认 Hub Storage Boundary / SQLite，但**不要求 Remote Replica 强塞进 Local Canonical SQL Row**。Remote `omitted / redacted` 由 Replica 表示原生保存，再通过 Unified Read 与 Local Canonical 聚合。

Hub 数据模型见 `docs/1.0/HUB-DESIGN.md`。

## 9. Projection

当前长期 Projection 范围包括：

- Timeline；
- Session / Interaction；
- Task Review；
- Tool / Asset Usage；
- Agent Overview / Facet；
- Session Relationship；
- 使用洞察。

Projection 只从 Repository / 正式 Read Contract 获取事实，不直接拥有 Source / SQLite 实现。

历史 Projection Backfill 不允许重新塞回 Schema migration；大库历史补齐必须通过可恢复 Maintenance Job 批量执行。新写入 Projection 仍由正常写路径 / trigger 实时维护。

静态 Asset Discovery 不等于实际 Usage。只有 Evidence 足够可靠时才把 Tool Call 归因到 Skill / MCP 等 Asset。

Hub 实现后，Projection 通过 Unified Read 读取 Local Canonical + active Remote Replica，并显式理解字段 availability；不得把 Remote omitted 字段伪造成空值。

## 10. Protocol / Surface / 实时更新

`@agent-lens/protocol` 是 Web / Surface 的对外 DTO 边界。浏览器代码不得直接 import Core、SQLite 或 Source package。

当前 Local HTTP / SSE 只监听：

```text
127.0.0.1:56789
```

主要 `/api/v1/*` 能力包括 health、timeline、sessions、review、usage、facets、agents、relationships 与 SSE events。

Canonical Observation 新建或 Evidence 增强后可以发布 `observation/committed`；幂等 unchanged 不广播刷新噪声。

SSE 高频事件不能触发整页反复重绘。不能安全增量刷新的视图优先提示“有新数据”。

Hub Replication 使用**独立 authenticated HTTPS Surface**，不复用 / 暴露 Local HTTP。R1 语义见 `docs/1.0/HUB-REPLICATION-PROTOCOL.md`。

## 11. Web

Web 使用 Vite + React + TypeScript，只消费 `/api/v1/*` Protocol DTO。

当前主视图：

- 任务复盘；
- 工具分析；
- 使用洞察；
- 智能体概览；
- 资产备份。

表现层长期边界：

- 保持高信息密度，目标是降噪而不是隐藏信息；
- 用户消息右侧、智能体左侧；
- 保留 Evidence、生命周期、工具执行和长会话 turn-rail；
- 会话列表与详情保持独立滚动上下文；
- 正常文字不低于 12px；
- 正式 Design Token 与高保真基线保持一致；
- Web 不直接访问 Storage 私有实现。

## 12. npm / Desktop：双发行、单运行时

AgentLens 1.0 的一等发行方式：

- npm / CLI；
- Windows Desktop / NSIS。

两者共用：

```text
同一 Core
同一 Cordis Runtime
同一 Protocol / Web
同一默认数据根 ~/.agent-lens/1.0/
同一默认 Daemon / Port
```

同一默认数据根同一时刻只允许一个有效 Daemon。Desktop 可以复用 npm/service 启动的兼容 Daemon，只停止自己拥有的 Daemon。

后台生命周期使用 OS 用户级托管能力：Windows Task Scheduler、Linux `systemd --user`、macOS `launchd`；不恢复 PID 文件 / 0.x Service Manager。

完整运维与发行规则见：

- `docs/adr/0004-dual-distribution-single-runtime-lifecycle.md`；
- `docs/1.0/DISTRIBUTION-OPERATIONS.md`；
- `docs/1.0/DESKTOP-RELEASES.md`。

## 13. 多机 Hub Alpha

状态：**架构冻结，功能尚未实现。**

核心链路：

```text
Node Local Canonical
 -> Replication Policy + History Scope
 -> Versioned R1 Wire
 -> Hub Remote Replica
 -> Unified Read
 -> Projection / Web
```

长期边界：

- 每个 AgentLens 实例都是持久 Node；Standalone / 连接 Hub / Hub / Pure Hub 只是能力组合；
- Alpha 固定单 Hub 星型拓扑；
- Local Node 是事实 Primary，Hub 是 Replica + Aggregator；
- 本机 Canonical ID 与跨机 ReplicaKey 分离；
- `AgentProduct` 是 Shared Root；Project / AssetDefinition 使用 Origin + Shared Group Membership；
- Capture Policy / Replication Policy / History Scope 分离；
- Durable Replication 使用 at-least-once + immutable Batch + Sequence/ACK + idempotent Import + Reconciliation；
- Hub Storage 区分 Local Canonical / Remote Replica / Shared Identity / Control Plane / Unified Read；
- Local Surface 继续 loopback；Replication 使用独立 authenticated HTTPS；
- Alpha 是 trusted-node 模型，不提供 Remote Attestation / Remote Control；
- npm / Desktop 共用 Node / Hub Identity 与 Replication State。

当前有效 Hub 系统设计：`docs/1.0/HUB-DESIGN.md`。  
关键决策原因：`docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`。  
R1 Wire：`docs/1.0/HUB-REPLICATION-PROTOCOL.md`。  
安全：`docs/1.0/HUB-PAIRING-SECURITY.md`。  
运维 / 用户生命周期：`docs/1.0/HUB-OPERATIONS.md`。

## 14. 安全与隐私

本机采集隐私由 `CapturePolicyService` 统一控制；Source 不能自行绕过。

Hub 复制再增加独立 Replication Policy，Local 可保存不代表允许出站。

仓库总安全边界：`SECURITY.md`。  
Hub 专项安全：`docs/1.0/HUB-PAIRING-SECURITY.md`。

## 15. Contract Review 边界

以下变化不是普通实现调整，需要显式 Contract Review，达到门槛时新增 / 修订 ADR：

- 改变 Canonical Data Flow；
- 改变 Core Identity / Evidence 语义；
- 改变 Cordis Runtime 所有权；
- 改变 Data Runtime 单 Writer / Control Plane 隔离边界；
- 新增第二事实源；
- 改变双发行单 Runtime 边界；
- Hub 从单向 Replica 改为双向同步 / 多 Hub / Federation；
- 开放 Remote Control / Remote Web Trust Boundary；
- 改变 Hub Replica / Shared Identity 的长期语义。

普通 Source 接入、性能优化、UI 修复和在既有 Contract 内的实现细节，不应轻易上升为新架构。

## 16. 相关权威文档

- `docs/1.0/CORE-CONTRACT.md`：Core / Domain Contract；
- `docs/1.0/CAPTURE-POLICY.md`：Source 与本机持久化隐私；
- `docs/1.0/DISTRIBUTION-OPERATIONS.md`：npm / Desktop / Hook / Service 运维；
- `docs/1.0/HERMES-OPENCODE-SOURCES.md`：Hermes / OpenCode Source 特有边界；
- `docs/1.0/STORAGE-MAINTENANCE.md`：大库维护、容量和生产验收；
- `docs/1.0/HUB-DESIGN.md`：Hub 当前有效系统设计；
- `docs/1.0/IMPLEMENTATION-STATUS.md`：当前真实实现能力；
- `docs/adr/0010-data-runtime-control-plane-isolation.md`：Data Runtime / Control Plane 隔离；
- `docs/adr/`：关键长期架构决策形成原因。
