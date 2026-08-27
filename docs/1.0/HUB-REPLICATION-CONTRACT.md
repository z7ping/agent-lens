# AgentLens 1.0 Hub Replication Contract

更新日期：2026-08-27  
状态：Alpha 架构 Contract，尚未实现  
上位决策：`docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`

本文把 ADR-0007 的多机 Hub 原则收敛为可实现的复制契约，重点定义：Entity Scope、Replica Key、Typed Reference、Shared Identity、Conditional Shared Group、Identity Promotion、删除语义与导入依赖。本文不表示这些能力已经实现。

## 1. 总原则

Hub Replication 只复制已经由 Node 形成、并经过 Replication Policy 与 History Scope 允许离开本机的 Canonical Entity State。

```text
Native Source
  -> Capture Policy
  -> Local Canonical Store
  -> Replication Policy / History Scope
  -> Replication Wire DTO
  -> Hub Remote Import
  -> Hub Unified Store
```

约束：

- Hub 不重新运行 Source Parser / Normalizer；
- Hub 不重新调用普通 `ObservationService.commit()` 猜测远程事实；
- 本机 Canonical ID 不被直接假设为跨机器全局唯一；
- 只重写 Domain Contract 明确定义的网络引用，不递归修改任意 `payload` 字符串；
- Shared 是显式例外，不是默认行为；
- Conditional Shared 的跨机聚合不能破坏 Origin Canonical Row 与 provenance；
- Projection、Diagnostics、Checkpoint、Candidate 等非 Canonical / 可重建 / 运维状态不进入 Canonical Replication Graph。

## 2. Entity Scope 四分类

Replication Scope 固定分为四类：

1. `shared`：具有稳定全局身份，可直接使用一个 Shared Canonical Root；
2. `conditional-shared`：Origin Entity 保持 Node-scoped，满足 Portable Identity 时加入 Shared Identity Group；
3. `node-scoped`：事实属于某个 Node 的本地观察命名空间，Hub 使用 Replica Key；
4. `not-replicated`：不进入 Canonical Replication Graph。

默认规则：

> 任何未显式注册 Shared Identity Contract 的新 Entity，默认 `node-scoped`。宁可在 Hub 保留多份安全副本，也不能因为名字相似误合并不同事实。

### 2.1 Alpha Scope Matrix

| Entity | Alpha Scope | 物理/逻辑语义 |
| --- | --- | --- |
| `AgentProduct` | shared | 稳定 productId，Hub 可使用一个 Shared Canonical Row |
| `Project` | conditional-shared | 每个 origin 保留 Project Row；可靠 Repository Identity 时加入 Shared Project Group |
| `AssetDefinition` | conditional-shared | 每个 origin 保留 AssetDefinition Row；可靠 Portable Upstream Identity 时加入 Shared Asset Group |
| `Host` | node-scoped | 当前 Host ID 不假设跨机唯一 |
| `AgentInstallation` | node-scoped | 绑定 Host / 本机安装路径 |
| `RuntimeProfile` | node-scoped | 绑定 Installation / 原生 Profile |
| `Workspace` | node-scoped | 绑定 Host / 本机路径 |
| `LogicalSession` | node-scoped | 绑定本机 Installation / Workspace |
| `SourceSession` | node-scoped | 绑定 Source + Installation + nativeSessionId |
| `SessionRelationship` | node-scoped | 关系发生在某个 Node 的会话图内 |
| `AgentActor` | node-scoped | 绑定 Installation / Session |
| `SourceRecord` | node-scoped | 原生来源证据输入 |
| `Evidence` | node-scoped | 证据来自 Node 的 SourceRecord / Locator |
| `CanonicalObservation` | node-scoped | Node 是本机事实形成者 |
| `Coverage` | node-scoped | Coverage 声明由 Node 形成，subject 可引用 Shared Root 或 Origin Entity |
| `AssetBinding` | node-scoped | 绑定本机 Installation / RuntimeProfile / Path |
| `AssetStateObservation` | node-scoped | 绑定本机 AssetBinding |
| `ToolDefinition` | node-scoped | Alpha 不按 canonicalName 跨机合并 |
| `Interaction` | not-replicated | 派生 / 表现层边界，由 Hub Projection 重建 |
| `SessionRelationshipCandidate` | not-replicated | Node 本地解释中间态 |
| `SourceCheckpoint` | not-replicated | Node 本地摄取状态 |
| `SourceRuntimeStatus` | not-replicated | 运维 / Diagnostics；通过 Control Plane 展示 |
| Projection / Summary / Usage / Overview / Facet | not-replicated | 可由 Hub 数据重建 |
| Replication Outbox / Cursor / Conflict / Node Registry | not-replicated-as-canonical | Replication Control Plane |

