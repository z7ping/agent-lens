# AgentLens 1.0 Alpha 实现状态

更新日期：2026-08-27

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
- Node Runtime 通过 Cordis `ctx.node` 统一暴露 `dataRoot / identity / profile / capabilities`，后续 Runtime Plugin 不自行重复读取身份文件；
- `AGENT_LENS_PROFILE` 当前支持 `standalone / node / hub / pure-hub` 四种 Alpha Profile，默认保持 `standalone`；
- Daemon Composition Root 按 `localCapture` 决定是否注册本机 Source；`pure-hub` 不注册本机 Source，但仍保留 Storage / Projection / Local Web；
- Hub H2 Replication Core 通过 `@agent-lens/core/replication` 子路径暴露，不进入默认 Core Domain 导出；
- H2 已实现 Replication Entity Scope Registry，未知实体默认 `node-scoped`；
- H2 已实现 `agentlens-replica-r1` ReplicaKey、SharedRootKey / SharedGroupKey 的确定性纯函数；
- H2 已实现 `project-repository-v1` / `asset-upstream-v1` Portable Identity 规范化；只有可靠跨机身份才能建立 Conditional Shared Membership；
- H2 已实现 AgentProduct Shared Root、Project / AssetDefinition Shared Group / Membership 的内存级确定性聚合与冲突拒绝；Origin Identity / ReplicaKey 保持独立，不改写本机领域引用；
- H2 确定性哈希为纯 TypeScript SHA-256，不依赖 Cordis、SQLite、Transport 或 Node `crypto`。

H1/H2 只建立 Node Runtime 与 Replication Identity 基础，`node / hub / pure-hub` 当前**不会**启动 Replication 网络行为，也没有 Remote Replica Store。

禁止恢复 0.x Adapter / Importer Runtime、旧 `timeline / overview_*` 规范表、旧 Service Manager / PID 架构。

## 2. Sources

当前已经作为独立 Cordis Source Plugin 注册到 Daemon：

- Claude Code；
- Codex；
- Pi；
- Hermes；
- OpenCode。

默认只启用 Claude Code。其他来源必须显式加入：

```text
AGENT_LENS_ENABLED_SOURCES
```

`none` 可以关闭全部来源。

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
- 可选 `agent-lens-observer` 只写 Durable Inbox，形成额外 Runtime Evidence；
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
- 带版本的 `@agent-lens/protocol` DTO。

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

Local Surface 继续只监听 loopback。

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

当前主视图：

- 任务复盘；
- 工具分析；
- 使用洞察；
- 智能体概览；
- 资产备份。

## 5. 资产备份

已实现：

- 基于 Source / Asset Inventory 扫描本机可备份资产；
- 原始 Session / History 数据优先作为备份源；
- 本地不可变 Snapshot；
- Manifest + 文件 SHA-256；
- 导入 / 导出；
- 恢复差异预演；
- 敏感字段、凭据、私钥、符号链接、越界路径默认排除。

当前仍只做到恢复预演，不直接写回用户环境。

Hub 未来即使能看到 Remote Asset metadata，也不代表当前资产备份可以访问远程文件。

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

Hook / Observer 不直接写 SQLite、不加载 Cordis/Core、不依赖 HTTP、不阻断上游 Agent。

Pi / OpenCode 使用原生 Runtime Tail，不额外安装 Native Hook。

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
- Web Design Token 一致性；
- Web 关键前景/背景对比度；
- Node Identity 首次创建与重启稳定性；
- 损坏 Node Identity fail-closed；
- 四种 Alpha Profile 与非法 Capability 组合；
- `ctx.node` Runtime Service 注入；
- H2 Entity Scope Registry 与未知实体默认 Node-scoped；
- ReplicaKey 同源稳定性与跨 Node 隔离；
- SHA-256 标准向量；
- Git Repository Portable Identity 规范化与本机路径拒绝；
- Project / AssetDefinition Conditional Shared Membership；
- Shared Identity 聚合输入顺序无关、同一 Origin 多 Group 冲突 fail-closed。

本文不把未重新核验的 CI 状态写成“已通过”。

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

状态：**长期设计已冻结；H1 Node Runtime 与 H2 Replication Core / Shared Identity 已实现，H3+ 尚未实现。**

当前已实现基础：

```text
~/.agent-lens/1.0/node.json
 -> persistent random nodeId
 -> runtime profile / capabilities
 -> Cordis ctx.node
 -> Daemon capability-driven Source composition

@agent-lens/core/replication
 -> Entity Scope Registry
 -> ReplicaKey / SharedKey
 -> Portable Identity
 -> Shared Root / Shared Group / Membership
```

H2 仍只是纯内存 / 纯函数 Replication Domain 基础，不表示 Hub 已能接收或保存远端数据。

当前仍**没有**实现：

```text
Node long-term key material
R1 Wire DTO / Schema / protocol negotiation
Replication Policy / History Boundary
Durable Replication state / Outbox / Reconciliation
R1 network endpoints
Pairing / TLS / signatures
Remote Replica Store / migrations / transactional import
Shared Identity persistence / import integration
Replica Generation
Unified Read Repository
Hub-aware Projection / Web / CLI
Tombstone / Purge / recovery operations
```

长期设计只维护在以下文档：

- `docs/1.0/HUB-DESIGN.md`：Hub 当前有效系统设计；
- `docs/1.0/HUB-REPLICATION-PROTOCOL.md`：R1 长期协议语义；
- `docs/1.0/HUB-PAIRING-SECURITY.md`：配对、安全、数据出站边界；
- `docs/1.0/HUB-OPERATIONS.md`：用户 / 运维生命周期；
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`：关键选择及原因。

当前下一步不在本文维护阶段清单；跨会话工作状态以 `agent-swe/work-state.yaml` 为准，真实完成情况以代码和测试为准。

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
- Hub Remote Replica 不伪造 Local Canonical Fact；
- Hub 不开放 Remote Control。
