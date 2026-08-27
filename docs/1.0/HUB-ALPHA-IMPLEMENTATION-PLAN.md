# AgentLens 1.0 Hub Alpha 实施计划

更新日期：2026-08-27  
状态：设计冻结，今天不实施  
上位入口：`docs/1.0/HUB-DESIGN-INDEX.md`

本文只定义以后开工顺序与退出条件。每个阶段必须保持 Standalone 行为不变，不允许为了 Hub 绕过 Core Contract、Repository、Capture Policy、Projection 或 Cordis Runtime。

## 1. Alpha 目标

```text
1 Hub
N trusted Nodes
single user
Local-first
Node -> Hub one-way canonical-state replication
Hub unified read-only aggregation
```

不包含：多 Hub / HA / Federation、Team / RBAC、Remote Agent/Shell、Hub -> Node Canonical Sync、内建 Remote Web Login、PostgreSQL/Redis/Kafka 前置基础设施。

## 2. 实施护栏

1. 无 Hub 配置时与当前 1.0 行为一致；
2. Node / Hub 是同一 AgentLensApplication 的能力组合；
3. Alpha 不允许 `hubAccept + replicationUpstream`；
4. Core / Repository / Protocol 不依赖 Cordis；Runtime Extension 使用 Cordis-native Plugin；
5. Local `/api/v1/*` 继续 loopback；
6. Replication Metadata 不进入 Canonical Observation；
7. Projection 不成为同步事实源；
8. Local Canonical Schema 不为 Hub 被迫全局 nullable；
9. Remote Replica 不能使用假值填补 Policy / History omission；
10. Shared / Replica / Policy / History / Security 先有 Contract 再写实现；
11. 不发布 npm / Release，除非仓库所有者明确要求。

## 3. 建议模块边界

```text
packages/
  node-identity/
  replication-protocol/
  replication-policy/
  replication-core/
  replication-client/
  replication-server/
  replica-storage/           # Remote Replica / Shared Identity / Control Plane repositories
  unified-read/              # Local + Remote + Shared resolver 的读边界
  surface-replication/
```

最终包名可以微调，但职责不能混：

- `replication-core`：Scope / ReplicaKey / Shared Identity / Membership / DAG；
- `replication-protocol`：Wire / version / hash / signature / errors；
- `replica-storage`：Remote Replica Data Plane、Generation、Control Plane；
- `unified-read`：给 Projection 的正式统一读取面；
- `surface-replication`：HTTPS / Auth / Resource Limits，不实现 Canonical 业务语义。

## 4. H0：文档与测试护栏

已完成并冻结：

- ADR-0007；
- Replication Contract；
- State Contract；
- Replica Storage Contract；
- R1 Protocol；
- Pairing / Security；
- Data Exposure Matrix；
- Operations；
- UX；
- Test Matrix；
- 本实施计划与 Design Index。

H0 退出条件：关键实现问题均有 Contract / Test 入口，不再靠 Demo 代码临场猜测。

## 5. H1：Node Identity + Capability Composition

目标：只建立实例身份和 Cordis 插件组合，不联网。

内容：

- 持久 nodeId；
- Node Key material 接口；
- runtimeInstanceId；
- localCapture / replicationUpstream / hubAccept；
- 四个合法 Profile；
- Composition Root 按能力装配；
- 不修改当前 Host ID。

验收：Standalone 无回归；重启 nodeId 不变；Pure Hub 不启动 Source；非法组合明确失败；npm/Desktop 共用 Identity。

风险：低。

## 6. H2：Replication Core / Shared Identity

目标：在内存中证明 Node Canonical Graph 能确定性映射成 Hub Replica / Shared Identity Graph。

内容：

- Entity Scope Registry；
- `agentlens-replica-r1` ReplicaKey；
- 保留 Remote ID namespace；
- Typed EntityRef；
- `project-repository-v1 / asset-upstream-v1`；
- Hub 重算 SharedKey；
- Shared Root / Group / Assertion / Membership；
- Promotion；
- Dependency DAG；
- payload 不重写。

