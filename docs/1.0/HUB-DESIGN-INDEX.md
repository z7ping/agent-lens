# AgentLens 1.0 Hub 设计文档索引

更新日期：2026-08-27  
状态：**Alpha 设计冻结，功能尚未实现**

本文只做 Hub 文档导航，不重复定义架构事实。

出现冲突时按以下优先级理解：

```text
ADR-0007
 -> Replication Contract / State Contract / Replica Storage Contract
 -> Replication Protocol / Pairing Security / Data Exposure
 -> Operations / UX
 -> Implementation Plan / Test Matrix
 -> ARCHITECTURE.md Summary / IMPLEMENTATION-STATUS.md
```

任何实现若与更高优先级 Contract 冲突，应先修文档，不允许用代码行为反向覆盖 Contract。

## 1. ADR-0007：为什么这样设计

文件：`docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`

负责：

- Local-first；
- Hub = Replica + Aggregator；
- Node / Hub 同一 Runtime；
- 单 Hub 星型拓扑；
- Local Canonical / Remote Replica / Control Plane 边界；
- 独立 Replication Surface；
- trusted-node 安全模型；
- Product / Protocol / Storage Schema 解耦；
- 不做 Remote Execution / Federation / Hub 唯一事实源。

ADR 不承载全部 DTO / SQL 字段。

## 2. HUB-REPLICATION-CONTRACT：复制什么、身份如何映射

文件：`docs/1.0/HUB-REPLICATION-CONTRACT.md`

负责：

- Entity Scope：Shared / Conditional Shared / Node-scoped / Not Replicated；
- ReplicaKey；
- Shared Root / Conditional Shared Group；
- Shared Identity Algorithm；
- Typed EntityRef；
- Reference Rewrite；
- Dependency DAG；
- Shared Assertions / Membership；
- Identity Promotion；
- Tombstone / Assertion Withdrawal。

核心原则：Project / AssetDefinition 保留 Origin，Promotion 只建立 Membership，不 Rewrite 领域 FK。

## 3. HUB-REPLICATION-STATE-CONTRACT：同步状态如何长期保持正确

文件：`docs/1.0/HUB-REPLICATION-STATE-CONTRACT.md`

负责：

- 合法 Capability Profile；
- nodeId / hubId / streamId / generationId；
- History Scope / Boundary；
- Policy / History Revision；
- immutable Batch / Commit Ambiguity；
- Stream Rollover；
- staged Replica Generation；
- Tombstone / Receipt / Membership Retention；
- Hub Local Shared Membership；
- Cross-node Clock；
- npm / Desktop 共用 Hub State；
- Headless Pure Hub。

## 4. HUB-REPLICA-STORAGE-CONTRACT：Hub 物理存储必须表达什么

文件：`docs/1.0/HUB-REPLICA-STORAGE-CONTRACT.md`

负责实现前最后发现的物理存储边界：

```text
one Hub Storage Boundary / one default SQLite
├─ Local Canonical Store
├─ Remote Replica Store
├─ Shared Identity State
├─ Replication Control Plane
└─ Unified Read Repository
```

负责：

- 为什么 Remote Replica 不能强塞现有 Local Canonical SQL Row；
- `value / redacted / omitted` 的原生持久化；
- `history-boundary / dependency-minimized`；
- full / redacted / metadata-only 走同一 Remote Replica Storage Contract；
- retained prior value；
- staged Generation；
- Unified Read Repository；
- Projection 字段 availability；
- Local Canonical invariant 不因可选 Hub 被全局 nullable 化。

这是 H5 Storage / H8 Unified Read 的权威 Contract。

## 5. HUB-REPLICATION-PROTOCOL：线上怎么说话

文件：`docs/1.0/HUB-REPLICATION-PROTOCOL.md`

负责：

- R1 Major / Minor；
- Identity Algorithm Version；
- Pairing Receipt / Handshake serverProof；
- Stream / Generation；
- Batch Envelope；
- Sequence / ACK / Commit Ambiguity；
- deterministic hash；
- Shared Identity Assertion + Hub 重算；
- Typed EntityRef；
- ReplicatedValue availability；
- Bootstrap / Reconcile；
- Stream Rollover；
- Tombstone；
- Stable Error；
- Request Signature；
- Resource Limit；
- Remote Unified Entity ID。

Protocol 不绑定 SQLite Row。

## 6. HUB-PAIRING-SECURITY：谁可以连、信任如何建立

文件：`docs/1.0/HUB-PAIRING-SECURITY.md`

负责：

- Node / Hub / TLS Identity 分离；
- Pairing Secret；
- Node Key Possession；
- Pairing Receipt；
- Hub `serverProof`；
- TLS / SPKI；
- Request Signature；
- Nonce / Timestamp；
- Revocation / Key Rotation；
- Clone Detection；
- trusted-node 真实性边界；
- 日志 / Backup / At-rest；
- Resource Abuse Protection。

重要：Node Signature 证明“谁发的”，不证明已攻陷 Node 的事实内容真实。

## 7. HUB-DATA-EXPOSURE-MATRIX：三档 Policy 到底会发什么

文件：`docs/1.0/HUB-DATA-EXPOSURE-MATRIX.md`

负责：

- metadata-only / redacted / full；
- Repository / Asset Portable Identity；
- Workspace / executable / configRoot / Locator path；
- Prompt / Tool / SourceRecord payload；
- `value / redacted / omitted / real null`；
- `history-boundary / dependency-minimized`；
- retained prior value；
- Hub At-rest 风险。

重要：`metadata-only` 不是匿名模式。

## 8. HUB-OPERATIONS：真实使用生命周期

文件：`docs/1.0/HUB-OPERATIONS.md`

负责：

