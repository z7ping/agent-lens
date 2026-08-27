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

Node-scoped 与 Conditional Shared 的 Origin Row 都使用确定性 Replica Namespace。

规范输入必须带独立 domain separator：

```text
ReplicaKeyMaterial =
  'agentlens-replica-r1'
  + entityType
  + nodeId
  + originEntityId
```

概念上：

```text
ReplicaKey = stable(ReplicaKeyMaterial)
```

要求：

- `entityType` 必须进入 key material；
- Replication Key 使用独立命名域，不能直接复用本机 `project/session/host/...` Identity 的生成域；
- 即使 Core 当前各类 ID 只是 TypeScript `string` alias，也不能因此把语义命名空间混在一起；
- 具体可读前缀可以由 `replication-core` 实现决定，但必须能从格式或 metadata 明确识别“这是 Hub Replica Key”，且同一 R1 算法跨平台稳定；
- 改变 key material、domain separator 或 hash/canonicalization 语义属于 Replication Identity 兼容变化，必须评估 Protocol Major。

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

## 5. Shared Identity Contract 与算法版本

任何 `shared` 或 `conditional-shared` Entity 都必须显式注册：

```text
SharedIdentityContract
MergeContract
```

Conditional Shared 还必须注册：

```text
MembershipContract
```

Shared Identity 算法必须版本化。R1 至少使用类似：

```text
project-repository-v1
asset-upstream-v1
```

的稳定 Algorithm ID。

规则：

- Node 发送的 `sharedKey` 只是 identity assertion，不能直接成为 Hub 信任的目标 ID；
- Hub 必须按已协商 Algorithm Version，从 Wire 中允许参与 Shared Identity 的字段重新执行 Identity Resolver / Normalizer，并重新计算 SharedKey；
- Node 提供的 normalized identity / sharedKey 与 Hub 重算结果不一致时，拒绝该 Membership / Batch，返回稳定 Identity Conflict，而不是使用客户端值；
- 改变 normalization 语义导致既有 identity 可能得到不同 SharedKey 时，必须升级 Shared Identity Algorithm Version，并评估 Protocol Major / Migration；
- Hub 不运行 Source Parser；这里重算的是正式 Replication Shared Identity Contract，不是重新解释原生 Source。

### 5.1 AgentProduct

Shared Identity：

```text
productId
```

例如：claude-code / codex / pi / hermes / opencode。

`productId` 是 invariant。

`name / vendor / homepage`：单边为空取非空；placeholder 与丰富值并存取丰富值；不可解释差异进入 diagnostics；禁止 LWW。

### 5.2 Project

Project 只有存在可靠 Portable Repository Identity 时才加入 Shared Project Group。

R1 Algorithm：

```text
project-repository-v1
```

Repository Identity Normalizer：

- 支持标准 URI 与常见 Git SCP-like Remote；
- 移除 userinfo / credential / query / fragment；
- hostname 小写；
- 去除尾部 `/` 与 `.git`；
- 默认保留 repository path 大小写；Provider 明确大小写不敏感时才进一步规范；
- 本机绝对路径、repositoryRoot、临时目录不得成为 Shared Identity。

示例：

```text
https://github.com/z7ping/agent-lens.git
git@github.com:z7ping/agent-lens.git
 -> github.com/z7ping/agent-lens
```

Shared Group Key 使用独立命名域：

```text
SharedProjectKeyMaterial =
  'agentlens-shared-project-v1'
  + normalizedRepositoryIdentity

SharedProjectKey = stable(SharedProjectKeyMaterial)
```

不能直接使用本机 Project ID 的生成域。

Group Merge Metadata：repositoryIdentity invariant；createdAt=min；lastSeenAt=max；name 为 deterministic display metadata。

这些 merge 结果描述 Group，不覆盖 origin Project Row。

只有本机路径 identity 时，不创建 Membership。

### 5.3 AssetDefinition

只有类型专用 Resolver 证明 upstreamIdentity 是 Portable Identity 时才加入 Shared Asset Group。

R1 Algorithm：

```text
asset-upstream-v1
```

非空字符串不自动等于 Portable Identity；本机路径、临时 ID、安装目录必须拒绝。

Shared Group Key：

```text
SharedAssetKeyMaterial =
  'agentlens-shared-asset-v1'
  + type
  + normalizedPortableUpstreamIdentity

SharedAssetKey = stable(SharedAssetKeyMaterial)
```

Group Merge：type / normalized upstreamIdentity invariant；canonicalName 应一致；displayName deterministic；不可解释冲突进入 Conflict。

仅 canonicalName 时不创建 Membership。

### 5.4 ToolDefinition

Alpha 一律 Node-scoped。`Read` / `Bash` / `Search` 等名字不能证明跨 Agent / Plugin / MCP Schema 等价。

## 6. Typed EntityRef

```ts
type EntityRef =
  | { scope: 'node'; entityType: ReplicationEntityType; originEntityId: string }
  | { scope: 'shared'; entityType: SharedRootEntityType; sharedKey: string }
```

- shared Ref Alpha 只用于真正 Shared Root，例如 AgentProduct；
- Project / AssetDefinition 即使有 Membership，领域 FK 仍使用 node Ref；
- Shared Group Key 通过 Shared Identity Assertion / Promotion 传输，不作为 Project / AssetDefinition FK target；
- Alpha 禁止跨 Node direct Ref。

## 7. 只重写声明式网络 Reference

Remote Import 只把 Node 本地 ID 映射成 Hub 中对应 Replica / Shared Root ID：hostId、installationId、runtimeProfileId、projectId、workspaceId、logicalSessionId、sourceSessionId、actorId、assetDefinitionId、assetBindingId、evidenceRefs、Relationship refs、Coverage subjectRef 等正式字段。

