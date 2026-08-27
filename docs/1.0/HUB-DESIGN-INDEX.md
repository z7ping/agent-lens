# AgentLens 1.0 Hub 设计文档索引

更新日期：2026-08-27  
状态：Alpha 设计收口索引，功能尚未实现

本文只做 Hub 文档导航，不重复定义架构事实。出现冲突时按以下优先级理解：

```text
ADR
 -> Replication Contract / State Contract
 -> Protocol / Security / Data Exposure / Operations
 -> UX / Implementation Plan / Test Matrix
 -> Architecture Summary / Implementation Status
```

## 1. ADR-0007：为什么这样设计

文件：`docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`

负责：

- Local-first；
- Hub = Replica + Aggregator；
- Node / Hub 同一 Runtime；
- 单 Hub 星型拓扑；
- Canonical / Replication Control Plane 分离；
- Shared Root vs Conditional Shared Group；
- 独立 Replication Surface；
- Protocol / Product / Storage Schema 解耦；
- 不做 Remote Execution / Federation / Hub 唯一事实源。

ADR 不承载具体 DTO 字段与运维状态机。

## 2. HUB-REPLICATION-CONTRACT：复制什么、身份怎么映射

文件：`docs/1.0/HUB-REPLICATION-CONTRACT.md`

负责：

- Entity Scope 四分类；
- Replica Key 与独立 Replication Namespace；
- Shared Root；
- Conditional Shared Origin Row + Group Membership；
- Shared Identity Algorithm Version；
- Shared Merge；
- Typed EntityRef；
- Domain Ref Mapping；
- Dependency DAG；
- Shared Assertions / Membership；
- Membership Promotion；
- Tombstone / Assertion Withdrawal / Group GC。

这是 Canonical Replication 数据语义核心。

## 3. HUB-REPLICATION-STATE-CONTRACT：同步状态如何长期保持正确

文件：`docs/1.0/HUB-REPLICATION-STATE-CONTRACT.md`

负责：

- 合法 Capability Profile；
- nodeId / hubId / streamId / generationId 分离；
- History Scope / History Boundary；
- Policy / History Revision；
- immutable Batch / Commit Ambiguity；
- Stream Rollover；
- staged Replica Generation / Re-bootstrap；
- Tombstone / Receipt / Membership Retention；
- Conditional Shared 唯一物理模型；
- Hub 本机参与 Shared Group；
- Remote Generation 与 Membership 原子切换；
- Cross-node Clock / Ordering；
- npm / Desktop 共用 Hub 状态；
- Headless Pure Hub 管理边界。

它与 Replication Contract 同属实现前核心 Contract。

## 4. HUB-REPLICATION-PROTOCOL：线上怎么说话

文件：`docs/1.0/HUB-REPLICATION-PROTOCOL.md`

负责：

- R1 Major / Minor；
- Shared Identity Algorithm Negotiation；
- Pairing Receipt wire binding；
- Handshake + Hub `serverProof`；
- replicationStreamId / replicaGenerationId；
- Batch Envelope；
- Conditional Shared Identity Assertion；
- Policy / History Revision；
- Deterministic Hash；
- Sequence / ACK / Sequence Receipt；
- Commit Ambiguity；
- Stream Rollover；
- Bootstrap / Reconciliation；
- omitted / redacted；
- Stable Remote Error / Local Diagnostic；
- Capability Negotiation；
- Request Signature Input；
- Transport Route；
- Batch / Entity / Resource Limits；
- Clock Skew。

Protocol 不绑定 SQLite Row。

## 5. HUB-PAIRING-SECURITY：谁可以连、如何证明信任

文件：`docs/1.0/HUB-PAIRING-SECURITY.md`

负责：

- Node / Hub / TLS Identity 分离；
- Pairing Secret；
- Node Key Possession；
- Pairing Receipt；
- Hub Identity `serverProof`；
- TLS / SPKI；
- Request Signature；
- Nonce / Timestamp；
- Node Revocation / Key Rotation；
- Clone Detection / runtimeInstanceId；
- 日志 / Backup / At-rest 边界；
- Resource Abuse Protection。

现有 `127.0.0.1:56789` Local Web 总安全边界仍以 `SECURITY.md` 为准。

## 6. HUB-DATA-EXPOSURE-MATRIX：三档 Policy 到底会发哪些字段

文件：`docs/1.0/HUB-DATA-EXPOSURE-MATRIX.md`

负责：

- metadata-only / redacted / full 字段级定义；
- Repository Identity 的敏感性；
- Workspace / executable / configRoot / SourceLocator Path 边界；
- Prompt / Tool / SourceRecord Payload；
- omitted / redacted / null 语义；
- Hub 聚合数据的 At-rest 风险；
- Batch / Entity / Storage Pressure 安全边界。

重要：`metadata-only` 不是匿名模式。

## 7. HUB-OPERATIONS：真实使用生命周期

文件：`docs/1.0/HUB-OPERATIONS.md`

负责：