`ObservationCapability` 当前属于运行时能力声明而不是持久 Canonical 行为事实；Alpha 不作为 Canonical Entity 复制。Hub 若需要显示 Node / Source 能力，通过 Node Status / Control Plane 或协议 Capability Negotiation 获取。

## 3. Node-scoped Replica Key

Node-scoped 与 Conditional Shared 的 Origin Row 都使用确定性 Replica Namespace：

```text
ReplicaKey = stable(nodeId, entityType, originEntityId)
```

Wire DTO 必须携带：

```text
originNodeId
entityType
originEntityId
```

`replicaKey` 可以由发送端携带用于诊断，但 Hub 必须按协议算法自行重新计算并校验。

同一个：

```text
nodeId + entityType + originEntityId
```

必须永远映射到同一个 Replica Key。

不同 Node 即使拥有相同本机 `host-xxx` / `project-xxx` / `session-xxx`，在 Hub 中也不会碰撞。

## 4. Shared 分成两种物理语义

这是 Alpha 的固定边界，不能由实现者临场选择。

### 4.1 Shared Root

适用于天然拥有跨机器稳定身份、且不需要保留每个 Node 独立 Canonical Row 的实体。

Alpha 只有：

```text
AgentProduct
```

Shared Root 可以直接使用：

```text
SharedKey -> one Canonical Row
```

多个 Node 对同一 Shared Root 的描述元数据仍需保存 assertion provenance，并按 deterministic Merge Contract 合并。

### 4.2 Conditional Shared Group

适用于 `Project`、`AssetDefinition`。

这些实体的本机 ID、路径、生命周期与来源关系仍属于 origin Node，因此 **不得把 SharedKey 直接替换成它们的 Canonical 主键**。

固定模型：

```text
Node A Project Replica Row ----\
                               +--> SharedProjectGroup
Node B Project Replica Row ----/
Hub Local Project Row --------/
```

即：

```text
Origin Canonical Row
  + Shared Identity Assertion
  + Shared Group Membership
```

而不是：

```text
Origin Row -> 改主键 -> Shared Row -> 全量重写 FK
```

关键要求：

- Workspace / Session / AssetBinding 等声明式 FK 继续指向各自 origin row；
- SharedKey 标识逻辑 Shared Group，不是 Conditional Shared Origin Row 的物理主键；
- 跨机 Project / Asset 视图由 Shared Group + Membership 聚合；
- Hub 本机和 Remote Node 使用同一种 Membership 语义；
- 不需要为了共享聚合批量重写已有 Canonical FK；
- Shared Group / Membership 属于分布式 Identity / Aggregation Contract，可由 assertions 重算，不成为第二套 Agent 行为事实源。

这个模型优先保留 provenance、Local-first 与现有 Canonical Identity，不为 Hub 引入破坏性身份迁移。

## 5. Shared Identity Contract

任何 `shared` 或 `conditional-shared` Entity 都必须显式注册：

```text
SharedIdentityContract
MergeContract
```

Conditional Shared 还必须注册：

```text
MembershipContract
```

没有这些 Contract，不允许跨 Node 聚合。

### 5.1 AgentProduct

Shared Identity：

```text
productId
```

例如：

```text
claude-code
codex
pi
hermes
opencode
```

`productId` 是 invariant。

`name / vendor / homepage` 为描述元数据：

- 单边为空 -> 使用非空值；
- placeholder 与更丰富值并存 -> 使用更丰富值；
- 两个不同非空非 placeholder -> diagnostics + deterministic display rule；
- 禁止 last-write-wins。

### 5.2 Project

Project 只有存在可靠 Portable Repository Identity 时才加入 Shared Project Group。

Repository Identity Normalizer Alpha 规则：

- 支持标准 URI 与常见 Git SCP-like Remote；
- 移除 userinfo / credential / query / fragment；
- hostname 小写；
- 去除尾部 `/` 与 `.git`；
- 默认保留 repository path 大小写；Provider 明确大小写不敏感时才进一步规范；
- 本机绝对路径、`repositoryRoot`、临时目录不得成为 Shared Identity。

示例：

