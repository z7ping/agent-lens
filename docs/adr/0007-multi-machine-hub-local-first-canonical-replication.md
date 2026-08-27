# ADR-0007：多机 Hub、Local-first 与 Canonical Replication

状态：Accepted（2026-08-27 四次实现前复核，设计冻结）  
日期：2026-08-27  
范围：AgentLens 1.0 Alpha / Hub / Node Identity / Replication / Security / Protocol / Storage

## 背景

AgentLens 1.0 是本地优先的 AI 编码 Agent 可观测工具。每台机器独立完成 Source 采集、Canonical Pipeline、本地 SQLite 持久化、Projection 与 Web / Desktop 展示。

多机 Hub 的目标，是让多台 Windows / macOS / Linux 机器的数据可以在一个 Hub 中统一查看与聚合，同时不破坏以下边界：

- Local-first；
- Canonical Observation / Evidence 仍由本机形成；
- Cordis 仍是唯一 Runtime Plugin System；
- Projection 仍是可重建读模型；
- npm / Desktop 仍共用单一 Runtime / 数据根；
- Hub 不成为远程控制平台。

本 ADR 经多轮实现前复核后冻结。具体 Entity、Wire、State、Storage、Security、Operations、UX 与测试细节由 `docs/1.0/HUB-DESIGN-INDEX.md` 指向的下位 Contract 承载。

## 决策

### 1. 每个 AgentLens 实例都是 Node；产品形态是能力组合

底层能力：

```text
localCapture        true | false
replicationUpstream true | false
hubAccept           true | false
```

Alpha 只允许四个正式 Profile：

```text
Standalone  true  false false
Node        true  true  false
Hub         true  false true
Pure Hub    false false true
```

拒绝：

- `replicationUpstream && hubAccept`；
- `localCapture=false && replicationUpstream=true`；
- 全 false 空运行时。

Node / Hub 不拆成两套程序或两套领域模型。能力切换 Alpha 可以要求重启 Daemon。

### 2. Hub 是可选的 Local-first Replica + Aggregator

本机采集链始终独立：

```text
Native Source
 -> Normalize / Identity
 -> Canonical Observation / Evidence
 -> Local Canonical Store
 -> Local Projection / Web
```

Hub 不在线、网络中断、协议不兼容、配对撤销、TLS / Identity 失败，都不得阻塞本地 Source、Canonical Commit、SQLite 与 Web。

Hub 是 Replica + Aggregator，不是唯一事实库，也不是第二个 Source Parser。

### 3. Node 形成事实，Hub 不重新解释远程 Source

远程链路：

```text
Node Canonical Store
 -> Replication Policy
 -> History Scope
 -> Versioned Wire DTO
 -> Hub Remote Import
 -> Remote Replica Store
 -> Unified Read Repository
 -> Projection
```

Hub 不重新读取 Claude / Codex / Pi / Hermes / OpenCode 原生数据，不重新运行 Source Parser / Normalizer，也不通过普通 `ObservationService.commit()` 重新猜事实。

### 4. 同步 Wire DTO，不同步 SQLite 文件、SQLite Row 或 Projection

Replication Wire 表达经过策略授权后的 Canonical Entity State，而不是 Storage Row。

禁止：

- rsync / 复制 `agent-lens.db`；
- 把 SQLite Row 直接定义成线上协议；
- 同步 Projection / Summary / Usage / Overview 作为事实源；
- 为 Hub 重新依赖具体 Source Parser。

运行时 Capability、Checkpoint、Runtime Status、Candidate、Projection 等不进入 Canonical Replication Graph；需要时走 Control Plane。

### 5. 本机 Canonical ID 与跨机 ReplicaKey 分离

现有本机 ID 只保证本机稳定性，不能证明跨机器全局唯一。

Node-scoped 与 Conditional Shared Origin 使用确定性 Replica Namespace：

```text
ReplicaKey = stable(
  'agentlens-replica-r1',
  nodeId,
  entityType,
  originEntityId
)
```

实现编码必须使用保留的 Replica 前缀 / 命名空间，与现有 `host-* / project-* / session-* / observation-*` 等 Local Canonical ID 域可区分。

Hub 保留：

```text
originNodeId
originEntityId
```

Node 可发送 replicaKey 用于诊断，但 Hub 必须自行重算并验证。

Hub Web / Protocol 中：

- Hub 本机 Entity 可以继续暴露现有 Local Canonical ID；
- Remote Entity 使用 ReplicaKey 作为统一查询 ID；
- Shared Group Key 只标识聚合身份，不替代 Conditional Shared 的领域 FK。

因此 `/review/:logicalSessionId` 等统一查询仍能用一个不碰撞的 opaque ID 定位本机或远程会话。

