# ADR-0007：多机 Hub、Local-first 与 Canonical Replication

状态：Accepted（2026-08-27 三次实现前复核）  
日期：2026-08-27  
范围：AgentLens 1.0 Alpha / Hub / Node Identity / Replication / Security / Protocol / Storage

## 背景

AgentLens 1.0 是本地优先的 AI 编码 Agent 可观测工具：每台机器独立完成 Source 采集、Canonical Pipeline、SQLite 持久化、Projection 与 Web / Desktop 展示。多机能力目标是让多台 Windows / macOS / Linux 机器的数据可以在一个 Hub 中统一查看和聚合，同时不破坏 Local-first、Canonical Observation、Evidence、Cordis Runtime、Projection 和双发行边界。

本 ADR 接受后进行了多轮实现前复核。主方向不变，但修正了以下关键边界：

1. `Node` 是 AgentLens 实例身份，不是与 Hub 互斥的 Runtime Role；
2. 本机 Canonical ID 不保证跨机器全局唯一，不能直接当 Hub 全局主键；
3. Shared Identity 需要确定性 Merge；
4. Durable Outbox 不能只依赖 Cordis Event，必须有 Canonical Reconciliation；
5. Replication Policy 与 History Scope 分离；
6. Stream / ACK 与 Replica Generation 是不同状态维度；
7. Hub Identity 必须真正参与 Pairing / Handshake 密码学证明；
8. `Project` / `AssetDefinition` 这类 Conditional Shared 不能一部分走 Shared 主键 + FK Rewrite、一部分又保留本机 Origin Row；Alpha 固定采用 Origin Row + Shared Group Membership。

具体 Entity / Wire / Security / State 细节由 `docs/1.0/HUB-DESIGN-INDEX.md` 指向的下位 Contract 承载。

## 决策

### 1. 每个 AgentLens 实例都是 Node；产品形态是能力组合

```text
AgentLens Node
  localCapture        true | false
  replicationUpstream true | false
  hubAccept           true | false
```

Alpha 只允许：

```text
Standalone  true  false false
Node        true  true  false
Hub         true  false true
Pure Hub    false false true
```

拒绝 `replicationUpstream && hubAccept`、纯转发节点和全 false 空运行时。

Node / Hub 不拆两套程序；能力切换允许要求重启 Daemon。

### 2. Hub 是可选 Local-first 聚合层

每个启用本机采集的 Node 始终独立完成：

```text
Native Source
 -> Normalize / Identity
 -> Canonical Observation / Evidence
 -> Local Storage
 -> Local Projection / Web
```

Hub / 网络 / 配对 / TLS / Protocol 失败不得阻塞本地 Pipeline。Hub 不是启动前置条件，也不是唯一事实库。

### 3. Hub 是 Canonical Replica + Aggregator，不是第二个 Source Parser

```text
Node Native Source
 -> Node Canonical Store
 -> Replication Policy
 -> History Scope
 -> Replication
 -> Hub Unified Store
 -> Hub Projection
```

Hub 不重新解析 Claude / Codex / Pi / Hermes / OpenCode，不重新调用普通 `ObservationService.commit()` 猜远程事实。

### 4. 同步正式 Wire DTO，不同步 SQLite 或 Projection

Wire 至少覆盖形成完整事实图所需的持久 Canonical Entity State：Host、AgentProduct/Installation、RuntimeProfile、Project/Workspace、Session/Relationship、AgentActor、SourceRecord、Observation、Evidence、Coverage、Asset、ToolDefinition 等。

运行时 Capability、SourceRuntimeStatus、Checkpoint、Candidate、Projection/Summary/Usage/Overview 不作为 Canonical Replication Entity。

禁止数据库文件 / Row 同步、Projection 事实化、Hub 重新依赖 Source Parser。

### 5. 本机 Canonical ID 与跨机 ReplicaKey 分离

当前 Host ID 只满足单机稳定性，因此 Node-scoped 与 Conditional Shared 的 Origin Entity 使用：

```text
ReplicaKey = stable(nodeId, entityType, originEntityId)
```

Hub 保留 originNodeId / originEntityId；发送端可提供 replicaKey 诊断值，但 Hub 必须自行重算验证。

