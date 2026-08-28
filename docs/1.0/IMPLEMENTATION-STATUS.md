# AgentLens 1.0 Alpha 实现状态

更新日期：2026-08-28

本文只记录**当前真实已实现能力**与仍未实现的大项，不复制完整架构、协议或运维规则。

长期系统设计见 `ARCHITECTURE.md`；Core 契约见 `docs/1.0/CORE-CONTRACT.md`；采集隐私见 `docs/1.0/CAPTURE-POLICY.md`；双发行运维见 `docs/1.0/DISTRIBUTION-OPERATIONS.md`。

## 1. Core / Runtime

已实现：

- 全新的 1.0 Core Domain 与 Contract；
- 精确锁定 `@deepseek-ai/cordis@4.0.1`；
- AgentLens 作为 Cordis Application 运行；
- Source / Storage / Surface 使用 Cordis-native Plugin；
- Core Domain / Core Services / Repository / Parser / Normalizer 与 Cordis 解耦；
- SQLite 1.0 Repository / Checkpoint；
- `SourceRecord -> normalize -> ObservationCandidate + EvidenceCandidate -> CanonicalObservation + Evidence`；
- Asset Inventory 通过 Core Contract 暴露；
- `@agent-lens/capture-policy` 统一 Source allowlist 与持久化隐私门禁；
- Hub H1 Node Runtime 基础：默认数据根首次启动创建持久 `node.json` UUID，损坏身份文件不静默重置；
- Node Runtime 通过 Cordis `ctx.node` 统一暴露 `dataRoot / identity / profile / capabilities`；
- `AGENT_LENS_PROFILE` 支持 `standalone / node / hub / pure-hub` 四种 Alpha Profile；
- Daemon Composition Root 按 `localCapture` 决定是否注册本机 Source；
- Hub H2 Replication Core 通过 `@agent-lens/core/replication` 子路径暴露；
- H2 已实现 Entity Scope Registry、`agentlens-replica-r1` ReplicaKey、SharedRootKey / SharedGroupKey；
- H2 已实现 `project-repository-v1` / `asset-upstream-v1` Portable Identity；
- H2 已实现 AgentProduct Shared Root、Project / AssetDefinition Shared Group / Membership；
- H2 Origin Identity / ReplicaKey 保持独立，不改写本机 Canonical ID 或领域 FK；
- H3 R1 Protocol Core 通过 `@agent-lens/protocol/replication` 子路径暴露，与现有 Local Read Protocol 保持命名空间隔离；
- H3 已实现 Protocol R1.0、Handshake DTO、Entity Envelope、Batch、Tombstone、Node Ref / Shared Ref、Availability 与稳定错误码；
- H3 已实现 Protocol / Identity Algorithm / Entity Version 的纯兼容协商，可选能力取交集，required 能力缺失时 fail-closed；
- H3 已实现 Canonical JSON + 纯 TypeScript SHA-256 的 Entity / Batch / Tombstone 语义 Hash；
- H3 已实现 Sequence / ACK 的 next / exact retry / reuse conflict / gap 纯决策；
- H3 已将 Project / AssetDefinition Wire Scope 固定为 Node Origin，将 Alpha Shared Ref 限定为 AgentProduct Shared Root；
- H4 Replication Policy / History Boundary 通过 `@agent-lens/core/replication` 暴露，保持 framework-agnostic；
- H4 已实现 `metadata-only / redacted / full` 三档出站策略及 Revision、`include-existing / from-now` History Boundary 及 Revision；
- H4 已实现 Capture State -> Replication Availability 的单调变换，不能恢复 Capture 阶段已关闭或已脱敏的数据；
- H4 已实现显式 Entity Field Contract、Minimum Dependency Shape、`from-now` 对 Bootstrap / Incremental / Reconcile 的统一授权语义；
- H4 已实现凭据永久保护、redacted 路径用户目录遮蔽、策略收紧 / 放宽与 History Scope 变更的纯决策；
- H4 出站字段默认 fail-closed：未登记新字段统一 `omitted(policy)`，H2 标记 `not-replicated` 的实体不能进入出站 Transform；
- H5 Durable Replication State 已实现 Core 状态机：Relationship / Stream / Generation、Pending Entity、Frozen Batch、ACK、Reconciliation Cursor；
- H5 Frozen Batch 的 `sequence + batchId + contentHash` 在冻结后不可变，exact retry 只能返回同一冻结批次；
- H5 SQLite Schema 已升级到 v7，新增独立 Replication Control Plane 表，不向 Canonical Fact 表写入复制状态；
- H5 已实现 Pending 幂等去重 / 冻结前替换、连续 ACK、重启恢复、Relationship Stream Rollover；
- H5 已实现 framework-agnostic Reconciliation Source / Sink 契约和 SQLite Durable Sink：fast-path 漏入队时可以通过 Canonical Reconciliation 补回 Pending，游标仅在整页成功后推进。