### 6. nodeId 使用持久 UUID；Host Identity 不因 Hub 强制迁移

每个 AgentLens 数据根首次初始化持久随机 `nodeId`。

`nodeId` 表示 AgentLens 实例 / 数据根；hostname、platform、arch 只是可变元数据。

当前 Host / Installation / Workspace 等 Canonical ID 规则不因 Hub 强制整库迁移。未来若要改变本机 Canonical Identity，必须单独 Contract Review / Migration。

### 7. Alpha 固定单 Hub 星型拓扑

```text
              Hub
        +------+------+ 
        |      |      |
      Node A Node B Node C
```

一个 Node 最多一个 upstream Hub；不支持 Hub Federation、级联 Hub、多 upstream、循环 Replication。

### 8. “统一 Hub Store”指统一 Storage Boundary，不代表同一物理表

这是实现前最终修订后的固定语义。

```text
Hub Storage Boundary / one default SQLite
│
├─ Local Canonical Store
├─ Remote Replica Store
├─ Shared Identity State
├─ Replication Control Plane
└─ Unified Read Repository
```

仍然拒绝：

```text
node-a.db
node-b.db
```

但也拒绝：

```text
Remote Replica -> 强塞现有 Local Canonical Row
```

原因：当前 Local Canonical Schema 有真实必填不变量，而 Replication Policy / History Scope 合法允许字段 `omitted / redacted`。Hub 不得使用空串、`{}`、`[hidden]` 等假值骗过 Local Schema。

Alpha 可以全部放在同一个 SQLite 文件中；“统一”指 Storage Boundary、事务与 Read Surface，而不是要求 Local / Remote 共用完全相同的 SQL Row Contract。

### 9. Local Canonical 与 Remote Replica 的语义不同，但都不是 Projection

Local Canonical Store 表达本机实际持久化事实，保持现有 Core Domain 不变量。

Remote Replica Store 表达：

> Remote Node 已形成的 Canonical State，在经过 History Scope 与 Replication Policy 后，Hub 实际获授权获得的持久副本。

Remote Replica 是 Replication Data Plane，不是 Projection、Cache 或第二次 Normalize 的结果。

受策略控制字段必须原生保留可见性：

```text
value
redacted
omitted(policy)
omitted(not-captured)
omitted(history-boundary)
omitted(dependency-minimized)
```

真实 `null` 与这些状态必须可区分。

### 10. `from-now` Dependency Closure 必须字段最小化

`from-now` 不授权补传旧历史，但 Boundary 后的新事实可能需要 Boundary 前的 Host / Installation / Project / Workspace / Session 等引用闭包。

允许补必要 identity / FK 结构，不允许因此顺带补传旧：

- Session title；
- 非必要 startedAt / endedAt；
- Workspace 完整路径；
- Prompt / Tool 正文；
- SourceRecord payload；
- 其他不为新事实引用完整性所必需的历史元数据。

这些继续使用 `history-boundary / dependency-minimized` 表达缺失原因。

### 11. Shared Identity 分 Shared Root 与 Conditional Shared Group

#### Shared Root

Alpha 只有 `AgentProduct`。

它拥有稳定跨机器身份，可以逻辑上形成一个 Shared Root，并保留各 Node assertion provenance 与 deterministic metadata merge。

#### Conditional Shared Group

Alpha：

```text
Project
AssetDefinition
```

固定模型：

```text
Origin A ----\
Origin B -----+-> Shared Identity Group
Hub Local ---/
```

要求：

- 每个 origin 永远保持自己的 Local Row / Remote Replica；
- Workspace / Session / AssetBinding 等 FK 继续指 origin；
- SharedGroupKey 不是 Project / AssetDefinition 的领域主键；
- Promotion 只增加 Membership，不批量 Rewrite FK；
- Hub Local 与 Remote 使用同一 Membership Contract。

### 12. Shared Identity 算法必须版本化并由 Hub 重算

Alpha 至少定义：

```text
project-repository-v1
asset-upstream-v1
```

SharedKey 的算法版本属于 Wire Identity Contract。Normalization 规则改变到会影响 identity 时必须升级算法版本 / Protocol 兼容边界，不能让新旧 Node 静默算出不同 Group。

Node 自报 SharedKey 只能作为 assertion；Hub 必须基于协议允许出站的 normalized portable identity 自行重算并验证。

### 13. Shared Merge 必须显式、确定性

每种 Shared Root / Group 必须定义：

- Identity Fields；
- Mergeable Metadata；
- Origin-local Metadata；
- Conflict Fields。

禁止通用 last-write-wins。Merge 结果必须与 Batch 到达顺序无关。

### 14. Replication Batch 事务性、幂等，并区分提交不确定性