```text
https://github.com/z7ping/agent-lens.git
git@github.com:z7ping/agent-lens.git
```

归一为：

```text
github.com/z7ping/agent-lens
```

Shared Group Key：

```text
SharedProjectKey = stable('project', normalizedRepositoryIdentity)
```

Group Merge Metadata：

- `repositoryIdentity` -> invariant；
- `createdAt` -> `min()`；
- `lastSeenAt` -> `max()`；
- `name` -> deterministic display metadata；差异进入 Diagnostics。

注意：这些 merge 结果描述 Shared Project Group，不要求覆盖任何 origin Project Row 的本机字段。

只有本机路径 identity 时，不创建 Shared Group Membership。

### 5.3 AssetDefinition

只有类型专用 Resolver 证明 `upstreamIdentity` 是 Portable Identity 时，Origin AssetDefinition 才加入 Shared Asset Group。

非空字符串不自动等于 Portable Identity；本机路径、临时 ID、安装目录必须拒绝。

Shared Group Key：

```text
SharedAssetKey = stable('asset', type, normalizedPortableUpstreamIdentity)
```

Group Merge：

- `type` -> invariant；
- normalized `upstreamIdentity` -> invariant；
- `canonicalName` -> 应一致；不可解释冲突进入 Replication Conflict；
- `displayName` -> deterministic display metadata + diagnostics。

仅有 `canonicalName` 时不创建 Shared Membership。

### 5.4 ToolDefinition

Alpha 中 `ToolDefinition` 一律 Node-scoped，即使本机 `installationId` 为空。

`Read`、`Bash`、`Search` 等名字不能证明跨 Agent / Plugin / MCP Schema 完全相同。跨机工具统计由 Projection 聚合，不通过提前合并 ToolDefinition 实体实现。

## 6. Typed EntityRef

Wire Protocol 不传让 Hub 猜作用域的裸 ID。

概念类型：

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

重要规则：

- `shared` Ref 在 Alpha 只用于真正 Shared Root，例如 `AgentProduct`；
- `Project` / `AssetDefinition` 即使拥有 Shared Group Membership，领域 FK 仍使用 `scope: 'node'` 指向 origin entity；
- Shared Group Key 通过 Entity Envelope 的 Shared Identity Assertion / Promotion 传输，不把它伪装成 Project / AssetDefinition FK target；
- Node-scoped Ref 的 nodeId 默认来自 Batch Header；Alpha 禁止跨 Node direct Ref。

Hub Importer：

```text
node ref   -> ReplicaKey / origin entity map
shared ref -> Shared Root map
```

Shared Group Membership 由独立 identity contract 解析。

## 7. 只重写声明式网络 Reference

Remote Import 只把 Node 本地 ID 映射成 Hub 中对应的 Replica / Shared Root ID：

- `hostId`；
- `installationId`；
- `runtimeProfileId`；
- `projectId`；
- `workspaceId`；
- `logicalSessionId`；
- `sourceSessionId`；
- `actorId / parentActorId`；
- `assetDefinitionId / assetBindingId`；
- `evidenceRefs`；
- `SessionRelationship.fromSessionId / toSessionId`；
- Coverage `subjectRef`；
- 其他正式注册的 EntityRef 字段。

对于 Conditional Shared：

```text
projectId / assetDefinitionId
-> origin ReplicaKey
```

不是 Shared Group Key。

严禁对以下内容做字符串搜索替换：

```text
CanonicalObservation.payload
SourceRecord.payload
Tool / Prompt 正文
Source Locator 文本
任意用户 / Agent 消息正文
```

### 7.1 CanonicalObservation

Wire DTO 不复制派生 `interactionId`。Hub 根据 Canonical Observation 重新执行 Interaction Projection。

Observation 的 Domain refs 使用 Typed EntityRef；payload 只经过 Replication Policy transform，不做 ID 字符串替换。

### 7.2 Coverage

本机：

```text
subjectType
subjectId
```

Wire：

```text
subjectRef: EntityRef
```

如果 subject 是 Conditional Shared Project / AssetDefinition，仍引用对应 origin entity；跨机 Group 由 Projection / Shared Group Resolver 解释。

## 8. Remote Import Dependency DAG

Batch 数组顺序不决定落库顺序。Importer 按协议 DAG 处理：