这只是 Replication Namespace，不是重新 Identity 推断。

未来若要迁移本机 Host / Canonical Identity，必须独立 Contract Review / Migration。

### 6. nodeId 使用持久 UUID；Host 与 Node Identity 分离

每个数据根初始化持久随机 nodeId，例如：

```text
~/.agent-lens/1.0/node.json
```

hostname/platform/arch 是可变元数据。Clone Detection 只有并发 runtime / sequence 分叉等强证据才可冻结；IP、hostname、sleep/wake 只能作为弱 diagnostics。

### 7. Alpha 固定单 Hub 星型拓扑

```text
              Hub
        +------+------+ 
        |      |      |
      Node A Node B Node C
```

一个 Node 最多一个 upstream Hub；不支持 Hub Federation、级联 Hub、多 upstream 或循环 Replication。

### 8. Hub 使用统一 Store，不按 Node 分数据库

Hub 多 Node 数据进入同一个 Storage / Repository，不采用 node-a.db / node-b.db。

Alpha 继续 SQLite；是否增加 PostgreSQL 由真实规模决定。

### 9. Canonical Layer 与 Replication Control Plane 分离

Replication Control Plane 维护：

```text
nodes / pairing relationships
streams / cursors / receipts
replica generations
replica entity maps
shared assertions / memberships / groups
promotion provenance
conflicts / tombstones
policy / history state
```

这些不是 Agent 行为 Observation。

### 10. Shared Identity 有两种固定物理语义

Shared 不能笼统理解成“所有 Node 最后都必须共用一个 Canonical 主键”。Alpha 分两种：

#### 10.1 Shared Root

适合天然拥有稳定全局身份的实体。Alpha 只有：

```text
AgentProduct
```

它可以使用一个 Shared Canonical Row，并保留各 Node assertion provenance，按 deterministic Merge Contract 合并描述元数据。

#### 10.2 Conditional Shared Group

适合：

```text
Project
AssetDefinition
```

固定模型：

```text
Origin Row A ----\
Origin Row B -----+-> Shared Identity Group
Hub Local Row ---/
```

要求：

- 每个 origin 保留自己的 Canonical / Replica Row；
- Workspace / Session / AssetBinding 等领域 FK 继续指各自 origin row；
- SharedKey 标识逻辑 Group，不作为 Project / AssetDefinition 的统一物理主键；
- Shared Group / Membership 由 assertions 重算；
- Hub Local 与 Remote 使用同一 Membership Contract；
- Promotion 只建立 Membership，不批量 Rewrite Canonical FK。

这样既保留 provenance，也避免本机 IdentityService 被迫理解 Hub Shared 主键。

### 11. Shared Merge 必须显式、确定性

每种 Shared Root / Group 定义：Identity Fields、Mergeable Metadata、Node-local Metadata、Conflict Fields。

禁止通用 last-write-wins。Merge 与 Batch 到达顺序无关。

### 12. Replication Batch 事务性、幂等，并区分提交不确定性

Hub 单 Batch完整校验、事务写入、成功后推进 ACK；失败整体 rollback。

Batch 第一次可能发网后 sequence/body/contentHash immutable。ACK 丢失只能 exact retry 或查询 Hub ACK，不能同 sequence 换 Body。

### 13. Durable Replication = Fast Path + Reconciliation

Cordis Event 只降低延迟：

```text
Canonical Event -> fast enqueue
Canonical Store -> History Boundary -> Policy -> reconcile -> repair
```

正式语义：at-least-once + deterministic identity/hash + idempotent import + reconciliation。

删除依赖 Tombstone；普通 scan absence 不能推断删除。

### 14. 首次接入明确 History Scope

连接 Hub 不等于授权全部历史。

```text
from-now
include-existing
```

- include-existing：resumable Bootstrap -> mandatory Reconciliation；
- from-now：持久 History Boundary，不做普通历史补传，但新事实可带必要 dependency closure。

`from-now` 不只靠 occurredAt 判断。

### 15. Capture Policy / Replication Policy / History Scope 分离