单 Batch 的 Remote Replica mutations、Shared Identity mutations、Generation、Sequence Receipt / Cursor、Tombstone / Conflict 必须在同一 Storage Transaction Boundary 中。

只有事务提交后 ACK 才推进。

Batch 第一次可能发网后 sequence / body / contentHash immutable。ACK 丢失时只能 exact retry 或查询 Hub ACK，不能同 sequence 换 Body。

### 15. Durable Replication = Fast Path + Reconciliation

Cordis Event 只用于低延迟 fast path，不是 Durable Replication Fact。

```text
Canonical Event -> fast pending
Canonical Store -> History Boundary -> Policy -> hash -> Reconciliation
```

正式语义：

```text
at-least-once
+ deterministic identity/hash
+ idempotent import
+ reconciliation
```

删除使用持久 Tombstone；普通 scan absence 不能推断删除。

### 16. Replication Policy 与 History Scope 分离

```text
Capture Policy     -> 什么能进入 Local Store
Replication Policy -> 本机已有内容哪些字段允许离开本机
History Scope      -> Boundary 前已有历史是否允许补传
```

Alpha：

```text
Policy: metadata-only | redacted | full
History: from-now | include-existing
```

`metadata-only` 不传 Prompt / Tool body，也默认不传完整本机路径，但仍可能发送项目 / Repository Identity、Agent / Tool、时间与结构元数据，因此不是匿名模式。

Policy 放宽不自动扩大历史授权；Policy 收紧必须立即停止新的旧 Policy 出站。

### 17. Policy 收紧不等于自动 Purge

`full -> metadata-only` 后，新出站数据立即遵守新 Policy。

Hub 已经保存的旧 full 值不会自动删除；如需清理必须是独立 Purge / Delete 操作。

Remote Replica Store 必须能区分：

```text
当前 Policy 未再授权刷新
vs
旧授权值仍被保留
```

retained prior value 不能冒充“刚按新 Policy 重新确认的最新事实”。

### 18. Replica Generation 解决完整 Re-bootstrap

普通 Reconciliation：

```text
absence != delete
```

显式 Re-bootstrap：

```text
G1 active
 -> G2 staged
 -> bootstrap
 -> reconcile
 -> validate
 -> atomic activate G2
 -> retire G1
```

Remote Conditional Shared Membership 也随 Generation staged / activated；Hub Local membership 不属于 Remote Generation。

### 19. Unified Read Repository 是 Hub Projection 的正式入口

Projection / Web 不直接读取 Remote Replica 私表，也不假设 Remote Replica 等于 Local Core Entity。

统一读边界负责：

- Local Canonical + active Remote Replica；
- ReplicaKey / origin provenance；
- Shared Root / Shared Group Resolver；
- 字段 availability；
- Node / Host / Shared Project filter；
- staged / retired Generation 隔离。

Hub Projection 必须显式理解“字段未同步 / 已脱敏”，不能把 omitted 转成空字符串或“来源没有提供”。

### 20. Node 主动连接，Local Surface 与 Replication Surface 分离

Node 只主动出站：

```text
Node -> HTTPS -> Hub Replication Surface
```

现有本机 Web / API 保持：

```text
127.0.0.1:56789
```

禁止为 Hub 把 Local Surface 改成网络监听。Alpha 不内建 Remote Web Login，也不提供 Remote Control。

### 21. Pairing、TLS、Node Identity、Hub Identity 分离

Pairing Secret 只负责短期用户授权。

Node / Hub 各有长期非对称身份。Node Pair Request 要证明 Node Key Possession；Hub Identity Key 签名 Pairing Receipt 与 Handshake `serverProof`。

TLS Identity 负责传输端点；Hub Identity 负责长期产品信任。

长期 Request Signature 至少绑定：

```text
hubId
nodeId
replicationStreamId
keyId
method
path
timestamp
nonce
raw body hash
```

### 22. Alpha 是 trusted-node 模型，不是远程证明系统

Node Signature 证明“这份声明来自哪一个已配对 Node”；Hub 重算 SharedKey 证明“Identity 算法一致”。

它们不能密码学证明：

- Node 真的拥有它声明的 Git Repository；
- Node 没有伪造本机 Canonical Observation；
- 已完全攻陷的 Node OS 仍可信。

Hub 通过 origin namespace、ownership、merge invariant、resource limits 与 conflicts 限制影响范围，但 Alpha 不声称提供 Remote Attestation。

### 23. Clone Detection 只用强证据冻结

IP、hostname、sleep/wake 是弱信号，只用于 diagnostics。

真正并发 runtime instance、同 Stream sequence 分叉、不同 immutable Batch 竞争同 sequence 等强冲突才冻结关系。

### 24. 产品版本、Replication Protocol、Storage Schema 独立

