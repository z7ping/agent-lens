# AgentLens 1.0 Hub Replica Storage Contract

更新日期：2026-08-27  
状态：Alpha 架构 Contract，尚未实现  
相关文档：
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-STATE-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-PROTOCOL.md`
- `docs/1.0/HUB-DATA-EXPOSURE-MATRIX.md`

本文解决一个必须在实现前明确的问题：Replication Wire 允许 `omitted / redacted`，而当前本机 Canonical Domain / SQLite Schema 有多项必填字段。Hub 不能为了复用本机表结构而伪造远程事实。

## 1. 为什么需要独立 Storage Contract

当前本机 Canonical Schema 具有真实本机事实约束，例如：

```text
hosts.name/platform/arch/created_at/last_seen_at NOT NULL
projects.created_at/last_seen_at NOT NULL
workspaces.path NOT NULL
source_records.payload_json NOT NULL
observations.payload_json NOT NULL
```

但 Hub Replication 合法允许：

```text
Workspace.path = omitted(policy)
SourceRecord.payload = omitted(policy)
Prompt / Tool body = omitted(policy)
旧 Dependency Closure 的非必要历史字段 = omitted(history-boundary)
```

错误做法：

```text
omitted path -> ''
omitted path -> '[hidden]'
omitted payload -> {}
```

这些会把“Hub 没有获得这个值”伪造成“Canonical Fact 的真实值就是空串 / 占位符 / 空对象”。

因此：

> Remote Replica 的持久化表示必须原生表达字段可见性，不能被强制压进现有 Local Canonical Row Contract。

## 2. “统一 Store”的正式含义

ADR 中的统一 Hub Store 表示：

> 一个 Hub Storage Boundary / 一个默认数据库 / 一个统一 Repository Query Surface；不是每个 Node 一个数据库，也不等于所有 Local 与 Remote 数据必须物理写进完全相同的表结构。

Alpha 逻辑组成：

```text
Hub Storage Boundary
│
├─ Local Canonical Store
│    existing hosts/projects/workspaces/observations/...
│
├─ Remote Replica Store
│    policy-aware canonical replica representation
│
├─ Shared Identity State
│    Shared Root assertions
│    Shared Groups / Memberships
│
├─ Replication Control Plane
│    node / relationship / stream / cursor / receipt
│    generation / tombstone / conflict / policy state
│
└─ Unified Read Repository
     Local Canonical + Active Remote Replica + Shared Resolver
     -> Projections / Protocol DTO
```

Alpha 仍可以全部位于同一个 SQLite 文件中。

明确拒绝：

```text
node-a.db / node-b.db
```

也拒绝：

```text
Remote omitted -> fake Local Canonical value
```

## 3. Local Canonical Store 保持纯净

现有 Local Canonical Repository / Schema 继续表达：

> 这个 AgentLens 实例实际持久化的本机 Canonical Fact。

Hub 功能不得为了远程缺失字段而把本机 Domain 全局改成：

```text
Workspace.path?: string
```

也不得让所有本机 Repository 都理解 `ReplicatedValue`。

原因：

- 会弱化已经成立的 Local Canonical invariant；
- 会把网络隐私语义污染 Core Domain；
- Standalone / npm / Desktop 会被一个可选 Hub 能力反向复杂化。

如未来 Core 自身确实需要 optional path，应作为独立 Core Contract 变化，不由 Hub 顺手修改。

## 4. Remote Replica Store 是 Data Plane，不是 Projection

Remote Replica Store 持久化的是：

> Node 已形成的 Canonical Entity State 在经过 History Scope + Replication Policy 后，Hub 实际被授权获得的 Replica 表示。

它：

- 不是 SourceRecord 原生输入；
- 不是 Hub 重新 Normalize 的结果；
- 不是 Projection / Cache；
- 不是 Local Canonical Row 的伪造副本；
- 是 Remote Node Canonical State 的持久 Replica Data Plane。

Node 仍是该事实的 Primary；Hub 是 Replica。

## 5. Remote Replica 必须保留字段可见性

受 Policy / History Scope 控制的字段必须保留：

```ts
type ReplicatedValue<T> =
  | { state: 'value'; value: T }
  | { state: 'redacted'; value?: T }
  | {
      state: 'omitted'
      reason:
        | 'policy'
        | 'not-captured'
        | 'history-boundary'
        | 'dependency-minimized'
    }
