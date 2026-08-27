# AgentLens 1.0 Hub Replication Contract

更新日期：2026-08-27  
状态：Alpha 架构 Contract 冻结，尚未实现  
上位决策：`docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`  
相关入口：`docs/1.0/HUB-DESIGN-INDEX.md`

本文定义复制什么、Entity Scope、ReplicaKey、Shared Identity、Typed Ref、Membership、Promotion、Delete 与 Import DAG。物理存储细节以 `HUB-REPLICA-STORAGE-CONTRACT.md` 为准。

## 1. 总原则

```text
Native Source
 -> Capture Policy
 -> Local Canonical Store
 -> Replication Policy / History Scope
 -> Wire DTO
 -> Hub Remote Import
 -> Remote Replica Store / Shared Identity State
 -> Unified Read Repository
```

约束：

- Hub 不重跑 Source Parser / Normalizer；
- Hub 不重新调用普通 ObservationService.commit() 猜远程事实；
- 本机 Canonical ID 不假设跨机全局唯一；
- 只映射正式 Domain Ref，不递归改 payload 字符串；
- Shared 是显式例外，未知 Entity 默认 Node-scoped；
- Conditional Shared 不破坏 Origin provenance；
- Projection / Runtime Diagnostics / Checkpoint / Candidate 不进入 Canonical Replication Graph。

## 2. Entity Scope 四分类

1. `shared`：稳定跨机身份，形成一个逻辑 Shared Root；
2. `conditional-shared`：Origin 保持 Node-scoped，有 Portable Identity 时加入 Shared Group；
3. `node-scoped`：属于具体 Node origin，Hub 使用 ReplicaKey；
4. `not-replicated`：不进入 Replica Data Plane。

默认：未注册 Shared Identity Contract 的新 Entity 一律 `node-scoped`。

### Alpha Scope Matrix

| Entity | Scope | 语义 |
| --- | --- | --- |
| AgentProduct | shared | 一个逻辑 Shared Root；保留各 origin assertion |
| Project | conditional-shared | Origin 保留；Portable Repository Identity -> Shared Project Group |
| AssetDefinition | conditional-shared | Origin 保留；Portable Upstream Identity -> Shared Asset Group |
| Host | node-scoped | 当前 Host ID 不保证跨机唯一 |
| AgentInstallation | node-scoped | 本机安装实例 |
| RuntimeProfile | node-scoped | 本机 Profile |
| Workspace | node-scoped | 本机路径 / Host |
| LogicalSession | node-scoped | 本机会话范围 |
| SourceSession | node-scoped | Source + Installation + nativeSessionId |
| SessionRelationship | node-scoped | 某 Node 会话图关系 |
| AgentActor | node-scoped | 本机 Session / Installation |
| SourceRecord | node-scoped | 原生证据输入 |
| Evidence | node-scoped | Node 证据 |
| CanonicalObservation | node-scoped | Node 形成的事实 |
| Coverage | node-scoped | Node 形成的 Coverage |
| AssetBinding | node-scoped | 本机 Binding / Path |
| AssetStateObservation | node-scoped | 本机 Binding 状态 |
| ToolDefinition | node-scoped | Alpha 不按名称跨机合并 |
| Interaction | not-replicated | Derived，由 Hub Projection 重建 |
| SessionRelationshipCandidate | not-replicated | 本地解释中间态 |
| SourceCheckpoint | not-replicated | 本地摄取状态 |
| SourceRuntimeStatus | not-replicated | Control Plane / Diagnostics |
| Projection / Summary / Usage / Overview | not-replicated | 可重建 |
| Replication Outbox / Cursor / Registry | not-replicated-as-canonical | Control Plane |

## 3. ReplicaKey

Node-scoped 与 Conditional Shared Origin 使用独立命名域：

```text
ReplicaKey = stable(
  'agentlens-replica-r1',
  nodeId,
  entityType,
  originEntityId
)
```

要求：

- nodeId、entityType、originEntityId 全部进入 key material；
- Remote namespace 与本机 `host-* / project-* / session-* / observation-*` 等 ID 域分离；
- Wire 携带 originNodeId / entityType / originEntityId；
- Node 可 claim replicaKey，但 Hub 必须重算；
- 改变 key algorithm / domain separator 属于正式兼容变化。

Hub Unified API：Local Entity 使用 Local Canonical ID；Remote Entity 使用 ReplicaKey；Web 视 ID 为 opaque string。

## 4. Shared Root 与 Conditional Shared Group

### 4.1 Shared Root

Alpha 只有 AgentProduct。