```text
Capture Policy     -> 什么能进入 Local Store
Replication Policy -> 哪些字段能离开本机
History Scope      -> Boundary 前历史是否允许补传
```

Alpha Policy：metadata-only / redacted / full。

metadata-only 不传 Prompt / Tool body，也默认不传完整本机路径，但仍可能包含 Repository Identity、Agent / Tool、时间与结构元数据，因此不是匿名模式。

Policy 放宽不自动扩大历史授权；Policy 收紧必须立即停止新的旧 Policy 出站请求。

### 16. Ownership、Shared Membership 与删除分离

Node-scoped / Conditional Origin ownership 由 originNodeId 决定，其他 Node 不得修改。

Conditional Shared Membership 不改变 origin ownership。

删除：

- Origin Entity -> Tombstone；若有 membership，同时撤回自己的 membership；
- Shared Root / Group assertion withdrawal -> 只影响该来源；
- 一个来源撤回不能删除其他来源；
- Revocation 不自动等于 Delete / Withdrawal。

### 17. Re-bootstrap 使用 staged Replica Generation

普通 Reconciliation：absence != delete。

显式 Re-bootstrap：

```text
G1 active
 -> G2 staged bootstrap
 -> G2 reconcile + validate
 -> atomic activate G2
 -> retire G1
```

G2 还必须 staged 保存该 Remote Node 的 Conditional Shared Membership 集；激活只切换该 Node origin/membership，不影响其他 Node / Hub Local membership。

### 18. Node 永远主动连接 Hub

```text
Node -> outbound HTTPS -> Hub Replication Surface
```

Hub 不反向访问 / 控制 Node。

### 19. Local HTTP 与 Replication Surface 完全分离

Local Web / API：

```text
127.0.0.1:56789
```

Replication：独立 authenticated HTTPS Surface。

禁止为 Hub 把现有 Local Surface 直接暴露网络。Alpha Remote Web 是非目标。

### 20. Pairing 与长期认证分离；双方都有密码学身份

Pairing Secret 是短期用户授权。

Node 使用长期非对称 Key，并在 Pair Request 证明 Key Possession；Hub 保存 Public Key。

Hub 也有长期 Hub Identity Key，并签名 Pairing Receipt / Handshake serverProof。

Node Request Signature 至少绑定 hubId、nodeId、streamId、keyId、method、path、timestamp、nonce、raw body hash。

### 21. TLS Identity 与 Hub Identity 分离

TLS 保证传输端点；Hub Identity 保证长期产品信任身份。

自管理 TLS 使用 SPKI Pinning；公共 CA 场景正常验证 CA/hostname。证书续期不等于 Hub 身份变化。

### 22. mDNS 只发现，不建立信任

Discovery 不可信。信任依赖 TLS/SPKI、Hub Identity、Pairing Secret、Receipt/Proof。Alpha 可不实现 mDNS。

### 23. Control Plane 不提供远程执行

只管理 Pair / Revoke / Status / Protocol / Replication State / Diagnostics；不提供 Shell、Agent 启动、Skill 安装、Hook 修改或远程系统命令。

### 24. 产品版本、Replication Protocol、Storage Schema 独立

```text
AgentLens Version
Replication Protocol R1.x
Storage Schema migration N
```

网络兼容性由 Replication Protocol 决定。

### 25. Wire Protocol 版本化并先 Handshake

Major 用于破坏 Identity / Reference / History / Delete / Signature / Entity 语义的变化；Minor 仅兼容扩展。

连接前交换版本、Capability、Node/Hub Identity、Stream/ACK、Policy/History Revision、Generation、Hub Proof、serverTime。

没有共同协议只暂停 Replication。

### 26. 协议不兼容不得影响 Local-first

本地 Source、Commit、SQLite、Web 全部继续。未同步 Upsert / Tombstone 保留并等待恢复。

### 27. 推荐先升级 Hub，再滚动升级 Node

Hub 在支持窗口兼容旧 Protocol，允许逐台升级 Node。

## Cordis 组合边界

```text
common
  storage-sqlite
  core-services
  projections
  capture-policy
  surface-http
  web
  node-identity

localCapture=true
  + sources/*

replicationUpstream=true
  + replication-client

hubAccept=true
  + replication-server
  + replication-surface
  + node-registry
```

