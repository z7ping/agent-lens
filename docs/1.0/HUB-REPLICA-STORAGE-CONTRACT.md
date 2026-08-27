# AgentLens 1.0 Hub Replica Storage Contract

更新日期：2026-08-27  
状态：Alpha 架构 Contract 冻结，尚未实现  
相关入口：`docs/1.0/HUB-DESIGN-INDEX.md`

本文解决 Hub 实现前的物理存储问题：Replication Wire 合法允许 `omitted / redacted`，而当前 Local Canonical Domain / SQLite Schema 存在真实必填字段。Hub 不能为了复用现有表结构而伪造远程事实。

## 1. 为什么需要独立 Replica Storage

当前 Local Canonical Schema 包含：

```text
hosts.name/platform/arch/... NOT NULL
projects.created_at/last_seen_at NOT NULL
workspaces.path NOT NULL
source_records.payload_json NOT NULL
observations.payload_json NOT NULL
```

Replication 则合法允许：

```text
Workspace.path = omitted(policy)
SourceRecord.payload = omitted(policy)
旧 Dependency 的非必要字段 = omitted(history-boundary|dependency-minimized)
```

禁止：

```text
omitted path -> ''
omitted path -> '[hidden]'
omitted payload -> {}
```

这些都是伪造 Canonical Fact。

## 2. “统一 Hub Store”的固定定义

```text
Hub Storage Boundary / one default SQLite
│
├─ Local Canonical Store
│    现有 hosts/projects/workspaces/observations/...
│
├─ Remote Replica Store
│    policy-aware canonical-state replica
│
├─ Shared Identity State
│    Shared Root assertions
│    Shared Groups / Memberships
│
├─ Replication Control Plane
│    nodes / relationships / streams / ACK / receipts
│    generations / tombstones / conflicts / policy state
│
└─ Unified Read Repository
     Local Canonical + Active Remote Replica + Shared Resolver
     -> Projection -> Protocol DTO -> Web
```

“统一”表示：一个默认 Storage Boundary、一个事务体系、一个统一 Read Surface。

它**不表示**：

- 每个 Node 一个数据库；
- Local / Remote 必须使用完全相同 SQL Row；
- Remote Replica 可以用假空值塞进 Local Canonical 表。

Alpha 仍优先使用一个 SQLite 文件。

## 3. Local Canonical Store 保持纯净

现有 Core Domain 继续表达本机实际持久化事实。

Hub 不得为了 Remote omission 把全局 Domain 改成：

```text
Workspace.path?: string
```

也不得要求 Standalone Repository 理解 `ReplicatedValue`。

如果未来 Core 自身需要 optional path，那是独立 Core Contract 变化，不是 Hub Side Effect。

## 4. Remote Replica Store 是 Data Plane，不是 Projection

Remote Replica 持久化：

> Remote Node 已形成的 Canonical Entity State，在经过 History Scope + Replication Policy 后，Hub 实际获授权得到的持久副本。

它不是：

- Source 原生输入；
- Hub 重新 Normalize 的结果；
- Projection / Cache；
- Local Canonical Row 的占位复制。

Node 仍是 Primary；Hub 是 Replica。

## 5. Availability 必须原生持久化

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

真实 null 使用 `value(null)`。

Storage 必须能回答：

```text
真实为空？
未采集？
Policy 不允许？
History Boundary 不允许？
只因 Dependency Closure 需要最小结构？
```

## 6. from-now Dependency Closure 必须最小化

Boundary 后的新 Observation 可以依赖 Boundary 前已有 Session / Project / Workspace 等，但只允许发送形成引用图需要的最小字段。

例如旧 LogicalSession：

允许：

- origin identity；
- installation / project / workspace refs；
- Wire Contract 要求的最小结构。

默认不因此允许：

- 旧 title；
- 非必要 startedAt / endedAt；
- Workspace full path；
- Prompt / Tool body；
- SourceRecord payload。

这些保持 `omitted(history-boundary|dependency-minimized)`。

目标是完整引用图，而不是偷偷执行 Metadata History Bootstrap。