```text
AgentLens Version
Replication Protocol R1.x
Storage Schema migration N
```

网络兼容由 Replication Protocol 协商决定。

协议不兼容只暂停 Replication，不影响本地 Pipeline。

推荐先升级 Hub，再滚动升级 Node。

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

Hub 能力继续作为 Cordis-native Runtime Extension，不建立第二套 DI / Lifecycle / Plugin Loader。

## Alpha 实施顺序

```text
H1 Node Identity / Composition
 -> H2 Replication Core / Shared Identity
 -> H3 R1 Protocol / Identity Proof
 -> H4 Policy / History / Outbox / Reconcile
 -> H5 Remote Replica Storage / Hub Import / Generation
 -> H6 Security / Replication Surface
 -> H7 E2E Sync
 -> H8 Unified Read / Projection / Web / CLI
 -> H9 Delete / Recovery
 -> H10 Performance / Hardening
```

## 被拒绝的方案

- Node / Hub 拆成两套程序或两套 Runtime；
- Hub 作为唯一事实库；
- Hub 只做联邦查询、不保存 Replica；
- 同步 SQLite 文件 / Row；
- 直接把本机 Canonical ID 当跨机全局 ID；
- 为 Hub 强制迁移整库 Canonical Identity；
- Hub 重新解析 Source / Commit Remote Candidate；
- 同步 Projection 作为事实源；
- 每个 Node 一份数据库；
- 把 Remote omitted 字段用空值 / 占位符强塞 Local Canonical 表；
- full Policy 走 Local Canonical 表、metadata-only 走 Replica 表的双物理路径；
- Conditional Shared 改主键并批量 FK Rewrite；
- 只靠 Cordis Event 写 Outbox；
- 普通扫描 absence 推断删除；
- 通用 last-write-wins；
- 一个 Node 多 upstream Hub / Hub Federation；
- 把 Local `/api/v1/*` 直接暴露网络；
- Hub 反向控制 Node；
- 为 Alpha 先引入 PostgreSQL / Redis / Kafka。

## 后果

正向：

- Local-first、离线和单机使用不受 Hub 影响；
- 不强制迁移现有 Canonical Identity；
- Remote Policy omission 不污染本机 Core Domain；
- Project / Asset 跨设备可聚合但仍保留 origin provenance；
- `from-now` 不会通过依赖闭包偷偷变成历史 Metadata Bootstrap；
- Hub Web 可以统一查询本机与远程数据，同时保持 ID 不碰撞；
- Protocol、Storage 与 Product Version 可独立演进。

代价：

- Hub Storage 需要 Local Canonical / Remote Replica / Shared Identity / Control Plane / Unified Read 多层边界；
- Projection 需要处理字段 availability；
- 需要 Bootstrap、Reconciliation、Generation、Tombstone、Policy / History Revision、Stream / ACK 与冲突状态；
- Hub 聚合数据安全半径显著增加；
- 多机、跨平台与故障注入测试面扩大。

## 设计冻结验收标准

实现前必须能够从下位 Contract 明确回答：

- Node / Hub 角色与 Cordis 组合；
- ReplicaKey / SharedGroupKey 如何生成并版本化；
- Remote ID 如何进入统一 API 而不碰撞；
- Project / AssetDefinition 为何保留 Origin + Membership；
- metadata-only / redacted / full 如何物理持久化；
- `from-now` Dependency Closure 最多能带哪些字段；
- omitted / redacted / retained prior value 如何区分；
- Bootstrap / Incremental / Reconciliation / Re-bootstrap 如何收敛；
- Policy 收紧、ACK 丢失、Stream Rollover 如何保证隐私；
- Pairing / TLS / Hub Proof / Request Signature 如何闭环；
- Clone、Revoke、Delete History、Node Reset 的差异；
- Unified Read / Projection 如何读取 Local + Remote；
- 版本不兼容时为何不影响本机。

上述问题当前均已有对应 Contract / Protocol / Test 入口。Hub Alpha 架构到此冻结；后续若出现新的结构性矛盾，先修文档再继续实现。

## 相关文档

- `ARCHITECTURE.md`
- `docs/1.0/HUB-DESIGN-INDEX.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-STATE-CONTRACT.md`
- `docs/1.0/HUB-REPLICA-STORAGE-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-PROTOCOL.md`
- `docs/1.0/HUB-PAIRING-SECURITY.md`
- `docs/1.0/HUB-DATA-EXPOSURE-MATRIX.md`
- `docs/1.0/HUB-OPERATIONS.md`
- `docs/1.0/HUB-UX-CONTRACT.md`
- `docs/1.0/HUB-ALPHA-IMPLEMENTATION-PLAN.md`
- `docs/1.0/HUB-TEST-MATRIX.md`