H1-H5 目前仍是本机 Node Runtime、Replication Identity、Wire Protocol、出站策略与 Durable State 基础。`node / hub / pure-hub` **不会**启动真实 Replication 网络行为，也没有 Hub Remote Replica Store；H5 也尚未把具体 Canonical Entity 全量枚举与 Daemon 周期调度接入运行时。

禁止恢复 0.x Adapter / Importer Runtime、旧 `timeline / overview_*` 规范表、旧 Service Manager / PID 架构。

## 2. Sources

当前已经作为独立 Cordis Source Plugin 注册到 Daemon：

- Claude Code；
- Codex；
- Pi；
- Hermes；
- OpenCode。

默认只启用 Claude Code。其他来源必须显式加入 `AGENT_LENS_ENABLED_SOURCES`；`none` 可以关闭全部来源。

### Claude Code

- History；
- Runtime Hook -> Durable Inbox；
- Assets；
- 默认启用。

### Codex

- History；
- Runtime Hook -> Durable Inbox；
- Assets；
- 默认关闭。

### Pi

- History；
- 原生 Runtime Tail；
- Assets；
- 默认关闭。

### Hermes

- `state.db` History；
- Native DB Tail；
- Skills / Plugins / MCP / Toolsets / Memories Asset Discovery；
- 可选 `agent-lens-observer` 只写 Durable Inbox；
- 默认关闭。

### OpenCode

- `opencode.db` History；
- Native DB Tail；
- 支持 Tool Part running -> completed 原地更新识别；
- 当前不虚构未验证资产清单能力；
- 默认关闭。

Hermes / OpenCode 详细边界见 `docs/1.0/HERMES-OPENCODE-SOURCES.md`。

所有启用 Source 共用通用 Runner、Identity、Observation Commit、Evidence 与 Dedup，不在 Runner 中按 `sourceId` 写业务分支。

## 3. Projection / Protocol / HTTP

已实现：

- Timeline Projection；
- Session / Interaction Projection；
- Task Review Projection；
- Tool / Asset Usage Projection；
- Agent Overview / Facet / Session Relationship Projection；
- 使用洞察 Projection；
- 带版本的 `@agent-lens/protocol` Local Read DTO；
- 独立子路径 `@agent-lens/protocol/replication` 的 R1 Wire Protocol Core。

当前 Local HTTP / SSE 包括：

```text
/api/v1/health
/api/v1/timeline
/api/v1/sessions
/api/v1/usage
/api/v1/review
/api/v1/review/:logicalSessionId
/api/v1/facets
/api/v1/agents
/api/v1/relationships
/api/v1/events
```

Local Surface 继续只监听 loopback。H3-H5 没有新增 Replication HTTP / HTTPS Route。

SSE 当前支持 Observation / Source Detection / Asset 变化通知、15 秒心跳、断线重连与快照校准；幂等 unchanged replay 不制造刷新噪声。

## 4. Web

已实现：