## 7. 所有 Policy 共用同一 Remote Replica 路径

禁止：

```text
full -> Local Canonical tables
metadata-only -> replica tables
```

`metadata-only / redacted / full` 全部进入同一 Remote Replica Storage Contract。

这样 Policy 切换不会把同一个 origin Entity 在两个物理世界来回迁移。

## 8. Replica Record 最小逻辑字段

具体 SQL 表设计留给 H5，但每个 Remote Replica Entity 至少可持久化：

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
mapped typed refs
field/body values + availability state
firstReplicatedAt
lastReplicatedAt
```

还要能够表达 current availability 与 retained prior value 的差异。

## 9. ReplicaKey / SharedGroupKey 的存储命名空间

Remote ReplicaKey 使用：

```text
stable('agentlens-replica-r1', nodeId, entityType, originEntityId)
```

编码必须带保留的 Remote Namespace，例如概念上：

```text
replica-r1-<entity-type>-<digest>
```

目的不是让 Web 解析前缀，而是确保它与 Local Canonical 的：

```text
host-*
project-*
session-*
observation-*
...
```

在同一 Hub Query Space 中显式隔离。

Shared Group 也使用独立 namespace / algorithm version，例如：

```text
shared-project-v1-*
shared-asset-v1-*
```

具体字符串编码可以在 H2 固定，但必须保持 domain separation。

## 10. Hub Unified Public ID

Hub `/api/v1/*` 的 Entity ID 对 Web 都是 opaque string。

规则：

- Hub Local Entity：保持现有 Local Canonical ID，保障本机兼容；
- Remote Entity：暴露 ReplicaKey；
- Shared Group：暴露 SharedGroupKey，仅用于 Group / Filter / Aggregation；
- Conditional Shared 领域 FK 仍指 Origin Local ID / Remote ReplicaKey，不指 SharedGroupKey。

因此两个 Node 即使本机都存在：

```text
session-abc
```

Hub 也会得到两个不同 Remote Replica IDs，`/review/:logicalSessionId` 不歧义。

Web 不得通过字符串前缀推断业务 scope；scope/origin 信息走正式 DTO 字段。

## 11. Shared Root / Conditional Shared Storage

### AgentProduct Shared Root

逻辑上一个 Shared Root，但 Remote assertion 不得静默覆盖 Hub Local `agent_products` 行。

Unified Resolver 负责让 Local / Remote Installation 都能解析到同一产品身份，并保留 assertion provenance。

### Project / AssetDefinition

固定：

```text
Local Origin Row / Remote Origin Replica
 -> Shared Group Membership
```

SharedGroupKey 不替代领域 FK。

## 12. Shared Identity 必须由 Hub 验证

Remote Replica 可以携带：

```text
identityAlgorithm
normalizedPortableIdentity
claimedSharedKey
```

Hub 使用协议算法重算 SharedKey，不信任 claimed 值。

当前 Alpha：

```text
project-repository-v1
asset-upstream-v1
```

Identity Algorithm Version 改变可能改变 Shared Group，因此属于正式兼容边界。

## 13. Unified Read Repository 是正式边界

Hub Projection 不允许：

```text
SELECT * FROM replica_private_table
```

也不能把 Remote Replica 强制 cast 成完整 Local Core Entity。

需要正式 Reader / Resolver Contract，职责包括：

- Local Canonical + active Remote Generation；
- ReplicaKey / originNodeId；
- Shared Root / Group；
- availability；
- staged / retired Generation 隔离；
- Node / Host / Shared Project filter；
- 给 Projection 提供稳定 opaque public ID。

接口名在 H5/H8 可调整，但这个边界不可省略。

## 14. Projection 必须 availability-aware

Remote `omitted(policy)` 只能解释成：

```text
未同步 / 已隐藏
```

不能解释成：

```text
来源没有字段
空字符串
结果为空
```

例如 metadata-only 可以统计 Tool Call 数，但不能因为 Tool Result body omitted 就统计“结果为空”。

Interaction 等 Derived Model 仍从可用的 Observation kind / structure 重建，不复制 Projection。

## 15. Policy 收紧与 retained prior value

`full -> metadata-only` 不自动 Purge Hub 已有 full 数据。

如果新 Revision 对某字段只发送 omitted：

- omitted 不是 null；
- 旧值可继续 Retain，直到显式 Purge；
- Storage 必须知道旧值来自较早授权 Revision；
- Projection / Diagnostics 不能把旧值写成“当前 Policy 刚确认的最新值”。

普通用户 UI 不必显示字段级 revision，但内部必须可解释。

## 16. Policy 放宽

用户明确允许后：

```text
omitted -> redacted/value
```

在同一个 ReplicaKey 补字段，不新建 Entity。

是否允许 Boundary 前历史仍由 History Scope 决定。

## 17. Transaction / ACK

单 Batch 的：

```text
Remote Replica mutation
Shared Assertion / Membership
Generation state
Sequence Receipt / Cursor
Tombstone / Conflict
```

位于同一 Storage Transaction Boundary。

只有 Commit 成功后 ACK 推进。

## 18. Replica Generation

```text
G1 active
G2 staged
```

Unified Read 只读 active Generation。

G2 完成 Bootstrap + Reconcile + Validate 后原子激活；对应该 Remote Node Membership 同步切换。

Hub Local Canonical / Local Membership 不属于 Remote Generation。

## 19. Delete / Purge

### Tombstone

删除 Remote origin：

- retire / delete origin Replica；
- withdraw 自己的 Membership；
- dependency-safe；
- 不影响其他 Node / Hub Local origin。

### Delete Node History

按 originNodeId 预演并删除该 Node Remote Replica Data Plane，重算 Shared Groups。

### Policy Purge

清理 Hub 已有旧 full 内容是独立操作，不等于 Revocation 或 Policy Change。

## 20. Recovery

Remote Replica 通常能从 Node Re-bootstrap，但不能假设所有 Control Plane / Security State 都能仅靠 Canonical Scan 恢复。

Hub Identity、Pairing Trust、Sequence Receipt、Tombstone、部分 Membership / Promotion provenance 仍遵守 State / Security Contract。

## 21. 性能要求

H5/H10 必须为真实查询建立索引 / Reader，至少覆盖：

- originNodeId；
- entityType / ReplicaKey；
- Session / Observation 时间序；
- Project / Workspace；
- Tool / Usage；
- Shared Membership；
- active generation。

不能因统一读取重新引入百万 Observation 全表 JSON Scan。

## 22. Storage 验收不变量

- metadata-only Workspace path omitted 不需要假 path；
- omitted SourceRecord payload 不写 `{}`；
- Local Canonical Schema 不为 Hub 全局 nullable；
- 三档 Policy 共用同一 Remote Replica Storage Contract；
- from-now dependency 不泄露 Boundary 前非必要字段；
- real null / omitted / redacted / retained prior value 可区分；
- Policy 放宽在同 ReplicaKey 补字段；
- Hub Local ID / Remote ReplicaKey / SharedGroupKey namespace 不冲突；
- Remote Session 可通过统一 `/review/:logicalSessionId` 唯一定位；
- Local + Remote 通过 Unified Read 聚合；
- staged Generation 不进入正式 Query；
- Hub Local / Remote Shared Group 语义一致；
- Batch failure 不推进 ACK；
- 删除一个 Node 不影响其他 origin；
- Web / Projection 不直接读 Replica 私表；
- 一个 Hub 仍是一个默认 Storage Boundary，不退化成 per-node database federation。

## 23. 当前非目标

Alpha 不要求：

- 修改 Local Core Domain 以表达全部 Replication omission；
- SQLite 透明加密；
- PostgreSQL；
- 每 Node 独立数据库；
- Hub -> Node restore；
- Remote Replica 与 Local Canonical 使用同一 SQL table；
- 提前锁死 Replica Store 是一个 JSON 表还是 typed replica tables。

最后一项由 H5 根据 Repository Contract、查询需求和性能基线决定，但无论物理布局如何，都必须满足本文所有语义不变量。