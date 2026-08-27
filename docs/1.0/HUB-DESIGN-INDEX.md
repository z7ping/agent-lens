# AgentLens 1.0 Hub 设计文档索引

更新日期：2026-08-27  
状态：Alpha 设计收口索引，功能尚未实现

本文是多机 Hub 的文档导航，不重复定义架构事实。出现冲突时，按下列优先级理解：

```text
ADR
 -> Contract
 -> Protocol / Security / Operations
 -> UX / Implementation Plan / Test Matrix
 -> Implementation Status
```

## 1. ADR-0007：为什么这样设计

文件：

`docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`

负责：

- Local-first；
- Hub = Replica + Aggregator；
- Node / Hub 同一 Runtime；
- 单 Hub 星型拓扑；
- Canonical / Replication Control Plane 分离；
- 独立 Replication Surface；
- Protocol / Product / Storage Schema 解耦；
- 不做远程执行 / Federation / 唯一 Hub 事实源。

ADR 只记录长期架构决策，不承载每个 DTO 的字段细节。

## 2. HUB-REPLICATION-CONTRACT：复制什么、身份怎么处理

文件：

`docs/1.0/HUB-REPLICATION-CONTRACT.md`

负责：

- Entity Scope 四分类；
- Replica Key；
- Shared Identity；
- Shared Merge；
- Typed EntityRef；
- Reference Rewrite；
- Dependency DAG；
- Shared Assertions；
- Identity Promotion；
- Alias；
- Tombstone / Assertion Withdrawal。

这是 Hub 数据语义实现的核心 Contract。

## 3. HUB-REPLICATION-PROTOCOL：线上怎么说话

文件：

`docs/1.0/HUB-REPLICATION-PROTOCOL.md`

负责：

- Replication Protocol R1；
- Handshake；
- replicationStreamId；
- Batch Envelope；
- Sequence / ACK；
- Bootstrap / Reconciliation 线上状态；
- Wire Entity Envelope；
- omitted / redacted 值语义；
- Stable Error Code；
- Capability Negotiation；
- Request Signature Input；
- Transport Route；
- Batch 流控。

Protocol 不绑定 SQLite Row。

## 4. HUB-PAIRING-SECURITY：谁可以连、怎么建立信任

文件：

`docs/1.0/HUB-PAIRING-SECURITY.md`

负责：

- Node Identity / Hub Identity / TLS Identity 分离；
- Pairing Secret；
- Node Key；
- Hub Key；
- TLS / SPKI Pinning；
- Request Signature；
- Nonce / Timestamp 重放保护；
- Node Revocation；
- Key Rotation；
- Clone Detection；
- 私钥 / 日志 / Backup 安全边界。

现有 `127.0.0.1:56789` Local Web 安全边界仍以 `SECURITY.md` 为准。

## 5. HUB-OPERATIONS：真实使用生命周期

文件：

`docs/1.0/HUB-OPERATIONS.md`

负责：

- 开启 Hub / Pure Hub；
- Pair / Bootstrap / Incremental；
- offline / degraded / blocked；
- backlog；
- Reconcile / Re-bootstrap；
- Re-pair；
- Node Identity Reset；
- Revocation；
- 删除 Node 历史；
- Policy 变更；
- Upgrade 顺序；
- Hub / Node 数据丢失；
- Endpoint / Identity 变化。

## 6. HUB-UX-CONTRACT：用户应该看到什么

文件：

`docs/1.0/HUB-UX-CONTRACT.md`

负责：

- 中文用户术语；
- 不拆 Node 版 / Hub 版；
- Hub 开关；
- Pairing 交互；
- Replication Policy 文案；
- 设备状态；
- Task Review Node Filter；
- Project / Workspace 跨机表达；
- Bootstrap / backlog 显示；
- 危险操作分离；
- 删除历史预演；
- 不提供远程控制。

本文不锁死是否新增一级导航，具体布局留给高保真阶段。

## 7. HUB-ALPHA-IMPLEMENTATION-PLAN：以后按什么顺序开工

文件：

`docs/1.0/HUB-ALPHA-IMPLEMENTATION-PLAN.md`

负责：