```

Storage 不能只保存 `value?: T` 后丢掉 state/reason。

Hub 必须能够回答：

```text
这个字段真实为空？
Node 没采集？
Node 有但 Policy 不允许发？
History Boundary 不允许补？
这是为了新事实 FK 而发送的最小 Dependency？
```

## 6. from-now Dependency Closure 必须最小化

`from-now` 允许发送 Boundary 前的必要 identity / FK dependency，但不授权整行历史元数据。

例如，新 Observation 需要旧 LogicalSession：

允许：

```text
logicalSession origin identity
installation / project / workspace refs
协议要求的最小结构字段
```

不因为 Dependency Closure 自动允许：

```text
旧 session title
Boundary 前 startedAt / endedAt（如果不是建立新事实引用所必需）
旧 Prompt / Tool body
旧 Workspace 完整 path
旧 SourceRecord payload
```

这些字段在 Wire / Replica Store 使用 `omitted(history-boundary|dependency-minimized)`。

Dependency Closure 的目标是：

> 让 Boundary 后新事实的引用图完整，而不是偷偷做 Metadata History Bootstrap。

## 7. Remote Replica Store 不能有 full / metadata 两条物理路径

无论 Policy 是：

```text
metadata-only
redacted
full
```

都走同一种 Remote Replica Storage Contract。

禁止：

```text
full -> existing Local Canonical tables
metadata-only -> replica tables
```

否则 Policy 改变会造成同一个 origin entity 在两个物理世界迁移，产生重复 ID、删除、Generation 与 Query 语义。

## 8. Replica Record 最小逻辑字段

具体 SQL 表名在 H5 Storage Design 时确定，但每个 Remote Replica Entity 至少能持久化：

```text
replicaKey
originNodeId
entityType
originEntityId
entityVersion
replicaGenerationId
policyRevision
historyRevision
contentHash
mapped typed references
field/body values + availability state
firstReplicatedAt
lastReplicatedAt
```

Conditional Shared 还通过正式 Shared Identity Repository 关联：

```text
origin -> Shared Group Membership
```

SharedGroupKey 不是 Remote Project / AssetDefinition Replica Row 的主键。

## 9. ReplicaKey 必须是独立存储命名空间

Remote Replica 主键遵守 Replication Contract 的 `agentlens-replica-r1` domain separator。

即使最终 Typed Replica Table 使用 TEXT PRIMARY KEY，也不能与 Local Canonical Identity 生成域混用。

Storage Integration Test 必须验证 Local Project ID 与 Remote Project ReplicaKey 可以在同一 Hub Storage Boundary 安全共存。

## 10. Shared Root / Shared Group 的 Storage 语义

### AgentProduct Shared Root

逻辑上只有一个 Shared Root。物理实现可以位于正式 Shared Identity / Replica Repository 中，不要求为了“只有一行”把 Remote Assertion 直接覆盖 Local `agent_products` 行。

要求：

- Local Installation 与 Remote Installation 都能通过 Unified Resolver 得到同一 AgentProduct 产品身份；
- assertion provenance 保留；
- merged metadata 可重算；
- Local Canonical Repository 不因 Remote metadata 被静默改写。

### Project / AssetDefinition

固定：

```text
Local Origin Row / Remote Origin Replica
 -> Shared Group Membership