- React 19 + Vite + Tailwind CSS；
- 独立 `@agent-lens/web` Cordis Surface Plugin；
- React 外 `AgentLensClientModel` + `useSyncExternalStore`；
- 任务复盘高信息密度；
- 用户消息右、智能体左；
- Evidence / 生命周期 / 工具执行 / Turn Rail 保留；
- 会话列表与详情独立滚动；
- 正式普通界面字号下限 12px；
- 运行时 Design Token 与 `docs/design/mockups/v2` 高保真基线校验；
- 关键文字/背景 4.5 对比度门禁。

当前主视图：任务复盘、工具分析、使用洞察、智能体概览、资产备份。

## 5. 资产备份

已实现：

- 基于 Source / Asset Inventory 扫描本机可备份资产；
- 原始 Session / History 数据优先作为备份源；
- 本地不可变 Snapshot；
- Manifest + 文件 SHA-256；
- 导入 / 导出；
- 恢复差异预演；
- 敏感字段、凭据、私钥、符号链接、越界路径默认排除。

当前仍只做到恢复预演，不直接写回用户环境。Hub 未来即使能看到 Remote Asset metadata，也不代表当前资产备份可以访问远程文件。

## 6. npm / Windows Desktop 双发行

当前目标：**双发行、单运行时、共享数据、互斥生命周期**。

已实现：

- npm / CLI 与 Windows Desktop 共用默认数据根、数据库、协议和端口；
- 同一默认数据根同一时刻只允许一个 Daemon；
- Desktop 探测 / 复用已有兼容 Daemon；
- Desktop 只停止自己拥有的 Daemon；
- Windows：当前用户 Task Scheduler；
- Linux：`systemd --user`；
- macOS：用户级 `launchd`；
- 不维护 PID 文件；
- `status / doctor` 同时报告 Daemon 与系统托管状态；
- Windows 后台任务使用隐藏 PowerShell；
- Windows Codex / Claude Native Hook 使用共享 Dispatcher；
- npm / Desktop 陈旧安装登记不得阻塞另一发行方式。

Node Identity 也使用同一个默认 `~/.agent-lens/1.0/` 数据根，因此 npm / Desktop 复用同一 Daemon 时不会生成第二套 Node 身份。

详细规则见 `docs/1.0/DISTRIBUTION-OPERATIONS.md` 和 ADR-0004。

## 7. Hook 边界

Codex / Claude：

```text
Native Hook
 -> source allowlist
 -> passive shim
 -> Durable Inbox
 -> Source.startCapture()
 -> Canonical Pipeline
```

Hermes Observer 使用同一被动语义。

Hook / Observer 不直接写 SQLite、不加载 Cordis/Core、不依赖 HTTP、不阻断上游 Agent。Pi / OpenCode 使用原生 Runtime Tail，不额外安装 Native Hook。

## 8. 当前自动验收基线

主验证链：

```text
npm install --no-audit --no-fund
npm run check:web-presentation
npm run check:desktop-shell
npm run typecheck
npm test
npm run build:dist
```

当前已有自动覆盖包括：

