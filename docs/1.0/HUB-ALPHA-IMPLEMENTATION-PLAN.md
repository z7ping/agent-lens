# AgentLens 1.0 Hub Alpha 实施计划

更新日期：2026-08-27  
状态：计划文档，今天不实施  
上位文档：
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-PROTOCOL.md`
- `docs/1.0/HUB-PAIRING-SECURITY.md`
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
- 远程 Web 登录；
- PostgreSQL / Redis / Kafka 基础设施。

## 2. 实施护栏

全过程必须满足：

1. 当前 Standalone 默认路径不配置 Hub 时行为不变；
2. Node / Hub 仍是同一 AgentLensApplication 的能力组合；
3. Core Domain / Repository / Protocol 不依赖 Cordis；
4. Runtime Extension 使用 Cordis-native Plugin；
5. 本机 `/api/v1/*` 继续 loopback；
6. Replication Metadata 不进入 Canonical Observation；
7. Projection 不成为同步事实源；
8. Replication Policy 只能收紧 Capture 后已有数据；
9. Hub 不重新解析 Source；
10. 任何阶段都不发布 npm / Release，除非仓库所有者明确要求。

## 3. 建议模块边界

最终包名实现时可以微调，但职责边界建议保持：

```text
packages/
  node-identity/             # nodeId / key metadata / clone-reset boundary
  replication-protocol/      # Wire DTO / version / errors / canonical encoding
  replication-policy/        # metadata-only / redacted / full outbound policy
  replication-core/          # scope registry / EntityRef / ReplicaKey / merge / promotion
  replication-client/        # handshake / bootstrap / outbox / reconcile / retry
  replication-server/        # remote import / registry / cursor / conflict / shared assertions
  surface-replication/       # HTTPS / pairing / authenticated transport
```

原则：

- `replication-core` 保持普通 TypeScript / Core Contract 风格，不绑定网络服务器；
- `surface-replication` 管网络生命周期，不实现 Canonical 业务语义；
- Client / Server 通过 Protocol Contract 交互，不共享 SQLite 私有 Row；
- Storage 的 Replication Control Plane Repository 可以先由 `storage-sqlite` 实现，但应通过专门 Contract 访问。

## 4. H0：文档与测试护栏

本阶段即当前阶段。

完成项：

- ADR-0007；
- Replication Contract；
- Wire Protocol；
- Pairing / Security；
- Operations；
- Alpha 实施计划。

开工前还应把 Contract 验收案例转换成测试清单，但不要求现在写测试代码。

退出条件：

> 关键设计问题不再靠实现者临场猜测。

## 5. H1：Node Identity + Capability-driven Composition Root

目标：只建立实例身份和插件组合，不联网。

内容：

- 首次初始化持久 `nodeId`；
- Node Key material 的接口 / 存储边界；
- `localCapture / replicationUpstream / hubAccept` 配置模型；
- Daemon Composition Root 根据能力装配插件；
- Hub / Pure Hub 组合可启动，但 replication plugin 先可为空实现 / disabled boundary；
- 不修改现有 Host ID。

验收：

- 无 Hub 配置与当前 Daemon 行为一致；
- 重启 nodeId 不变；
- 改 hostname 不改变 nodeId；
- Pure Hub 不启动 Source；
- capability 变更要求重启可接受；
- npm / Desktop 仍复用同一个默认 Daemon。

风险：低。

## 6. H2：Replication Core Contract

目标：先在内存 / 单进程证明“一个 Node Canonical Graph 能确定性映射成 Hub Graph”。

内容：

- Entity Scope Registry；
- ReplicaKey 算法；
- Typed EntityRef；
- Project Repository Identity Normalizer；
- Asset Portable Identity Resolver 接口；
- Shared Merge Contract；
- Shared Assertion model；
- Identity Promotion / Alias；
- Dependency DAG；
- Wire serializer / deserializer；
- payload 不重写门禁。

验收优先用 fixture / pure unit tests，不启动 HTTPS。

关键验收：

- 两 Node 相同本机 Host ID 不碰撞；
- 同一 Git Remote 的 SSH / HTTPS Project 汇聚；
- 本机路径 Project 不误合并；
- Promotion 后旧 Ref 可解析；
- Batch 到达顺序不改变 Merge 结果。

风险：高。这里是数据语义核心，未稳定前不要做 UI。

## 7. H3：Replication Protocol + Handshake Contract

目标：建立版本化 R1 DTO 与状态机，仍可先用内存 Transport 测试。

内容：

- R1 version model；
- Handshake request / response；
- `replicationStreamId`；
- Batch Envelope；
- Sequence / ACK；
- Stable Error Code；
- Capability Negotiation；
- `ReplicatedValue` omitted / redacted 语义；
- canonical body hash / request signing input helper。

验收：

- sequence retry / gap / reuse conflict；
- R1 minor negotiation；
- no-common-version -> blocked but local healthy；
- old stream / new stream cursor 不混淆。

风险：中。

## 8. H4：Replication Policy + Local Durable State

目标：Node 可以可靠知道“什么需要同步”，但还不要求真 Hub 网络。

内容：

- `metadata-only / redacted / full`；
- outbound sanitizer；
- Replication State Repository；
- pending entity hash；
- Durable Outbox / batch staging；
- Reconciliation scanner；
- Tombstone persistence foundation；
- policy expand / shrink semantics。

关键设计：

- Cordis Event 只 fast path；
- Canonical Reconciliation 能修复 Event 丢失窗口；
- Outbox 可重建部分不成为第二事实源；
- Tombstone 不可仅靠扫描重建。

验收：

```text
Canonical commit
 -> crash before fast-path enqueue
 -> restart
 -> reconcile
 -> entity becomes pending
```

风险：高。

## 9. H5：Hub Replication Storage / Remote Import

目标：先在本机进程内用直接函数调用把 Node Batch 导入 Hub Store，不做公网入口。

内容：

- Node Registry Repository；
- Stream / Cursor；
- Replica Entity Map；
- Permanent Alias；
- Shared Assertion；
- Replication Conflict；
- Tombstone metadata；
- Transactional Remote Import；
- dependency-safe FK rewrite；
- Shared Merge / Promotion transaction。

验收：

- Batch 全成功才 ACK；
- 中间失败整体 rollback；
- duplicate Batch idempotent；
- Promotion + FK rewrite atomic；
- Shared assertion withdrawal 不误删其他 Node 数据。

风险：最高。

## 10. H6：Pairing + TLS + Authenticated Replication Surface

目标：在已有可靠 Import Core 上增加网络，不把业务语义写进 HTTP handler。

内容：

- Hub Identity；
- Node Public Key Registry；
- Pairing Offer / Secret；
- self-managed TLS；
- user-provided TLS config；
- SPKI pinning；
- request signature；
- nonce / timestamp replay protection；
- node revoke；
- stream freeze；
- rate / size limit。

验收：

- 未配对不可上传；
- 已撤销不可上传；
- TLS Pin mismatch 失败；
- body 修改后 signature 失败；
- replay 被拒绝；
- Replication Surface 与 Local HTTP 端口 / handler 分离。

风险：高，必须安全 Review。

## 11. H7：Bootstrap + Incremental E2E

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

再加入 Node B：

```text
Node A + Node B
 -> same Hub
 -> unified query
```

验收：

- Bootstrap 中断恢复；
- Bootstrap 期间继续采集；
- 完成后 Reconcile 收敛；
- Hub 离线 backlog；
- 恢复后追平；
- 同 hostname Node 不冲突；
- Shared Project 正确汇聚。

风险：中高。

## 12. H8：Projection Scope + Web / CLI 状态

目标：在 Canonical Replica 已可靠后再做表现层。

内容：

- Protocol DTO 增加 Node / Host scope filters；
- Session / Usage / Overview 支持跨 Node 聚合；
- Node Registry / Sync Status 独立 DTO；
- 设备状态；
- Hub 开关 / Pair UI；
- Replication Policy UI；
- Bootstrap / backlog / blocked diagnostics；
- Node filter；
- Project 跨机器聚合视图。

不允许：

- Web 直接查询 Replication SQLite 私有表；
- Projection 复制成为 Hub 事实源；
- 远程执行按钮。

风险：中。

## 13. H9：删除 / Purge / Identity 操作

Alpha 可以把这一阶段放在基本同步稳定之后，但发布前必须明确能力边界。

内容：

- Node-scoped Tombstone；
- Shared Assertion Withdrawal；
- 删除 Node 历史预演；
- Revoke 与 Delete 分离；
- Node Identity Reset；
- Re-pair；
- Re-bootstrap；
- conflict resolution diagnostics。

如果某项尚未实现，UI 必须明确“当前不支持”，不能提供看似可用的危险按钮。

## 14. H10：性能与故障注入

Hub Alpha 收口前建立专门基线：

- 2 / 5 / 10 Node；
- 10 万 / 100 万 / 多百万 Observation；
- Bootstrap throughput；
- steady-state incremental latency；
- Hub unified session list latency；
- Usage aggregation latency；
- SQLite write contention；
- Replication batch size；
- reconciliation full scan cost。

故障注入至少：

- 请求超时；
- 重复 Batch；
- gap；
- Hub transaction failure；
- Node crash；
- Hub crash before ACK response；
- cert mismatch；
- clock skew；
- cloned nodeId；
- promotion conflict；
- policy change during backlog。

任何优化仍遵守 ADR-0006：Projection / Cache 可重建，不能产生第二事实源。

## 15. CI / 测试层次

建议：

```text
Unit
  ReplicaKey / Normalizer / Merge / Policy / Signature input

Contract
  Wire DTO / EntityRef / Protocol version

Storage integration
  Remote Import / rollback / alias / assertions

In-process E2E
  Node Store -> Batch -> Hub Store

Network E2E
  Pair -> TLS -> Handshake -> Bootstrap -> ACK

Cross-platform
  Windows / Linux / macOS Node identity + path semantics
```

不要一开始依赖真实多台机器才能验证核心语义。

## 16. Alpha 完成定义

Hub Alpha 只有同时满足下列条件才算完成：

- Standalone 无回归；
- 两个以上 Node 可稳定汇聚到一个 Hub；
- Node 离线 / Hub 离线不会丢本地事实；
- Bootstrap 可恢复；
- Incremental / Reconciliation 可收敛；
- Replica ID / Shared Merge / Promotion 可证明幂等；
- Pairing / TLS / revoke 安全闭环；
- Replication Policy 有明确默认与用户可见边界；
- Web 能按 Node / Host 查看并做统一聚合；
- 不开放远程执行；
- 文档、实现状态和安全说明同步；
- Windows / macOS / Linux 关键链有自动化覆盖，并完成至少一次真实多机狗粮验收。

## 17. 推荐开工顺序摘要

```text
H1 Node Identity / Composition
 -> H2 Replication Core
 -> H3 Wire Protocol
 -> H4 Policy / Outbox / Reconcile
 -> H5 Hub Import
 -> H6 Security / Surface
 -> H7 E2E Sync
 -> H8 Web / CLI
 -> H9 Delete / Identity Ops
 -> H10 Performance / Hardening
```

不要先做一个“能 POST JSON 到 Hub”的 Demo 再倒补 Identity / Policy / Merge；那会把最难的数据语义拖到最后返工。
