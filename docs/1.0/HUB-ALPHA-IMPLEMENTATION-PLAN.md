# AgentLens 1.0 Hub Alpha 实施计划

更新日期：2026-08-27  
状态：计划文档，今天不实施  
上位文档：
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-STATE-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-PROTOCOL.md`
- `docs/1.0/HUB-PAIRING-SECURITY.md`
- `docs/1.0/HUB-DATA-EXPOSURE-MATRIX.md`
- `docs/1.0/HUB-OPERATIONS.md`

本文把 Hub 架构拆成可独立验收的实施阶段。每阶段都要求 Standalone 行为不变，不允许为了 Hub 绕过 Core Contract、Repository、Capture Policy、Projection 或 Cordis Runtime。

## 1. Alpha 目标

```text
1 Hub
N trusted Nodes
single user
Local-first
Node -> Hub one-way canonical replication
Hub unified read-only aggregation
```

不扩：多 Hub / HA / Federation、Team / RBAC、远程执行、Hub -> Node 双向同步、内建 Remote Web、PostgreSQL/Redis/Kafka。

## 2. 实施护栏

1. 无 Hub 配置时行为与当前 1.0 一致；
2. Node / Hub 是同一 AgentLensApplication 能力组合；
3. 只允许四个合法 Capability Profile；
4. Core / Repository / Protocol 不依赖 Cordis；Runtime Extension 使用 Cordis-native Plugin；
5. Local `/api/v1/*` 继续 loopback；
6. Replication Metadata 不进入 Canonical Observation；
7. Projection 不成为同步事实源；
8. Policy 与 History Scope 分离；
9. Hub 不重新解析 Source；
10. Hub Identity 必须参与 Pairing Receipt / Handshake Proof；
11. Conditional Shared 固定采用 Origin Row + Shared Group Membership，不做批量 FK Rewrite；
12. 不发布 npm / Release，除非仓库所有者明确要求。

## 3. 建议模块边界

```text
packages/
  node-identity/
  replication-protocol/
  replication-policy/
  replication-core/
  replication-client/
  replication-server/
  surface-replication/
```

职责：

- `replication-core`：Scope、ReplicaKey、EntityRef、Shared Root、Conditional Shared Group、Membership、Promotion；
- `replication-client`：Handshake、Bootstrap、Outbox、Reconcile、History Boundary、Retry；
- `replication-server`：Import、Registry、Cursor、Receipt、Generation、Shared Group、Conflict；
- `surface-replication`：HTTPS、Pairing、Auth、Resource Limit；
- Control Plane Repository 通过正式 Contract 访问，不让 Web 查私表；
- npm / Desktop 共用同一 Node / Hub Identity 和 Replication Config。

## 4. H0：文档与测试护栏

当前完成：ADR、Replication Contract、State Contract、R1 Protocol、Pairing/Security、Data Exposure Matrix、Operations、UX、Test Matrix、本计划与文档索引。

退出条件：

> 关键实现问题都有正式 Contract 和测试入口，发现结构性缺口先修文档。

## 5. H1：Node Identity + Capability Composition

内容：

- 持久 nodeId；
- Node Key 存储边界；
- runtimeInstanceId；
- localCapture / replicationUpstream / hubAccept；
- 四合法 Profile 校验；
- Composition Root 按能力装配；
- 不修改现有 Host ID。

验收：Standalone 回归、nodeId 稳定、Pure Hub 不启动 Source、非法组合失败、npm/Desktop 共用身份。

## 6. H2：Replication Core Contract

目标：单进程证明 Node Canonical Graph 可确定性映射到 Hub Aggregation Graph。

内容：

- Entity Scope Registry；
- ReplicaKey；
- Typed EntityRef；
- Repository Identity Normalizer；
- Asset Portable Identity Resolver；
- Shared Root Merge；
- Conditional Shared Group / Assertion / Membership；
- Membership Promotion；
- Hub-local Membership；
- Dependency DAG；
- Wire serializer / deserializer；
- payload 不重写门禁。

关键验收：

- 两 Node 相同本机 Host ID 不碰撞；
- 同 Git Remote SSH/HTTPS -> 同 Shared Project Group；
- 路径项目不误合并；
- Hub Local + Remote -> 同 Group；
- Promotion 不修改 origin FK；
- Project/Asset Domain Ref 永远指 origin row；
- Batch 到达顺序不改变 Group Merge。

风险：高。这里未稳定前不做 UI。

## 7. H3：R1 Wire Protocol + Identity Proof

内容：

- Major/Minor；
- Pairing Receipt；
- Handshake + serverProof；
- Stream / Generation；
- Batch Envelope；
- Policy / History Revision；
- deterministic Canonical JSON Hash；
- Sequence / ACK / Receipt；
- Commit Ambiguity；
- Stream Rollover；
- Stable Error / Local Diagnostic；
- Capability Negotiation；
- ReplicatedValue；
- Signature Input；
- Conditional Shared `sharedIdentity` assertion。

验收：版本协商、Proof、Header Signature、Sequence retry/gap/conflict、ambiguous commit、old/new stream、Conditional Shared scope 门禁。

## 8. H4：Policy + History Boundary + Local Durable State

内容：

- metadata-only / redacted / full；
- Field Exposure Matrix；
- outbound sanitizer；
- from-now / include-existing；
- History Boundary / revision；
- Dependency Closure；
- Policy Revision；
- State Repository / pending hash；
- Durable Outbox / immutable batch；
- Reconciliation；
- Tombstone foundation；
- Policy expand/shrink。

关键验收：Fast Path 丢失后 Reconcile 补齐；from-now 不被扫描绕过；Policy 收紧 ambiguous Batch 通过 Rollover 恢复。

## 9. H5：Hub Replication Storage / Remote Import

内容：

- Node Registry / Pairing Relationship；
- Stream / Cursor / Sequence Receipt；
- Replica Generation active/staged/retired；
- Replica Entity Map；
- Shared Root Assertion；
- Conditional Shared Group / Membership / Promotion provenance；
- Hub-local Membership；
- Replication Conflict；
- Tombstone；
- Transactional Remote Import；
- dependency-safe origin Ref resolution；
- Control Plane Retention / GC。

**不实现：** Conditional Shared `ReplicaKey -> SharedKey` 主键 Alias 和批量 FK Rewrite。

验收：

- Batch 全成功才 ACK；
- duplicate idempotent；
- Sequence Receipt 防 reuse；
- Promotion 只改变 Membership；
- origin FK 不变；
- withdrawal 不误删其他 member；
- staged Generation 失败不影响 active；
- Generation 激活原子切换该 Node origin/membership set。

风险：最高。

## 10. H6：Pairing + TLS + Authenticated Surface

内容：Hub Identity、Node Public Key、Pair Secret、nodeProof、Pairing Receipt、自管理/用户 TLS、SPKI Pinning、serverProof、Request Signature、Nonce/Timestamp、Revoke、Stream Freeze/Rollover、Body/Entity/Rate/Concurrency/Storage limits。

验收：未配对/已撤销拒绝、TLS/Proof/Signature/Replays 正确、超大请求不 OOM、Local Surface 分离。

## 11. H7：Bootstrap + Incremental + Generation E2E

场景：

```text
existing Node -> Pair -> Bootstrap -> Reconcile -> Incremental
from-now -> new facts + dependency closure only
re-bootstrap -> staged generation -> activate
Node A + Node B + Hub Local -> Shared Project Group
```

验收：中断恢复、持续采集、backlog、from-now、Re-bootstrap 失败保护、Group Membership 收敛。

## 12. H8：Projection Scope + Web / CLI

内容：

- Node / Host filter；
- stable cross-node ordering；
- clock skew diagnostics；
- Session / Usage / Overview 跨 Node 聚合；
- Shared Project Group -> member Workspaces；
- Shared Asset Group；
- Node / Sync Status DTO；
- Hub / Pair / Policy / History UI；
- Bootstrap / backlog / paused / blocked；
- Headless Pure Hub CLI。

Projection 必须通过 Repository / Shared Group Resolver，不直接查询 Control Plane SQLite 私表。

## 13. H9：Delete / Purge / Identity / Recovery

- Origin Tombstone；
- Shared Root Assertion Withdrawal；
- Conditional Membership Withdrawal；
- Tombstone Retention；
- Delete Node History Preview；
- Revoke / Delete 分离；
- Identity Reset；
- Re-pair / Rollover / Re-bootstrap；
- Generation GC；
- Conflict diagnostics；
- Hub recovery。

## 14. H10：性能 / 容量 / 故障注入

基线：2/5/10 Nodes；100k/1m/5m+ Observations。

指标：Bootstrap、steady-state delay、batch transaction、reconcile、unified query、SQLite contention、batch size、generation disk amplification、receipt/control-plane size、Shared Group membership resolve latency。

故障：ACK lost、duplicate/gap、transaction failure、Node/Hub crash、TLS/proof mismatch、clock skew、cloned nodeId、membership conflict、Policy change during ambiguous Batch、disk pressure、staged Generation failure。

优化仍遵守 ADR-0006。

## 15. CI / 测试层次

```text
Unit
  ReplicaKey / Normalizer / Shared Group / Policy / History / Hash / Signature
Contract
  Wire DTO / EntityRef / Membership / Protocol / Pairing Receipt
Storage Integration
  Import / rollback / assertions / memberships / generations / retention
In-process E2E
  Node Store -> Batch -> Hub Store
Network E2E
  Pair -> TLS -> Handshake -> Bootstrap -> ACK
Cross-platform
  Windows / Linux / macOS identity + path + key permissions
```

## 16. Alpha 完成定义

必须同时满足：

- Standalone 无回归；
- 非法 Capability 被拒绝；
- 2+ Nodes 稳定汇聚；
- Local-first 离线不丢事实；
- History / Policy 边界有效；
- Bootstrap / Reconcile 收敛；
- Stream Rollover / Generation 闭环；
- ReplicaKey / Shared Root / Shared Group Membership 幂等；
- Conditional Shared Promotion 不改 origin FK；
- Hub Local / Remote Shared Project 汇聚；
- Pairing/TLS/Proof/Revoke 安全闭环；
- Web 支持多机聚合；
- 不开放 Remote Control；
- 文档与实现状态同步；
- 三平台自动化 + 真实多机 dogfood。

## 17. 推荐顺序

```text
H1 Identity / Composition
 -> H2 Replication Core / Shared Group
 -> H3 R1 Protocol / Identity Proof
 -> H4 Policy / History / Outbox / Reconcile
 -> H5 Hub Import / Generation
 -> H6 Security / Surface
 -> H7 E2E
 -> H8 Web / CLI
 -> H9 Delete / Recovery
 -> H10 Hardening
```

不要先做“POST JSON 到 Hub”的 Demo 再倒补 Identity / Policy / Shared Group / Security。