验收：两 Node 相同本机 ID 不碰撞；同 Git Remote 汇聚；path-only 不误合并；Hub Local + Remote 可进同 Group；Promotion 不改 origin FK；SharedKey mismatch 被拒绝。

风险：高。

## 7. H3：R1 Protocol / Identity Proof

目标：建立版本化 Wire / Hash / Signature / Handshake 状态机，先用内存 Transport 验证。

内容：

- R1 Major / Minor；
- Identity Algorithm negotiation；
- Pairing Receipt / serverProof；
- stream / generation；
- Batch Envelope；
- deterministic JCS hash；
- Sequence / ACK / Receipt；
- Commit Ambiguity；
- Stream Rollover；
- Stable Error；
- `ReplicatedValue`：value / redacted / omitted(policy|not-captured|history-boundary|dependency-minimized)；
- Request Signature；
- Remote Unified ID 规则。

验收：版本协商、Hub Proof、Header/Body tamper、sequence retry/gap/reuse、old/new stream、identity algorithm mismatch、Remote ID 不碰撞。

风险：中高。

## 8. H4：Policy / History / Durable Local Replication State

目标：Node 能可靠回答“什么允许发、哪些历史允许补、什么尚未 ACK”。

内容：

- metadata-only / redacted / full；
- outbound sanitizer；
- from-now / include-existing；
- History Boundary / Revision；
- Entity-type Minimum Dependency Shape；
- Policy Revision；
- pending entity hash；
- Durable Outbox / immutable Batch staging；
- Reconciliation；
- Tombstone foundation；
- Policy expand/shrink。

关键验收：

```text
Canonical COMMIT
 -> crash before fast path
 -> restart
 -> reconcile
 -> pending repaired
```

以及 full -> metadata-only ambiguous Batch 通过 Stream Rollover 安全恢复。

风险：高。

## 9. H5：Remote Replica Storage + Hub Import + Generation

这是实现风险最高阶段。

目标：在**一个 Hub Storage Boundary / 一个默认 SQLite** 中同时保持：

```text
Local Canonical Store
Remote Replica Store
Shared Identity State
Replication Control Plane
```

但绝不要求 Remote Replica 写进现有 Local Canonical SQL Row。

内容：

- Remote Replica Repository / Migration；
- availability state 原生持久化；
- retained prior value / current availability provenance；
- Node Registry；
- Stream / Cursor / Sequence Receipt；
- active / staged / retired Generation；
- Replica Entity Map；
- Shared Assertions / Membership；
- Conflict / Tombstone；
- Transactional Remote Import；
- dependency-safe ref resolution；
- Shared Identity Hub recompute；
- Generation activation / retirement；
- Control Plane retention / GC。

必须证明：

- metadata-only Workspace 不需要伪造 path；
- omitted SourceRecord payload 不写 `{}` 冒充原值；
- Local Canonical Schema 不被全局 nullable 化；
- full/redacted/metadata-only 使用同一 Replica Store 路径；
- Batch rollback 不推进 ACK；
- staged Generation 不污染 active；
- Shared Membership 与 Generation 同步切换；
- Local ID / ReplicaKey 同库不碰撞。

风险：最高。

## 10. H6：Pairing + TLS + Authenticated Replication Surface

内容：

- Hub Identity；
- Pairing Offer / Secret；
- Node Key Possession；
- Pairing Receipt；
- self-managed / user TLS；
- SPKI；
- Handshake serverProof；
- Request Signature；
- nonce / timestamp；
- Revoke / Key Rotation；
- Stream Freeze / Rollover；
- Body / Entity / Rate / Concurrency / Disk pressure limits。

验收：未配对/已撤销不可上传；SPKI / Proof / Signature 错误失败；Replay 被拒；超大请求不 OOM；Local Surface 不暴露。

