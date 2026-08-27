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

本文把已经确定的 Hub 架构拆成可独立验收的实施阶段。每个阶段都要求 Standalone 行为保持不变，不允许为了赶 Hub 绕过 Core Contract、Repository、Capture Policy、Projection 或 Cordis Runtime。

## 1. Alpha 目标

Alpha 最终只承诺：

```text
1 Hub
N trusted Nodes
single user
Local-first
Node -> Hub one-way canonical replication
Hub unified read-only aggregation
```

Alpha 不扩展到：

- 多 Hub / HA / Federation；
- Team / Account / RBAC；
- 远程 Agent / Shell 执行；
- Hub -> Node 双向同步；
- 内建 Remote Web 登录；
- PostgreSQL / Redis / Kafka 基础设施。

## 2. 实施护栏

全过程必须满足：

1. 当前 Standalone 默认路径不配置 Hub 时行为不变；
2. Node / Hub 仍是同一 AgentLensApplication 的能力组合；
3. Alpha 只允许四个合法 Capability Profile，不允许 `hubAccept + replicationUpstream` 偷偷形成级联 Hub；
4. Core Domain / Repository / Protocol 不依赖 Cordis；
5. Runtime Extension 使用 Cordis-native Plugin；
6. 本机 `/api/v1/*` 继续 loopback；
7. Replication Metadata 不进入 Canonical Observation；
8. Projection 不成为同步事实源；
9. Replication Policy 只能收紧 Capture 后已有数据；History Scope 独立表达是否补传既有历史；
10. Hub 不重新解析 Source；
11. Hub Identity 必须真实参与 Pairing Receipt / Handshake Proof；
12. 任何阶段都不发布 npm / Release，除非仓库所有者明确要求。

## 3. 建议模块边界

最终包名实现时可以微调，但职责边界建议保持：

```text
packages/
  node-identity/             # nodeId / key metadata / runtimeInstanceId / reset boundary
  replication-protocol/      # Wire DTO / version / errors / hash / signature input
  replication-policy/        # metadata-only / redacted / full outbound policy
  replication-core/          # scope / EntityRef / ReplicaKey / merge / promotion / shared membership
  replication-client/        # handshake / bootstrap / outbox / reconcile / history boundary / retry
  replication-server/        # import / registry / cursor / receipt / generation / conflict
  surface-replication/       # HTTPS / pairing / authenticated transport / resource limits
```

原则：

- `replication-core` 保持普通 TypeScript / Core Contract 风格，不绑定网络；
- `surface-replication` 管网络和认证生命周期，不实现 Canonical 业务语义；
- Client / Server 通过 Protocol Contract 交互，不共享 SQLite 私有 Row；
- Replication Control Plane Repository 通过专门 Contract 访问；
- npm / Desktop 共用同一数据根下的 Node / Hub Identity 与 Replication Config。

## 4. H0：文档与测试护栏

当前阶段，已完成设计文档：

- ADR-0007；
- `HUB-REPLICATION-CONTRACT.md`；
- `HUB-REPLICATION-STATE-CONTRACT.md`；
- `HUB-REPLICATION-PROTOCOL.md`；
- `HUB-PAIRING-SECURITY.md`；
- `HUB-DATA-EXPOSURE-MATRIX.md`；
- `HUB-OPERATIONS.md`；
- `HUB-UX-CONTRACT.md`；
- `HUB-TEST-MATRIX.md`；
- 本实施计划与 Hub 文档索引。

H0 退出条件：

> 关键实现问题都有明确 Contract / 测试入口，不再靠实现者临场猜测；发现新的结构性缺口时先回到文档，不用 Demo 代码“试出来再说”。

## 5. H1：Node Identity + Capability-driven Composition Root

目标：只建立实例身份和插件组合，不联网。

内容：

- 首次初始化持久 `nodeId`；
- Node Key material 接口 / 存储边界；
- 每次 Daemon 启动生成临时 `runtimeInstanceId`；
- `localCapture / replicationUpstream / hubAccept` 配置模型；
- 合法四 Profile 校验；
- 明确拒绝 `hubAccept=true && replicationUpstream=true`；
- Daemon Composition Root 根据能力装配插件；
- Hub / Pure Hub 可启动，但网络 replication 尚未 active；
- 不修改现有 Host ID。

验收：

- 无 Hub 配置与当前 Daemon 行为一致；
- 重启 nodeId 不变、runtimeInstanceId 改变；
- 改 hostname 不改变 nodeId；
- Pure Hub 不启动 Source；
- 非法 Capability 组合明确失败；
- npm / Desktop 仍复用同一个默认 Daemon / Identity。

风险：低。

## 6. H2：Replication Core Contract

目标：先在内存 / 单进程证明“一个 Node Canonical Graph 能确定性进入 Hub Aggregation Graph”。

内容：

- Entity Scope Registry；
- ReplicaKey；
- Typed EntityRef；
- Project Repository Identity Normalizer；
- Asset Portable Identity Resolver；
- Shared Merge / Assertion / Membership；
- Identity Promotion / Alias；
- Hub-local Conditional Shared Entity participation；
- Dependency DAG；
- Wire serializer / deserializer；
- payload 不重写门禁。