```text
0. validate identity declarations / promotions
1. Shared Roots
   AgentProduct
2. Node Root
   Host
3. Installation
   AgentInstallation
   RuntimeProfile
4. Conditional Origin Rows
   Project
   AssetDefinition
5. Shared Group Assertions / Membership / Promotion
6. Workspace
7. Session
   LogicalSession
   SourceSession
8. Evidence Source
   SourceRecord
   Evidence
9. Actor / Relationship
   AgentActor
   SessionRelationship
10. Asset
   AssetBinding
   AssetStateObservation
11. ToolDefinition
12. CanonicalObservation
13. Coverage
14. ObservationEvidence / join relation
```

Promotion 可以在 DTO 中先声明，但只有 origin row 与 target Shared Group 都校验成功后才落 Membership。

循环引用、缺失必须依赖、Actor parent cycle、非法跨 Node Ref 都使 Batch 回滚。

## 9. Shared Assertions 与 Membership

Control Plane 必须保留每个 Shared 来源，例如：

```text
shared_entity_assertions
  origin_node_id
  entity_type
  origin_entity_id
  shared_key
  content_hash
  active
  first_seen_at
  last_seen_at
```

对于 Conditional Shared，还存在逻辑 Membership：

```text
(originNodeId, entityType, originEntityId)
  -> sharedKey
```

一个 Shared Group 的 merged metadata 应能够从 active assertions 重算。

因此：

- Node A / B / Hub Local 可以拥有三个 Project Origin Rows，但属于一个 Shared Project Group；
- 撤回 A 的 assertion 只移除 A 的 membership，不删除 B / Hub Local origin row；
- Shared Group 无 active membership 后才 eligible for GC；
- Group GC 不等于删除任何仍存在的 origin Canonical Row。

## 10. Identity Promotion

Identity Promotion 只用于 Conditional Shared：某个 origin entity 最初没有可靠 Portable Identity，后来获得可靠 Shared Identity。

典型：

```text
Project Origin P1
  path-only
  -> no shared membership

later:
  git remote discovered
  -> promote P1 into SharedProjectGroup G
```

### 10.1 Promotion 原则

Promotion 必须：

- 显式：由 Node 提交正式 Promotion Assertion；
- 单向：`origin without membership -> shared group membership`；
- 单调：同一个 origin 一旦绑定 Shared A，不能静默改到 Shared B；
- 事务性：Shared Group 建立/合并、assertion、membership 同一事务；
- 幂等；
- 可追溯；
- 可重放。

概念 DTO：

```ts
interface IdentityPromotion {
  entityType: 'project' | 'asset-definition'
  originEntityId: string
  targetSharedKey: string
  reason: string
  observedAt: string
  evidence?: PromotionEvidence
}
```

### 10.2 Promotion 不重写 Canonical FK

Hub 收到合法 Promotion：

```text
BEGIN
  validate origin ownership
  validate conditional-shared contract
  validate target Shared Identity
  ensure Shared Group
  persist / update source assertion
  persist origin -> shared group membership
  persist promotion provenance
COMMIT
```

明确禁止把 Promotion 实现成：

```text
rewrite Workspace.projectId -> SharedKey
rewrite Observation.projectId -> SharedKey
remove origin Project Row
```

原因：

- 会让 Hub Local 与 Remote 形成两套物理语义；
- 会破坏 origin provenance；
- 会迫使本机 IdentityService 理解 Hub Alias；
- Re-bootstrap / Tombstone / Node Identity Reset 更难解释；
- Shared Group 本来就是聚合身份，不需要成为本机领域 FK 主键。

### 10.3 一个 Node 出现多个 Origin ID

Node 本地 Identity 演进后，可能存在：

```text
old Project ID（path identity）
new Project ID（repository identity）
```

只要有强证据证明同一底层 Repository，两者可以分别保留 origin row，并同时 Membership 到同一 Shared Group。

Hub 不需要把旧 origin alias 成新 origin，也不需要删除旧 row；Projection 可以在 Shared Group 视图中聚合它们。

本机重复 Project 清理属于独立 Core Identity Migration，不由 Replication Side Effect 完成。

### 10.4 Project Promotion 触发条件

不能根据：

```text
name 相同
目录名相同
repositoryRoot 看起来相似
```

自动 Promotion。

强证据包括：

- 同一个稳定 Workspace 后续发现 Git Remote；
- Source / Identity 层拥有更强的原生等价关系。

已加入 Shared A 的同一 origin 如果后来 Remote 改成 B，不自动 Rebind。新的 identity 需要新的 origin / 显式 Rebind Contract；Alpha 不迁移历史。