- Source allowlist 默认值 / 显式启用 / 全部关闭；
- 禁用 Source 在 Detect 前过滤；
- Codex Hook 默认关闭门禁；
- OpenCode History / Runtime Tail / Replay；
- Hermes History / Normalize / Assets / Runtime Inbox / Replay；
- Web Design Token 一致性与关键对比度；
- Node Identity 首次创建、重启稳定性、损坏身份 fail-closed；
- 四种 Alpha Profile、非法 Capability 组合、`ctx.node` 注入；
- H2 Entity Scope Registry 与未知实体默认 Node-scoped；
- ReplicaKey 同源稳定性与跨 Node 隔离；
- Git Repository Portable Identity 规范化与本机路径拒绝；
- Project / AssetDefinition Conditional Shared Membership；
- Shared Identity 聚合输入顺序无关、同一 Origin 多 Group 冲突 fail-closed；
- H3 SHA-256 标准向量与 Canonical JSON 对象键顺序稳定；
- H3 Protocol Major / Entity Version fail-closed；
- H3 Handshake Protocol / Identity Algorithm / Entity Version 兼容协商；
- H3 Availability 的真实 null / redacted / omitted 原因区分；
- H3 Project / AssetDefinition Node Wire Scope 与 AgentProduct Shared Ref 约束；
- H3 Entity / Batch / Tombstone semantic hash 防篡改；
- H3 Sequence next / exact retry / reuse conflict / gap；
- H4 metadata-only / redacted / full 字段变换；
- H4 Capture State 单调约束与 full 模式凭据保护；
- H4 redacted Windows/macOS/Linux 用户目录遮蔽；
- H4 from-now 在 Bootstrap / Reconcile 上一致阻断旧历史；
- H4 Minimum Dependency Shape；
- H4 Policy / History Scope transition 不自动回填历史；
- H4 未登记新字段默认拒绝与 not-replicated Entity fail-closed；
- H5 SQLite schema v7 Durable Replication Control Plane 表与 Storage 健康版本；
- H5 Pending 同一 dedup/candidateHash 幂等、冻结前候选替换、冻结后新候选新建；
- H5 Frozen Batch `sequence + batchId + contentHash` exact retry 与 reuse conflict；
- H5 ACK 连续推进、跨 gap 拒绝与文件数据库重启恢复；
- H5 Reconciliation 在 fast-path 漏失时补 Pending 并持久化 page cursor；
- H5 同一 Relationship 保留旧 Stream 并创建 rollover Stream。

H5 最终候选 `908a512c05aeb4ffc084c34cac29a4abd58ccd46` 已通过 Linux / macOS / Windows 三平台主 CI，其中 Windows 同时通过 Desktop package、Smoke、共享 Hook Dispatcher 与 npm lifecycle。

## 9. 仍需实机验收

重点：

- Windows 是否仍有控制台闪现；
- Desktop 登录自启 / 托盘 / 退出；
- npm / Desktop 共存是否只有一个 Daemon；
- Source 默认值和显式启用后的真实 Detect / History / Runtime / Asset；
- Codex / Claude Hook 是否严格跟随 Source 开关；
- 真实 Hermes / OpenCode 数据映射；
- Hermes Observer 延迟 / 稳定性 / Evidence 对账；
- 长会话、工具密集、明暗主题的可读性。

发布仍必须由仓库所有者明确触发；本文不代表 npm Publish / GitHub Release 已完成。

## 10. 多机 Hub

状态：**H1-H11 已实现；当前进入 H12 Tombstone 删除生命周期。Replication Transport、HTTPS、TLS、Pairing 仍未实现且继续延期。**

当前已实现：

- H1 Node Runtime：持久 Node Identity、`standalone / node / hub / pure-hub` Profile 与 capability-driven composition；
- H2 Replication Core：Entity Scope、ReplicaKey、SharedRoot/SharedGroup、Portable Identity；
- H3 R1 Protocol：Handshake、Entity/Batch/Tombstone Wire DTO、Typed Ref、Availability、确定性 Hash、Sequence/ACK 决策；
- H4 Replication Policy / History Boundary：`metadata-only / redacted / full`、`include-existing / from-now`、字段白名单与最小依赖；
- H5 Durable Replication State：Pending、Frozen Batch、ACK、Stream/Generation、Reconciliation 与重启恢复；
- H6 Node Replica Generation：Canonical Change Journal 单调 revision、固定 Bootstrap high-water、持久进度、Canonical -> Wire -> Pending/Frozen、Typed Ref DAG 与跨页依赖闭包；
- H7 Hub Remote Replica Store：SQLite schema v10、staged/active/retired Generation、事务化 R1 Batch Import、Hub 重算 ReplicaKey/SharedKey/Scope、exact retry、连续 ACK 与整批 rollback；
- H8 Unified Read：Local Canonical + active Remote Replica，Remote 使用 opaque ReplicaKey，staged/retired 不可见，Availability 与 public references 保真；
- H9 Availability-aware Hub Review：独立 Hub Review DTO/Projection，`value/null/redacted/omitted` 不强转为 Local 完整 Observation；
- H10 loopback Surface / Remote Review detail：`GET /api/v1/hub/review/:opaquePublicId` 与 `/review/hub/:ReplicaKey`，仍只监听 `127.0.0.1`；
- H11 Remote Session Discovery：`GET /api/v1/hub/review`、Local + active Remote LogicalSession 列表、现有任务复盘左栏直接混排本机/远程会话，并使用轻量 Node 来源标识。