Conditional Shared：

```text
projectId / assetDefinitionId -> origin ReplicaKey
```

不是 Shared Group Key。

严禁搜索替换 CanonicalObservation.payload、SourceRecord.payload、Tool/Prompt 正文、Source Locator 文本或用户/Agent 消息正文。

Wire 不复制派生 interactionId；Coverage 使用 Typed EntityRef。

## 8. Remote Import Dependency DAG

```text
0. validate identity declarations / promotions
1. Shared Roots: AgentProduct
2. Host
3. AgentInstallation / RuntimeProfile
4. Conditional Origin Rows: Project / AssetDefinition
5. Shared Group Assertions / Membership / Promotion
6. Workspace
7. LogicalSession / SourceSession
8. SourceRecord / Evidence
9. AgentActor / SessionRelationship
10. AssetBinding / AssetStateObservation
11. ToolDefinition
12. CanonicalObservation
13. Coverage
14. ObservationEvidence / joins
```

Promotion 可以先声明，但只有 origin row、Algorithm Version、normalized identity 与 target Shared Group 全部校验成功后才落 Membership。

## 9. Shared Assertions 与 Membership

Control Plane 保存来源：

```text
shared_entity_assertions
  origin_node_id
  entity_type
  origin_entity_id
  identity_algorithm
  shared_key
  content_hash
  active
  first_seen_at
  last_seen_at
```

Conditional Shared Membership：

```text
(originNodeId, entityType, originEntityId)
  -> (identityAlgorithm, sharedKey)
```

Group merged metadata 可从 active assertions 重算。

A/B/Hub Local 可各有 Origin Row 但属于同 Group；撤回 A 不影响 B / Hub Local；Group 无 active membership 才 eligible for GC；Group GC 不删仍存在 origin row。

## 10. Identity Promotion

Promotion = Conditional origin 从“无 Membership”变成“加入 Shared Group”。

必须显式、单向、单调、事务性、幂等、可追溯、可重放。

概念 DTO：

```ts
interface IdentityPromotion {
  entityType: 'project' | 'asset-definition'
  originEntityId: string
  identityAlgorithm: string
  targetSharedKey: string
  reason: string
  observedAt: string
  evidence?: PromotionEvidence
}
```

Hub 必须重算 targetSharedKey，不能盲信 DTO。

Promotion 不重写 Canonical FK，不删除 origin row。

同一 Node old/new origin IDs 在强证据下可分别加入同 Group。本机重复实体清理属于独立 Core Identity Migration。

不能依据 name / 目录相似度自动 Promotion；已属于 Shared A 的同 origin 不自动 Rebind 到 B；Asset 必须有来源特有强证据。

## 11. 删除语义

### 11.1 Origin Tombstone

针对 originNodeId + entityType + originEntityId。依赖不安全则整批拒绝。

Conditional origin 删除时同时 withdraw 该 origin membership/assertion，然后重算 Group，不影响其他 member。

### 11.2 Shared Root Assertion Withdrawal

来源撤回 AgentProduct 等描述 assertion 不等于删除 Shared Root。

### 11.3 Shared Group GC

无 active membership/assertion 后 Group 才 eligible for GC。Group GC 不删除仍存在 origin row。Revocation 不自动 withdrawal。

## 12. Hub 本机与远程语义一致

Hub Local Project / AssetDefinition 不经过 HTTPS，但以 Hub nodeId + local Canonical ID 参与同一 Assertion / Membership Contract。

Hub Local FK 和 Remote FK 都保持指向各自 origin row；Shared Project / Asset 视图通过 Group Membership 聚合。

Hub Local Shared Identity Resolver 也必须使用同一 Algorithm Version / Normalizer，不能维护另一套“本机特例算法”。

## 13. Shared Group 与 Projection 边界

Shared Group 是跨 Node Identity / Aggregation Contract，不是第二份 Agent 行为事实。

Projection 通过正式 Repository / Resolver Contract 查询 SharedGroupKey -> member origin entity ids，实现跨设备 Workspace、项目 Session/Usage、Shared Asset 聚合。Web 不直接查 Control Plane 私表。

物化 Group metadata 时必须可由 assertions/memberships 重建，并遵守 ADR-0006。

## 14. Contract 验收不变量

- 两台相同 hostname/platform/arch Node 不冲突；
- ReplicaKey 使用独立 replication domain separator；
- 相同 origin 输入三平台得到相同 ReplicaKey；
- Project 只有本机路径不 Group；
- SSH/HTTPS 同 Remote 经 project-repository-v1 得到同 SharedProjectKey；
- Hub 对 Node 自报 normalized identity/sharedKey 重算不一致时拒绝；
- Identity Algorithm Version 改变不能静默与旧 key 混用；
- Hub Local + Remote 使用相同 Algorithm Version 并进入同 Group；
- 同名无 Portable Identity Skill 不合并；
- ToolDefinition 同名仍 Node-scoped；
- 非复制实体不进入 Batch；
- EntityRef 错误 / 缺依赖 / 非法跨 Node Ref rollback；
- payload ID 字符串不改写；
- Promotion 不改 origin FK，只改 Membership；
- old/new origin IDs 可在强证据下进同 Group；
- 重放 Promotion 不重复 Membership；
- 同 origin 加两个 Group 被拒绝；
- withdrawal 不影响其他 member；
- Group Merge 与到达顺序无关。

## 15. 当前非目标

- Hub Federation / 多 upstream；
- Shared Tool Global Identity；
- Conditional Shared 自动 Rebind；
- 本机 Host / Canonical ID 整库迁移；
- 模糊相似度跨 Node Identity；
- Replication 修改 Node 原生环境；
- Shared Project Group 变成统一物理 Project 主键。