关键验收：

- 两 Node 相同本机 Host ID 不碰撞；
- 同 Git Remote 的 SSH / HTTPS Project 汇聚；
- 本机路径 Project 不误合并；
- Hub 本机与 Remote Node 同一 Portable Project 可聚合；
- Promotion 后旧 Ref 可解析；
- Batch 到达顺序不改变 Merge 结果。

风险：高。这里未稳定前不做 UI。

## 7. H3：R1 Wire Protocol + Identity Proof

目标：建立版本化 DTO / Hash / Signature / Handshake 状态机，先可用内存 Transport 验证。

内容：

- R1 Major / Minor；
- Pairing Receipt 数据结构；
- Handshake request / response + `serverProof`；
- `replicationStreamId`；
- `replicaGenerationId`；
- Batch Envelope；
- Policy / History Revision；
- deterministic Canonical JSON Hash；
- Sequence / ACK / Sequence Receipt；
- Commit Ambiguity；
- Stream Rollover；
- Stable Remote Error / Local Diagnostic Code；
- Capability Negotiation；
- `ReplicatedValue` omitted / redacted；
- Request Signature Input 绑定 hubId / nodeId / streamId / keyId。

验收：

- R1 minor negotiation；
- no-common-version -> blocked but local healthy；
- Pairing Receipt / serverProof 可验证；
- identity Header 修改导致 Signature Fail；
- sequence retry / gap / reuse conflict；
- ambiguous commit 只能重放同 immutable Batch；
- old / new stream cursor 不混淆。

风险：中高。

## 8. H4：Replication Policy + History Boundary + Local Durable State

目标：Node 能可靠回答“什么允许同步、哪些历史被授权、什么尚未 ACK”，但不要求真 Hub 网络。

内容：

- `metadata-only / redacted / full`；
- 字段级数据暴露矩阵；
- outbound sanitizer；
- `historyMode = from-now | include-existing`；
- History Boundary / revision；
- Dependency Closure；
- Policy Revision；
- Replication State Repository；
- pending entity hash；
- Durable Outbox / Batch staging；
- immutable in-flight Batch；
- Reconciliation scanner；
- Tombstone persistence foundation；
- policy expand / shrink semantics。

关键设计：

- Cordis Event 只 fast path；
- Canonical Reconciliation 修复 Event 丢失窗口；
- `from-now` 不能被 Reconcile 绕过；
- Policy 收紧立即阻止旧 Policy 新请求；
- Tombstone 不可仅靠扫描重建。

关键验收：

```text
Canonical commit
 -> crash before fast path
 -> restart
 -> reconcile
 -> entity becomes pending
```

以及：

```text
full policy
 -> ambiguous in-flight batch
 -> user changes metadata-only
 -> old sensitive batch not resent
 -> stream rollover
 -> reconcile under new policy
```

风险：高。

## 9. H5：Hub Replication Storage / Remote Import

目标：先用直接函数调用把 Batch 导入 Hub Store，不做公网入口。

内容：

- Node Registry；
- Pairing Relationship metadata；
- Stream / Cursor / Sequence Receipt；
- Replica Generation（active / staged / retired）；
- Replica Entity Map；
- Permanent Alias；
- Shared Assertion / Membership；
- Hub-local Shared Assertion；
- Replication Conflict；
- Tombstone metadata；
- Transactional Remote Import；
- dependency-safe FK / Ref resolution；
- Shared Merge / Promotion transaction；
- Control Plane Retention / GC boundary。

验收：

- Batch 全成功才 ACK；
- 中间失败 rollback；
- duplicate Batch idempotent；
- Sequence Receipt 可检测 reuse conflict；
- Promotion / Membership deterministic；
- Shared withdrawal 不误删其他 Node；
- staged Generation 失败不影响 active Generation；
- Generation activate 后可安全 retire stale Replica。

风险：最高。

## 10. H6：Pairing + TLS + Authenticated Replication Surface

目标：在可靠 Import Core 上增加网络，不把业务语义塞进 HTTP Handler。

内容：

- Hub Identity；
- Node Public Key Registry；
- Pairing Offer / Secret；
- Node Key Possession Proof；
- Pairing Receipt；
- self-managed TLS；
- user-provided TLS；
- SPKI Pinning；
- Handshake Hub serverProof；
- Request Signature；
- nonce / timestamp replay protection；
- Node Revoke；
- Stream Freeze / Rollover；
- body / entity / rate / concurrency limit；
- Hub storage pressure protection。

验收：

- 未配对不可上传；
- 已撤销不可上传；
- SPKI mismatch 失败；
- Pairing Receipt / serverProof 错误时不发送数据；
- body / identity Header 修改后 signature 失败；
- replay 被拒绝；
- 超大请求不会 OOM；
- Replication Surface 与 Local HTTP 分离。

风险：高，必须安全 Review。

## 11. H7：Bootstrap + Incremental + Generation E2E

目标：第一条真实多机闭环。

场景：

```text
Node A existing history
 -> pair Hub
 -> bootstrap
 -> reconcile
 -> incremental
 -> Hub projection sees A
```