```text
H1 Node Identity / Composition
H2 Replication Core
H3 Wire Protocol
H4 Policy / Outbox / Reconcile
H5 Hub Import
H6 Security / Surface
H7 E2E Sync
H8 Web / CLI
H9 Delete / Identity Ops
H10 Performance / Hardening
```

计划文档不是实现状态，不能把某个 H 阶段写在这里就当作已完成。

## 8. HUB-TEST-MATRIX：如何证明实现没有偏离设计

文件：

`docs/1.0/HUB-TEST-MATRIX.md`

负责：

- Standalone 回归；
- Node Identity；
- Entity Scope / Replica Key；
- Shared Merge / Promotion；
- Policy；
- Protocol / ACK；
- Bootstrap / Reconcile；
- Pairing / TLS / Signature；
- Revocation / Reset；
- Cross-platform；
- Failure Injection；
- Performance；
- Real-machine Dogfood；
- Release Gate。

## 9. CAPTURE-POLICY：本机能保存什么、Hub 能发什么

文件：

`docs/1.0/CAPTURE-POLICY.md`

负责：

```text
Capture Policy
  -> 哪些数据能进入本机 Canonical Store

Replication Policy
  -> 本机已有数据中哪些能离开本机
```

Hub 不能恢复 Capture 已经 off / redacted 的信息。

## 10. SECURITY.md：仓库总安全边界

文件：

`SECURITY.md`

负责仓库级安全说明和漏洞报告方式。

Hub 实现后需要确保这里持续说明：

- Local Surface 仍 loopback；
- Replication Surface 独立 authenticated HTTPS；
- 私钥 / Pairing Secret 不进入 Canonical / 普通日志 / Backup；
- Remote Web 不是 Replication Surface 的副作用。

## 11. ARCHITECTURE.md：总架构摘要

文件：

`ARCHITECTURE.md`

只保留 Hub 的高层架构摘要并链接 ADR / Contract，不应复制所有协议细节。

如果某个实施细节与 ADR / Contract 冲突，应修实现或修正式决策文档，而不是在 ARCHITECTURE.md 单独创造第三种说法。

## 12. IMPLEMENTATION-STATUS：现在到底做了没有

文件：

`docs/1.0/IMPLEMENTATION-STATUS.md`

当前必须继续写：

> Hub 架构与 Contract 已确定，但功能尚未实现。

未来每完成一个阶段再按事实更新。

不要因为已经存在 Wire DTO 文档、Pairing 文档或测试矩阵就写成“Hub 已支持”。

## 13. 文档修改规则

后续若改变：

### 长期架构边界

例如：

- 从单 Hub 改多 Hub；
- 改成 Hub 唯一事实源；
- 增加远程控制；
- 改双向同步；

必须新 ADR 或正式修订 ADR-0007。

### Canonical Replication 语义

例如：

- 某 Entity 从 Node-scoped 改 Shared；
- Shared Identity / Merge 改变；
- Promotion / Tombstone 语义改变；

修改 Replication Contract，并评估 Protocol Major。

### Wire 兼容变化

修改 Replication Protocol，并按 Major / Minor 规则处理。

### 配对 / 信任变化

修改 Pairing / Security，并做安全 Review。

### UI 排布

不影响上述 Contract 时，只需修改 UX / 高保真，不升级 ADR。

## 14. 当前冻结边界

截至 2026-08-27，今天只完成设计 / 文档收口，不开始 Hub 功能实现。

已经冻结：

- Local-first；
- Node 身份与 Hub capability 模型；
- 单 Hub 星型拓扑；
- Replica / Shared / Conditional Shared；
- Typed EntityRef；
- Shared Merge / Promotion / Assertions；
- Bootstrap + Incremental + Reconciliation；
- R1 Sequence / ACK 基本模型；
- Pairing / TLS / Key / Revocation 安全边界；
- Replication Policy；
- 运维生命周期；
- Alpha 实施顺序与测试门禁。

尚未实现：

```text
Node Identity code
Replication packages
Storage migrations
Pairing / TLS
Wire endpoints
Bootstrap / Outbox
Hub Import
Web / CLI Hub UI
Tombstone / Purge
```

这份索引用于下一次接手时快速恢复上下文，避免重新讨论已经确定的问题。