H11 列表筛选保持 fail-closed：Remote Summary 当前没有可靠 source/project/error-status 维度时，不伪造这些筛选结果；时间范围、标题和 Node 搜索只使用已同步且可证明的数据。Remote `redacted/omitted` 继续显式显示，不映射为空字符串、空对象或假时间。

当前仍**没有**实现：

```text
Node -> Hub HTTP/HTTPS Replication Transport
Pairing / TLS / request signatures / serverProof
Remote Web Login / Remote Control
Tombstone Node generation + Hub application lifecycle
Remote file backup / pull
HA / Multi-Hub / Federation
```

H11 最终代码候选 `26e567c00b9c750548327d3eeb9cbb757a05b001` 已通过 Linux / macOS / Windows 主 CI 的 Typecheck、Test 与 Build；Windows 同时通过 Desktop package、Smoke、共享 Hook Dispatcher、npm lifecycle 与 npm package contents。

下一阶段 H12 只补 Tombstone 删除语义和本地 durable/import/read 生命周期，继续不增加新的网络可达面。

长期设计只维护在以下文档：

- `docs/1.0/HUB-DESIGN.md`：Hub 当前有效系统设计；
- `docs/1.0/HUB-REPLICATION-PROTOCOL.md`：R1 长期协议语义；
- `docs/1.0/HUB-PAIRING-SECURITY.md`：配对、安全、数据出站边界；
- `docs/1.0/HUB-OPERATIONS.md`：用户 / 运维生命周期；
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`：关键选择及原因。

跨会话工作状态以 `agent-swe/work-state.yaml` 为准，真实完成情况以代码和测试为准。

## 11. 关键实现不变量

- 默认只启用 Claude Code；其他 Source 显式允许；
- Source 不绕过 Canonical Pipeline；
- Core / Repository / Parser / Normalizer 不依赖 Cordis；
- Projection 不成为第二事实源；
- Web 只消费 Protocol DTO；
- 静态 Asset Discovery 不算 Usage；
- npm / Desktop 不产生第二个默认 Daemon / 数据库 / Node Identity；
- Hook / Observer 被动、fail-open；
- Hub 实现不得破坏 Local-first；
- `pure-hub` 只停止新本机 Source，不删除现有本机历史；
- Replication Identity 不替换本机 Canonical ID；
- Conditional Shared Group 不成为 Project / AssetDefinition 的领域 FK target；
- Wire Entity 不等于 Core Interface 或 SQLite Row；
- Project / AssetDefinition 在 R1 Wire 始终保持 Node Origin；
- Protocol 不兼容只阻塞 Replication，不阻塞本机采集；
- Capture Policy 与 Replication Policy 分离，Replication 不能恢复本机未采集 / 已脱敏内容；
- Replication 新字段默认不出站，必须先进入显式 Field Contract；
- `from-now` History Boundary 对 Reconciliation 同样有效；
- Replication Control Plane 不进入 Canonical Observation，也不成为第二事实源；
- Frozen Batch 的 sequence / batchId / contentHash 不得就地改写；
- Reconciliation 游标只能在整页 Durable Pending 入队成功后推进；
- Hub Remote Replica 不伪造 Local Canonical Fact；
- Hub 不开放 Remote Control。