还要覆盖：

```text
from-now
 -> only new facts + required dependency closure
```

以及：

```text
explicit re-bootstrap
 -> staged generation
 -> reconcile
 -> atomic activate
```

再加入 Node B 做 unified query。

验收：

- Bootstrap 中断恢复；
- Bootstrap 期间继续采集；
- 完成后 Reconcile 收敛；
- `from-now` 不补旧正文；
- Hub 离线 backlog；
- 恢复后追平；
- Re-bootstrap 半途失败仍能查询旧 active Generation；
- Shared Project / Hub-local Project 正确汇聚。

风险：中高。

## 12. H8：Projection Scope + Web / CLI 状态

目标：Canonical Replica 可靠后再做表现层。

内容：

- Protocol DTO 增加 Node / Host scope filters；
- 跨 Node 排序稳定 tie-break；
- clock skew diagnostics；
- Session / Usage / Overview 跨 Node 聚合；
- Shared Project / Workspace grouping；
- Node Registry / Sync Status DTO；
- Hub 开关 / Pair UI；
- Replication Policy + History Scope UI；
- Bootstrap / backlog / paused / blocked diagnostics；
- Node filter；
- Headless Pure Hub CLI 管理路径。

不允许：

- Web 直接查询 Replication SQLite 私有表；
- Projection 复制成为事实源；
- Remote Control 按钮；
- 用 `replicatedAt` 改写业务发生时间。

风险：中。

## 13. H9：删除 / Purge / Identity / Recovery 操作

内容：

- Node-scoped Tombstone；
- Shared Assertion Withdrawal；
- Tombstone Retention；
- 删除 Node 历史预演；
- Revoke / Delete 分离；
- Node Identity Reset；
- Re-pair；
- Stream Rollover 运维入口；
- Re-bootstrap；
- Replica Generation GC；
- Conflict diagnostics；
- Hub recovery 边界。

如果某项未实现，UI 必须明确“当前不支持”，不能提供假按钮。

## 14. H10：性能、容量与故障注入

Hub Alpha 收口前建立专门基线：

- 2 / 5 / 10 Node；
- 10 万 / 100 万 / 多百万 Observation；
- Bootstrap throughput；
- steady-state p50/p95 delay；
- Hub unified session list latency；
- Usage aggregation latency；
- SQLite write contention；
- Batch / Entity Size；
- Reconciliation full scan cost；
- staged Re-bootstrap 的临时磁盘放大；
- Sequence Receipt / Control Plane size。

故障注入至少：

- timeout / ACK lost；
- duplicate Batch；
- gap；
- transaction failure；
- Node / Hub crash；
- TLS / Hub proof mismatch；
- clock skew；
- cloned nodeId；
- promotion conflict；
- policy change during ambiguous Batch / backlog；
- Hub disk pressure；
- staged Generation build failure。

任何优化仍遵守 ADR-0006：可重建数据不能升级成第二事实源。

## 15. CI / 测试层次

建议：

```text
Unit
  ReplicaKey / Normalizer / Merge / Policy / History Boundary / Hash / Signature

Contract
  Wire DTO / EntityRef / Protocol / Pairing Receipt

Storage integration
  Import / rollback / alias / assertions / generations / retention

In-process E2E
  Node Store -> Batch -> Hub Store

Network E2E
  Pair -> TLS -> Handshake -> Bootstrap -> ACK

Cross-platform
  Windows / Linux / macOS identity + path + key permissions
```

核心语义不能依赖真实三台机器才可测试。

## 16. Alpha 完成定义

Hub Alpha 只有同时满足：

- Standalone 无回归；
- 非法 Capability 组合被拒绝；
- 两个以上 Node 稳定汇聚到一个 Hub；
- Node / Hub 离线不丢本地事实；
- `from-now` 与历史补传授权可证明有效；
- Bootstrap 可恢复；
- Incremental / Reconciliation 可收敛；
- Stream Rollover / Replica Generation 恢复语义闭环；
- Replica ID / Shared Merge / Promotion 可证明幂等；
- Hub 本机 Shared Project 可与 Remote 汇聚；
- Pairing / TLS / Pairing Receipt / Hub Proof / Revoke 安全闭环；
- Replication Policy 有字段级明确边界；
- Web 能按 Node / Host 查看并统一聚合；
- Clock Skew 不被误当精确全局时序；
- 不开放 Remote Control；
- 文档、实现状态、安全说明同步；
- 三平台关键链自动化覆盖，并完成至少一次真实多机狗粮验收。

## 17. 推荐开工顺序

```text
H1 Node Identity / Composition
 -> H2 Replication Core
 -> H3 R1 Protocol / Identity Proof
 -> H4 Policy / History / Outbox / Reconcile
 -> H5 Hub Import / Generation
 -> H6 Security / Surface
 -> H7 E2E Sync
 -> H8 Web / CLI
 -> H9 Delete / Identity / Recovery Ops
 -> H10 Performance / Hardening
```

不要先做一个“能 POST JSON 到 Hub”的 Demo 再倒补 Identity / Policy / History / Merge / Security；那会把最难的问题拖到最后返工。