- 开启 Hub / Pure Hub；
- Pair / from-now / include-existing；
- Bootstrap / backlog；
- offline / degraded / paused / blocked；
- Policy 收紧 / 放宽；
- Stream Rollover；
- Reconcile / Re-bootstrap；
- Re-pair / Reset Identity；
- Revocation / Delete History；
- Upgrade / Recovery；
- Endpoint / Identity 变化；
- Headless Hub；
- npm / Desktop 共存。

## 9. HUB-UX-CONTRACT：用户应该看到什么

文件：`docs/1.0/HUB-UX-CONTRACT.md`

负责：

- 中文用户术语；
- 不拆 Node / Hub 发行版；
- Pairing；
- Policy + History Scope；
- Device Status；
- Node Filter；
- Project / Workspace 跨机表达；
- Bootstrap / Backlog / Paused；
- Re-bootstrap；
- Clock Skew；
- 危险操作分离；
- Headless / Remote Web 边界；
- 不提供 Remote Control。

具体页面布局等高保真阶段再定。

## 10. HUB-ALPHA-IMPLEMENTATION-PLAN：以后怎么开工

文件：`docs/1.0/HUB-ALPHA-IMPLEMENTATION-PLAN.md`

冻结顺序：

```text
H1 Node Identity / Composition
H2 Replication Core / Shared Identity
H3 R1 Protocol / Identity Proof
H4 Policy / History / Outbox / Reconcile
H5 Remote Replica Storage / Hub Import / Generation
H6 Security / Replication Surface
H7 E2E Sync
H8 Unified Read / Projection / Web / CLI
H9 Delete / Identity / Recovery Ops
H10 Performance / Hardening
```

计划文档不是实现状态。

## 11. HUB-TEST-MATRIX：如何证明实现没偏离设计

文件：`docs/1.0/HUB-TEST-MATRIX.md`

必须覆盖：

- Standalone 回归；
- Node Identity / Capability；
- Replica / Shared Group；
- Remote Replica Storage availability；
- Local ID / Remote ReplicaKey 不碰撞；
- from-now Dependency-Minimized Shape；
- Policy / History Boundary；
- Pairing / Hub Proof / Signature；
- Sequence / ACK / Commit Ambiguity；
- Stream Rollover；
- Bootstrap / Reconcile / Generation；
- Tombstone / Retention；
- Cross-node Clock；
- Resource Pressure；
- Performance / Soak / Dogfood。

## 12. CAPTURE-POLICY：本机最多能保存什么

文件：`docs/1.0/CAPTURE-POLICY.md`

```text
Capture Policy
 -> Local Canonical 上限

Replication Policy
 -> 在这个上限内继续收紧出站数据
```

## 13. SECURITY.md：仓库总安全边界

文件：`SECURITY.md`

Hub 专项密码学 / Pairing 由 `HUB-PAIRING-SECURITY.md` 负责；不能因此改变现有 Local Surface loopback 边界。

## 14. ARCHITECTURE.md：总架构摘要

只保留高层摘要。摘要中的 “Hub Unified Store” 必须解释为本文的 **统一 Storage Boundary + Unified Read Surface**，不是“Remote Replica 必须直接写进现有 Local Canonical 表”。

## 15. IMPLEMENTATION-STATUS：现在到底做了没有

文件：`docs/1.0/IMPLEMENTATION-STATUS.md`

当前必须继续写：

> Hub ADR / Contract / Protocol / Storage / Security / UX / Test 已冻结，但功能尚未实现。

不能因为文档存在就写成“Hub 已支持”。

## 16. 文档修改规则

### 长期架构边界变化

单 Hub -> 多 Hub、增加 Remote Control、双向同步、改变 Local-first：修订 ADR 或新增 ADR。

### Canonical / Replica / State 语义变化

Entity Scope、ReplicaKey、Shared Group、History Boundary、Generation、Storage availability：修改对应 Contract，并评估 Protocol Major。

### Wire 变化

修改 Replication Protocol，按 Major / Minor / Identity Algorithm Version 处理。

### Trust / Security

修改 Pairing / Security，并执行安全 Review。

### Field Exposure

修改 Data Exposure + Storage + Protocol + UX，不能只改页面文案。

### UI 排布

不改变 Contract 时只改 UX / 高保真。

## 17. 设计冻结边界

截至 2026-08-27，Hub Alpha **只完成架构与文档设计，不开始功能实现**。

已冻结：

- Local-first / 单 Hub 星型拓扑；
- Node Identity / Capability Profile；
- ReplicaKey 与保留 Remote ID namespace；
- Shared Root / Conditional Shared Group；
- Typed EntityRef；
- Shared Identity Algorithm Version + Hub 重算；
- Policy + History Scope；
- `from-now` Dependency-Minimized Closure；
- Bootstrap + Incremental + Reconciliation；
- Stream / Sequence / ACK / Commit Ambiguity / Rollover；
- Replica Generation；
- Local Canonical / Remote Replica 分层；
- ReplicatedValue availability / retained prior value；
- Unified Read Repository；
- Pairing / TLS / Node Proof / Hub Proof / Signature / Revocation；
- trusted-node 边界；
- Cross-node Clock；
- Headless / 双发行边界；
- H1-H10 实施顺序与测试门禁。

尚未实现：

```text
Node Identity code
Replication packages
Remote Replica Storage / migrations
Unified Read Repository
Pairing / TLS
Wire endpoints
History Boundary / Policy State
Bootstrap / Outbox / Reconcile
Hub Import / Replica Generation
Hub Projection adaptation
Web / CLI Hub UI
Tombstone / Purge
```

下一次接手应从本索引进入，不重新讨论已冻结问题；如果实现过程中出现新的结构性冲突，先返回对应 Contract 修订。