- 开启 Hub / Pure Hub；
- Capability 切换；
- Pair / Bootstrap / from-now Boundary；
- offline / degraded / paused / blocked；
- backlog；
- Policy 收紧 / 放宽；
- Stream Rollover；
- Reconcile / staged Re-bootstrap；
- Re-pair / Reset Identity；
- Revocation / Delete History；
- Tombstone / Receipt / Membership Retention；
- Upgrade；
- Hub / Node 数据丢失；
- Endpoint / Identity 变化；
- Headless Hub；
- npm / Desktop 共存。

## 8. HUB-UX-CONTRACT：用户应该看到什么

文件：`docs/1.0/HUB-UX-CONTRACT.md`

负责：

- 中文用户术语；
- 不拆 Node / Hub 发行版；
- Hub 开关；
- Pairing；
- Policy + History Scope；
- metadata-only 准确隐私文案；
- Device Status；
- Node Filter；
- Shared Project Group / Workspace 跨机表达；
- Bootstrap / Backlog / Paused；
- Re-bootstrap 不中断现有查询；
- Clock Skew 用户语义；
- 危险操作分离；
- Headless / Remote Web 边界；
- 不提供 Remote Control。

具体页面布局留给高保真阶段。

## 9. HUB-ALPHA-IMPLEMENTATION-PLAN：以后按什么顺序开工

文件：`docs/1.0/HUB-ALPHA-IMPLEMENTATION-PLAN.md`

阶段：

```text
H1 Node Identity / Composition
H2 Replication Core / Shared Group
H3 R1 Protocol / Identity Proof
H4 Policy / History / Outbox / Reconcile
H5 Hub Import / Replica Generation
H6 Security / Surface
H7 E2E Sync
H8 Web / CLI
H9 Delete / Identity / Recovery Ops
H10 Performance / Hardening
```

计划文档不是实现状态。

## 10. HUB-TEST-MATRIX：如何证明实现没有偏离设计

文件：`docs/1.0/HUB-TEST-MATRIX.md`

覆盖：Standalone 回归、Capability / Node Identity、Replica Namespace、Shared Root / Conditional Shared Group、Identity Algorithm、Policy / History Boundary、Pairing / Proof / Signature、Sequence / ACK / Ambiguity、Stream Rollover、Bootstrap / Reconcile / Generation、Tombstone / Membership Retention、Cross-node Clock、Cross-platform、Resource Pressure、Performance / Dogfood、Release Gate。

## 11. CAPTURE-POLICY：本机最多能保存什么

文件：`docs/1.0/CAPTURE-POLICY.md`

```text
Capture Policy -> Local Canonical 上限
Replication Policy -> 在这个上限内继续收紧出站数据
```

具体 Hub 字段暴露以 `HUB-DATA-EXPOSURE-MATRIX.md` 为准。

## 12. SECURITY.md：仓库总安全边界

文件：`SECURITY.md`

负责仓库级安全说明与漏洞报告方式。Hub 专项密码学 / 配对细节由 `HUB-PAIRING-SECURITY.md` 定义。

## 13. ARCHITECTURE.md：总架构摘要

文件：`ARCHITECTURE.md`

只保留 Hub 高层摘要与正式文档链接，不复制全部协议细节。

## 14. IMPLEMENTATION-STATUS：现在到底做了没有

文件：`docs/1.0/IMPLEMENTATION-STATUS.md`

当前必须继续写：

> Hub 架构 / Contract / Protocol / UX / Test 文档已完成实现前收口，但功能尚未实现。

不能因为文档存在就写成“Hub 已支持”。

## 15. 文档修改规则

- 长期架构边界变化：修订 / 新增 ADR；
- Entity Scope、Shared Root/Group、Identity Algorithm、History Boundary、Generation 等变化：修改 Contract，并评估 Protocol Major；
- Wire 变化：修改 Protocol，按 Major / Minor；
- Trust / Security：修改 Pairing / Security 并 Review；
- Field Exposure：修改 Data Exposure Matrix + UX / Capture；
- UI 排布：不改变 Contract 时只改 UX / 高保真。

## 16. 当前冻结边界

截至 2026-08-27，只完成设计 / 文档，不开始 Hub 功能实现。

当前已冻结：

- Local-first / 单 Hub 星型；
- Node Identity + Capability Profile；
- Replica Namespace；
- AgentProduct Shared Root；
- Project / AssetDefinition Origin Row + Shared Group Membership；
- Shared Identity Algorithm Version / Hub Recompute；
- Typed EntityRef；
- Membership Promotion / Assertions / Group GC；
- Replication Policy + Data Exposure；
- History Scope / Boundary；
- Bootstrap + Incremental + Reconciliation；
- Stream / Sequence / ACK / Ambiguity / Rollover；
- Replica Generation / staged Re-bootstrap；
- Pairing / Node Key / Hub Identity Proof；
- TLS / SPKI / Signature / Revocation；
- Control Plane Retention；
- Cross-node Clock / Ordering；
- Hub Local Shared Group participation；
- Headless / 双发行运维边界；
- Alpha 实施顺序与测试门禁。

尚未实现：

```text
Node Identity code
Replication packages
Storage migrations
Pairing / TLS
Wire endpoints
History Boundary / Policy State
Bootstrap / Outbox / Reconcile
Hub Import / Replica Generation
Shared Group / Membership Resolver
Web / CLI Hub UI
Tombstone / Purge
```

这份索引用于下一次接手快速恢复上下文，避免重新讨论已确定问题。