Replication Runtime Extension 仍是 Cordis-native，不增加第二套 DI / Plugin Loader。

## Alpha 实施顺序

以 `HUB-ALPHA-IMPLEMENTATION-PLAN.md` 为准：

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

## 被拒绝的方案

- Node / Hub 两套程序 / Runtime：拒绝；
- 四个互斥领域 Role：拒绝；
- Hub 唯一事实库：拒绝；
- Hub 只联邦查询不存 Replica：拒绝；
- SQLite 文件 / Row 同步：拒绝；
- 当前本机 Canonical ID 直接当跨机主键：拒绝；
- 为 Hub 强制重写整库 Canonical ID：拒绝；
- Hub 重新解析 Source / Remote Candidate：拒绝；
- 同步 Projection DTO：拒绝；
- 按 Node 分数据库：拒绝；
- 只依赖 Cordis Event 写 Outbox：拒绝；
- 普通 scan absence 推断删除：拒绝；
- 通用 last-write-wins：拒绝；
- 一个 Node 多 Hub / Federation：Alpha 拒绝；
- Local `/api/v1/*` 直接暴露网络：拒绝；
- Hub 反向控制 Node：拒绝；
- Alpha 先上 PostgreSQL / Redis / Kafka：拒绝；
- **Conditional Shared 通过 SharedKey 替换 Project / AssetDefinition 主键并批量 Rewrite FK：拒绝。** Shared Group 是聚合身份，不是本机/Replica Domain FK 的替代主键。

## 后果

正向：

- Local-first / Offline 保持；
- 单 Runtime / Cordis 组合保持；
- 不立即迁移本机 Canonical ID；
- Replica Namespace 解决跨机碰撞；
- Conditional Shared 保留 origin provenance，Hub Local / Remote 物理语义统一；
- Project / Asset 跨设备聚合不要求改写已有 FK；
- 用户可选择 from-now / include-existing；
- Reconciliation 修复 Fast Path 漏同步；
- staged Generation 保护 Re-bootstrap；
- Pairing / Handshake 双方密码学身份证明；
- 单 Hub 星型保持实现可控。

代价：

- Hub 保存远程副本；
- Shared Project / Asset 查询需要正式 Shared Group Resolver / Membership；
- Group metadata / Membership 是新的可重建分布式 identity state；
- 仍需要 Stream、Receipt、Generation、Tombstone、History Boundary、Security 等控制面；
- 多机测试面扩大。

## 验证标准

- Standalone 无回归；
- nodeId 稳定；
- 非法 capability 拒绝；
- Hub 不可达时本地正常；
- ReplicaKey 不跨 Node 碰撞；
- AgentProduct Shared Root deterministic；
- Project / AssetDefinition 保留每个 origin row；
- 同 Portable Identity 的 origin rows 进入同 Shared Group；
- Promotion 不修改 Workspace / Observation / AssetBinding 等 origin FK；
- Hub Local + Remote 同 Project 可聚合；
- 一个 member withdrawal 不影响其他 members；
- include-existing Bootstrap 可恢复；
- from-now 不被 Reconcile 绕过；
- Fast Path 丢失可补齐；
- Policy / History 权限边界可证明；
- ambiguous Batch / Rollover 正确；
- staged Generation 只原子切换对应 Remote Node origin/membership；
- Local HTTP 继续 loopback；
- Pairing / Proof / Signature / Revoke 安全闭环；
- Protocol 不兼容只暂停同步；
- 跨 Node 排序不把 replicatedAt 当业务时间；
- Web 不把 Replication Control Plane 当 Agent 行为事实。

## 相关决策与下位 Contract

- ADR-0001：Clean Rebuild 与 Cordis Runtime；
- ADR-0004：双发行、单运行时生命周期；
- ADR-0005：Runtime Profile / Session Relationship / Asset Topology；
- ADR-0006：性能治理与架构护栏；
- `docs/1.0/HUB-DESIGN-INDEX.md`：Hub 下位 Contract / Protocol / Security / Operations / UX / Test 入口。