“一个 Shared Root”是**逻辑身份语义**，不要求 Remote assertion 直接覆盖 Hub Local `agent_products` SQL row。物理实现由 Shared Identity / Replica Repository + Unified Resolver 决定。

必须保留：

- 各 Node assertion provenance；
- deterministic merged metadata；
- Local Canonical metadata 不被 Remote arrival order 静默改写。

### 4.2 Conditional Shared Group

Project / AssetDefinition 固定：

```text
Node A Origin ----\
Node B Origin -----+-> Shared Identity Group
Hub Local Origin -/
```

要求：

- Origin Local Row / Remote Replica 保留；
- Workspace / Session / AssetBinding 等 FK 继续指 origin；
- SharedGroupKey 不是领域主键；
- Group / Membership 由 assertions 重算；
- Hub Local 与 Remote 使用同一 Membership Contract；
- Promotion 不批量 Rewrite FK。

## 5. Shared Identity Contract / Algorithm Version

任何 Shared / Conditional Shared Entity 必须注册：

```text
SharedIdentityContract
MergeContract
```

Conditional Shared 还必须注册 MembershipContract。

Alpha Algorithms：

```text
project-repository-v1
asset-upstream-v1
```

Node assertion 必须包含 algorithm + normalized portable identity + claimedSharedKey。

Hub：

1. 验证算法已协商；
2. 根据 normalized identity 重算；
3. 清洗 credential；
4. 重算 SharedKey；
5. claimed value 不一致 -> SHARED_IDENTITY_MISMATCH；
6. unsupported -> IDENTITY_ALGORITHM_UNSUPPORTED。

改变 normalization 语义导致 key 变化时必须升级 Algorithm Version，并评估 Protocol / Migration。

## 6. Project Identity

只有 Portable Repository Identity 可以进入 Shared Group。

`project-repository-v1`：

- 支持标准 URI / 常见 Git SCP-like remote；
- 去 userinfo / credential / query / fragment；
- hostname lower-case；
- 去尾 `/` 与 `.git`；
- 默认保留 repository path case；
- 本机绝对路径 / repositoryRoot 不作为 Shared Identity。

```text
https://github.com/z7ping/agent-lens.git
git@github.com:z7ping/agent-lens.git
 -> github.com/z7ping/agent-lens
```

只有 path identity 时保持 origin-only。

## 7. Asset Identity

AssetDefinition 只有类型专用 Resolver 证明 upstreamIdentity 可移植时才进 Shared Group。

仅 canonicalName 相同不够；本机路径、临时 ID、安装目录不得当 Portable Identity。

ToolDefinition Alpha 全部 Node-scoped。

## 8. Typed EntityRef

```ts
type EntityRef =
  | {
      scope: 'node'
      entityType: ReplicationEntityType
      originEntityId: string
    }
  | {
      scope: 'shared'
      entityType: SharedRootEntityType
      sharedKey: string
    }
```

规则：

- Project / AssetDefinition 即使有 Membership，领域 Ref 仍是 node ref；
- shared ref 只用于真正 Shared Root；
- Alpha 禁止跨 Node direct ref；
- Hub node ref -> ReplicaKey；shared ref -> Shared Root Resolver。

## 9. Reference Mapping

只映射正式领域引用：hostId、installationId、runtimeProfileId、projectId、workspaceId、logicalSessionId、sourceSessionId、actor/parentActor、assetDefinitionId、assetBindingId、Evidence refs、Relationship refs、Coverage subjectRef 等。

Conditional Shared：

```text
projectId / assetDefinitionId -> origin ReplicaKey
```

禁止搜索替换：Observation.payload、SourceRecord.payload、Prompt、Tool body、Locator 文本、任意用户/Agent消息。

Interaction 不复制，由 Hub 重建。

## 10. Import Dependency DAG

概念顺序：

```text
0 validate identity declarations
1 Shared Roots
2 Host
3 Installation / RuntimeProfile
4 Conditional Origin Project / AssetDefinition
5 Shared Assertions / Membership / Promotion
6 Workspace
7 LogicalSession / SourceSession
8 SourceRecord / Evidence
9 AgentActor / Relationship
10 AssetBinding / AssetState
11 ToolDefinition
12 CanonicalObservation
13 Coverage
14 ObservationEvidence join
```

Batch 数组顺序不决定落库顺序。缺 dependency、非法 cross-node ref、Actor cycle 等导致整 Batch rollback。

## 11. Shared Assertions / Membership

Control Plane / Shared Identity State 至少能表达：

```text
originNodeId
entityType
originEntityId
identityAlgorithm
normalizedIdentity
sharedKey
contentHash
active
firstSeenAt / lastSeenAt
replicaGenerationId?   # Remote origin
```