```

Projection 通过 Group Resolver 聚合，不使用 SharedKey 替换 Domain FK。

## 11. Unified Read Repository 是正式边界

Hub Projection 不得：

```text
SELECT * FROM replica_private_table
```

也不能假设 Remote Replica = Local Core Entity。

需要正式 Read Contract，例如概念上：

```text
UnifiedIdentityReader
UnifiedObservationReader
SharedGroupReader
ReplicaAvailabilityReader
```

职责：

- 合并 Local Canonical + 当前 active Remote Generation；
- 解析 ReplicaKey / Shared Root / Shared Group；
- 保留 originNodeId；
- 向 Projection 暴露字段 availability；
- 过滤 staged / retired Generation；
- 提供 Node / Host / Shared Project filter；
- 不让 Web 直接依赖 Storage 实现。

具体接口名可以 H5/H8 调整，但 Repository Boundary 不可省略。

## 12. Projection 必须尊重缺失字段

当 Remote 字段：

```text
omitted(policy)
```

Projection 只能显示：

```text
未同步 / 已隐藏
```

不能推断：

```text
来源没有这个字段
路径为空
Prompt 是空字符串
```

聚合指标必须只使用当前可解释字段。

例如 metadata-only 仍可以做 Session / Tool Count；不能凭 omitted Tool Result 算“结果为空”。

## 13. Policy 收紧不把旧值伪装成最新事实

`full -> metadata-only` 不自动 Purge Hub 已有完整内容。

如果某个已经存在的 Remote Replica Entity 后续在新 Policy 下只发送 omitted 字段：

- `omitted` 不能被解释成“把旧值更新为 null/空”；
- 旧已授权内容可以继续保留，直到显式 Purge；
- Storage 必须保留足够 provenance，区分“旧值仍保留”与“当前 Policy 未刷新此字段”；
- Projection / Diagnostics 不能把 retained prior value 宣称为“刚刚按新 Policy 重新确认的最新值”。

Alpha 可以对普通用户隐藏字段级 freshness 细节，但内部必须可解释。

## 14. Policy 放宽可以填充先前 omitted 字段

当用户明确扩大 Policy / History Scope：

```text
omitted -> redacted/value
```

同一个 ReplicaKey 可以补齐先前缺失字段，不创建第二个 Entity。

## 15. Transaction 与 ACK

单 Batch 的：

```text
Remote Replica mutations
Shared Assertion / Membership mutations
Generation state
Sequence Receipt / Cursor
Tombstone / Conflict metadata
```

必须位于同一个 Storage Transaction Boundary 中。

只有事务提交后 ACK 才推进。

## 16. Replica Generation

每个 Remote Replica Record 属于某个 generation。

```text
active G1
staged G2
```

Unified Read 只读取 active Generation；G2 complete+reconcile+validate 后原子切换。

对应 Node 的 Conditional Shared Membership 也跟随 Generation 激活，不提前影响正式 Group。

Hub Local Canonical / Membership 不属于 Remote Generation。

## 17. Delete / Purge

### Tombstone

删除 Remote origin 时：

- 删除 / retire 对应 Replica Record；
- 撤回该 origin Membership；
- 依赖安全；
- 不影响其他 Node / Hub Local origins。

### Delete Node History

必须能按 originNodeId 预演影响并删除该 Node Remote Replica Data Plane，同时重算 Shared Groups。

### Policy Purge

未来若实现“清除 Hub 已有 full 内容”，它是字段 / Replica 数据清理，不等同于 Revocation 或 Policy Setting Change。

## 18. Recovery

Remote Replica Data 通常可以从 Nodes Re-bootstrap。

但：

- Tombstone retention；
- Pairing trust；
- Stream Receipt；
- Hub Identity；
- 某些 Promotion / Membership provenance；

不能简单假设丢失后仅靠当前 Canonical Scan 100%恢复。

Recovery 仍以 State / Security Contract 为准。

## 19. 性能要求

引入 Remote Replica Store 不代表接受低效 JSON 全表扫描。

H5/H10 必须基于真实规模为以下查询建立索引 / Reader：

- originNodeId；
- entityType / ReplicaKey；
- LogicalSession / Observation 时间序；
- Project / Workspace；
- Tool / Usage；
- Shared Group Membership；
- active replicaGenerationId。

不能为了“统一表”牺牲百万 Observation 的现有性能护栏。

## 20. Storage 验收不变量

实现至少验证：

- metadata-only Workspace path omitted 时不需要写假 path；
- omitted SourceRecord payload 不被写成 `{}` 并冒充原 Payload；
- Local Canonical Schema 不为 Hub 被迫全局 nullable；
- full/redacted/metadata-only 使用同一 Remote Replica Storage Contract；
- from-now dependency 不泄露不必要 Boundary 前字段；
- omitted / redacted / null / retained-prior-value 可解释；
- Policy 放宽能在同 ReplicaKey 补字段；
- Local + Remote 数据通过 Unified Read 聚合；
- staged Generation 不出现在正式 Query；
- Hub Local / Remote Shared Group 语义一致；
- Batch transaction failure 不推进 ACK；
- Delete 一个 Node 不影响其他 origin；
- Web / Projection 不直接读取 Replica Storage 私有表；
- 单 Hub 仍是一个默认 Storage Boundary，不退化成 per-node database federation。

## 21. 当前非目标

Alpha 不要求：

- 修改现有 Local Canonical Domain 以原生表达所有 Replication omission；
- SQLite 透明加密；
- PostgreSQL；
- 每个 Node 单独数据库；
- Hub -> Node restore；
- Remote Replica 与 Local Canonical 使用同一物理 SQL table；
- 提前锁死 Remote Replica Store 必须是“一个 JSON 表”还是“typed replica tables”。

最后一条留给 H5 基于 Repository Contract、查询需求与性能基线确定；但无论物理布局如何，都必须满足本文的语义不变量。