风险：高，必须 Security Review。

## 11. H7：Bootstrap + Incremental + Reconcile + Generation E2E

第一条真实多机闭环：

```text
Node A history
 -> pair
 -> bootstrap or from-now boundary
 -> reconcile
 -> incremental
 -> Hub active Remote Replica
```

再加入 Node B 和 Hub Local。

验收：Bootstrap 中断恢复；期间继续采集；from-now 不泄露旧字段；Hub 离线 backlog 收敛；Re-bootstrap G2 失败仍读 G1；同 Portable Project 正确 Membership。

风险：中高。

## 12. H8：Unified Read + Projection + Web / CLI

目标：让现有 Projection 能从 Local Canonical + active Remote Replica 安全构建统一视图。

内容：

- UnifiedIdentityReader / ObservationReader / SharedGroupReader 等正式 Contract；
- Hub Local ID 与 Remote ReplicaKey 作为 opaque public ID；
- 字段 availability-aware Projection input；
- omitted / redacted / retained prior value 的展示与统计规则；
- Node / Host / Shared Project filters；
- stable cross-node tie-break；
- Session / Usage / Overview 跨 Node 聚合；
- Shared Project / Workspace grouping；
- Node Registry / Sync Status DTO；
- Hub / Pair / Policy / History / backlog UI；
- Headless CLI。

禁止：Web 直查 Replica 私表；Projection 用假空值补 Remote 字段；用 replicatedAt 改写业务时间；Remote Control。

风险：高于普通 UI 改造，因为现有 Projection 需要适应 availability-aware Read Model。

## 13. H9：Delete / Purge / Identity / Recovery

内容：

- Origin Tombstone；
- Shared Assertion Withdrawal；
- Retention；
- Delete Node History preview；
- Policy Purge；
- Revoke / Delete 分离；
- Node Identity Reset；
- Re-pair；
- Re-bootstrap；
- Generation GC；
- Conflict diagnostics；
- Hub recovery boundary。

未实现能力 UI 必须明确不可用。

## 14. H10：性能、容量与故障注入

基线至少：

```text
Nodes: 2 / 5 / 10
Observations: 100k / 1m / 5m+
```

指标：Bootstrap throughput、steady-state delay、Remote Import transaction、Unified Read session latency、Shared Group resolve、Reconcile cost、backlog disk、Generation staging amplification、SQLite busy、memory peak。

故障注入：ACK lost、duplicate/gap、Node/Hub crash、TLS/Proof mismatch、clock skew、cloned nodeId、promotion conflict、policy change during ambiguous batch、disk pressure、staged Generation failure。

优化仍遵守 ADR-0006：可重建数据不成为第二事实源。

## 15. Alpha 完成定义

只有同时满足：

- Standalone 无回归；
- 2+ Node 稳定汇聚；
- Hub / Node 离线不丢 Local Fact；
- from-now / include-existing 授权可证明；
- Remote Replica 不伪造 omitted 字段；
- Bootstrap / Incremental / Reconcile / Generation 收敛；
- Replica / Shared Identity 幂等；
- Unified Read 正确处理 Local + Remote；
- Pairing / TLS / Hub Proof / Revoke 闭环；
- Policy 字段级边界可证明；
- Web 可按 Node / Project 查询；
- 不开放 Remote Control；
- 三平台自动化 + 至少一次真实多机 Dogfood；
- 文档与实现状态同步。

## 16. 推荐开工顺序

```text
H1 Identity / Composition
 -> H2 Replication Core
 -> H3 R1 Protocol
 -> H4 Policy / History / Outbox
 -> H5 Replica Storage / Import
 -> H6 Security / Surface
 -> H7 E2E Sync
 -> H8 Unified Read / UI
 -> H9 Delete / Recovery
 -> H10 Performance
```

不要先做“POST JSON 到 Hub”的 Demo 再倒补 Identity、Policy、History、Storage omission 和 Security。