一个 Group 的 merged metadata 必须可由 active assertions 重算。

撤回 A 只移除 A membership，不删除 B / Hub Local origin。无 active membership 后 Group 才 eligible for GC。

## 12. Identity Promotion

Promotion 只用于 Conditional Shared：origin 原来没有 Portable Identity，后来获得可靠身份。

固定语义：

```text
origin without membership
 -> shared group membership
```

必须显式、单向、单调、事务性、幂等、可追溯、可重放。

明确禁止：

```text
rewrite Workspace.projectId -> SharedGroupKey
rewrite Observation.projectId -> SharedGroupKey
remove origin Project Row
```

同 origin 已加入 Shared A 后请求 Shared B -> conflict。

Hub 不根据 name/path 模糊相似度自动 Promotion。

## 13. 同 Node 多个 Origin

Identity 演进后可能有 old path Project ID 与 new repository Project ID。

有强证据时二者可以同时 Membership 到同 Shared Group；Hub 不需要 alias old origin -> new origin，也不通过 Replication Side Effect 清理本机重复 Project。

本机 Identity Migration 是独立问题。

## 14. Deletion

### Origin Tombstone

针对：

```text
originNodeId + entityType + originEntityId
```

删除 origin 前 dependency-safe；如存在 Membership，同时撤回自己的 assertion。

### Shared Root Assertion Withdrawal

只撤回该 Node 描述，不等于删除 Shared Root。

### Shared Group GC

无 active Membership 后 Group 可 GC；Group GC 不删除仍存在的 origin。

Revocation 不自动 Withdrawal / Delete。

## 15. Hub Local / Remote 一致性

Hub Local Project / AssetDefinition 不走 HTTPS，但参与：

```text
originNodeId = hub nodeId
originEntityId = local Canonical ID
Shared Identity Assertion
Shared Group Membership
```

Hub Local FK 指 Local origin；Remote FK 指 Remote ReplicaKey；统一项目视图通过 Group Resolver 聚合。

## 16. Remote Replica Storage 边界

Replication Contract 只定义数据语义，不要求 Remote Replica 满足现有 Local Canonical SQL NOT NULL 约束。

合法 omission：

```text
omitted(policy)
omitted(not-captured)
omitted(history-boundary)
omitted(dependency-minimized)
```

物理存储必须遵守 `HUB-REPLICA-STORAGE-CONTRACT.md`：

- 不用空串 / `{}` / `[hidden]` 伪造字段；
- 三档 Policy 共用同一 Replica Store；
- Local Core Domain 不因 Hub 全局 nullable；
- Unified Read 负责把 Local + Remote 提供给 Projection。

## 17. from-now Dependency Closure

Boundary 后新事实可以携带 Boundary 前必要 dependency，但只发送 Entity Type 的 Minimum Dependency Shape。

不能因依赖旧 Session 顺带上传其旧 title、非必要 time、full path、Prompt/Tool body、SourceRecord payload。

## 18. Projection Boundary

Shared Group 是 Identity / Aggregation Contract，不是第二份 Agent 行为事实。

Projection 通过正式 Unified Read / Shared Group Resolver 查询，不直接读 Control Plane / Replica 私表。

如果未来物化 Group metadata，必须由 assertions / memberships 可重建，并遵守 ADR-0006。

## 19. 验收不变量

- 两台同 hostname/platform/arch Node 不因 Host ID 冲突；
- Remote ReplicaKey 与 Local ID namespace 不碰撞；
- path-only Project 不跨 Node Group；
- SSH / HTTPS 同 Remote 进入同 Shared Project Group；
- Hub Local + Remote 同 Project 进入同 Group；
- 同名无 Portable Identity Asset 不合并；
- ToolDefinition 同名仍 Node-scoped；
- Interaction / Checkpoint / RuntimeStatus / Projection 不复制；
- Hub 重算 SharedKey / Algorithm；
- payload ID 字符串不被改写；
- Promotion 不修改 origin FK；
- same origin 不能静默加入两个 Group；
-一个 withdrawal 不影响其他 origin；
- Shared Merge 与 arrival order 无关；
- Remote omission 不伪造成 Local Canonical 值；
- from-now dependency 不泄露非必要历史字段。

## 20. 当前非目标

- Hub Federation / 多 upstream；
- Shared Tool Global Identity；
- Conditional Shared 自动 Rebind；
- 本机 Host / Canonical ID 整库迁移；
- 模糊相似度跨 Node Identity；
- Remote Attestation；
- 把 Shared Project Group 变成所有 Workspace 共用的物理 Project 主键。