### 10.5 AssetDefinition Promotion

不能仅因 canonicalName 相同 Promotion。

必须有来源特有强证据，例如稳定 Binding、原生资产 ID、明确 upstream mapping。

### 10.6 Promotion Conflict

拒绝：

- 同 origin 已 Membership Shared A，又要求绑定 Shared B；
- target 不满足 Shared Identity Contract；
- Node 试图操作其他 Node origin；
- Shared invariant 冲突。

Alpha 不提供“强制覆盖”。

## 11. 删除语义

### 11.1 Node-scoped / Conditional Origin Tombstone

Tombstone 针对：

```text
originNodeId + entityType + originEntityId
```

Hub 删除 origin row 前必须依赖安全；dependent 未处理时整批拒绝。

如果该 origin 还有 Shared Membership：

```text
delete origin
-> withdraw this origin membership/assertion
-> recompute Shared Group
```

不会删除其他 origin。

### 11.2 Shared Root Assertion Withdrawal

对于 AgentProduct 等 Shared Root，一个 Node 撤回描述 assertion 不等于删除 Shared Root，只是重新计算 merged metadata。

### 11.3 Shared Group GC

```text
no active membership/assertion
-> Shared Group eligible for GC
```

Group GC 只清理聚合 identity/control state；不通过 Group GC 删除其他仍存在的 origin Canonical Row。

Revocation 也不自动等于 withdrawal / delete。

## 12. Hub 本机与远程语义一致

Hub Local Project / AssetDefinition 不经过 HTTPS，但仍以：

```text
originNodeId = Hub nodeId
originEntityId = local Canonical ID
```

参与同一 Shared Assertion / Membership Contract。

因此：

- Hub Local FK 保持指向本机 origin row；
- Remote FK 保持指向 remote replica row；
- Shared Project / Asset 视图统一通过 Group Membership 聚合；
- 不存在“Remote 要改 FK，本机可以不改”的双轨实现。

## 13. Shared Group 与 Projection 边界

Shared Group 是跨 Node Identity / Aggregation Contract，不是第二份 Agent 行为事实。

Projection 可以通过正式 Repository / Resolver Contract 查询：

```text
SharedGroupKey
  -> member origin entity ids
```

从而实现：

- 同一项目跨设备 Workspace；
- 项目级 Session / Usage 聚合；
- Shared Asset 的跨设备状态聚合。

Web 不得直接查询 Control Plane 私表。

如果未来需要物化 Shared Group merged metadata，它必须可由 assertions / memberships 重建，并遵守 ADR-0006 的可重建派生数据原则。

## 14. Contract 验收不变量

实现至少验证：

- 两台相同 hostname/platform/arch 的 Node 不因本机 Host ID 冲突；
- Project 只有本机路径时不跨 Node Group；
- SSH / HTTPS 同 Git Remote 进入同一 Shared Project Group；
- Hub Local + Remote 同 Git Remote 进入同一 Group；
- 两个同名但无 Portable Identity Skill 不合并；
- ToolDefinition 同名仍 Node-scoped；
- Interaction / Checkpoint / Runtime Status / Projection 不进入 Canonical Replication Batch；
- EntityRef Scope 错误、引用缺失、非法跨 Node Ref 使 Batch 回滚；
- payload 内的 ID 字符串不被改写；
- Coverage subject 正确映射；
- Promotion 后 origin Project Row 与其 FK 均保持不变；
- Promotion 只新增/更新 Shared Membership；
- 同一 Node 的 old/new Project Origin IDs 可在强证据下加入同一 Group；
- 重放 Promotion 不产生重复 Membership；
- 同 origin 尝试加入两个 Shared Group 被拒绝；
- 一个 origin withdrawal 不影响其他 origin；
- Shared Merge / Group 结果与 Batch 到达顺序无关。

## 15. 当前非目标

Alpha Contract 不解决：

- Hub Federation；
- 多 upstream Hub；
- Shared Tool Global Identity；
- Conditional Shared Group 自动 Rebind；
- 本机 Host / Canonical ID 整库迁移；
- 自动根据名称、路径、模糊相似度做跨 Node 身份推断；
- 通过 Replication 修改 Node 原生 Agent / Hook / Skill / Shell；
- 把 Shared Project Group 强制改造成所有 Workspace 共用的物理 Project 主键。

这些若未来需要，必须单独 Contract Review / ADR。
