# AgentLens 1.0 Hub Replication Contract

更新日期：2026-08-27  
状态：Alpha 架构 Contract，尚未实现  
上位决策：`docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`

本文把 ADR-0007 的多机 Hub 原则收敛为可实现的复制契约，重点定义：Entity Scope、Replica Key、Typed Reference、Shared Merge、Identity Promotion、删除语义与导入依赖。本文不表示这些能力已经实现。

## 1. 总原则

Hub Replication 只复制已经由 Node 形成、并经过 Replication Policy 允许离开本机的 Canonical Entity State。

```text
Native Source
  -> Capture Policy
  -> Local Canonical Store
  -> Replication Policy
  -> Replication Wire DTO
  -> Hub Remote Import
  -> Hub Unified Canonical Store
```

约束：

- Hub 不重新运行 Source Parser / Normalizer；
- Hub 不重新调用普通 `ObservationService.commit()` 猜测远程事实；
- 本机 Canonical ID 不被直接假设为跨机器全局唯一；
- 只重写 Domain Contract 明确定义的引用字段，不递归修改任意 `payload` 字符串；
- Shared 是显式例外，不是默认行为；未知 / 新增 Entity 默认按 Node-scoped 处理，直到它拥有正式 Shared Identity + Merge Contract；
- Projection、Diagnostics、Checkpoint、Candidate 等非 Canonical / 可重建 / 运维状态不进入 Canonical Replication Graph。

## 2. Entity Scope 四分类

Replication Scope 固定分为四类：

1. `shared`：具有可靠跨机器身份，可由多个 Node 汇聚为同一个 Hub Entity；
2. `conditional-shared`：只有满足明确的 Portable Identity 条件时才 Shared，否则退回 Node-scoped；
3. `node-scoped`：事实属于某个 Node 的本地观察命名空间，Hub 使用 Replica Key；
4. `not-replicated`：不进入 Canonical Replication Graph。

默认规则：

> 任何未显式注册 Shared Identity Contract 的新 Entity，默认 `node-scoped`。宁可在 Hub 保留多份安全副本，也不能因为名字相似误合并不同事实。

### 2.1 Alpha Scope Matrix

| Entity | Alpha Scope | 说明 |
| --- | --- | --- |
| `AgentProduct` | shared | 产品身份由稳定 productId 决定 |
| `Project` | conditional-shared | 仅可靠、可移植的 Repository Identity 才 Shared；本机路径不是 Shared Identity |
| `AssetDefinition` | conditional-shared | 仅通过类型专用 Portable Upstream Identity Contract 才 Shared；仅 canonicalName 不足以证明同一资产 |
| `Host` | node-scoped | 当前 Host ID 只满足单机稳定性，不假设跨机唯一 |
| `AgentInstallation` | node-scoped | 绑定 Host / 本机安装路径 |
| `RuntimeProfile` | node-scoped | 绑定 Installation / 原生 Profile |
| `Workspace` | node-scoped | 绑定 Host / 本机路径 |
| `LogicalSession` | node-scoped | 绑定本机 Installation / Workspace |
| `SourceSession` | node-scoped | 绑定 Source + Installation + nativeSessionId |
| `SessionRelationship` | node-scoped | 关系发生在某个 Node 的会话图内 |
| `AgentActor` | node-scoped | 绑定 Installation / Session |
| `SourceRecord` | node-scoped | 原生来源证据输入，属于 Node 观察命名空间 |
| `Evidence` | node-scoped | 证据来自 Node 的 SourceRecord / Locator |
| `CanonicalObservation` | node-scoped | Node 是本机事实形成者 |
| `Coverage` | node-scoped | Coverage 声明由 Node 观察形成，但 subject 可引用 Shared 或 Node-scoped Entity |
| `AssetBinding` | node-scoped | 绑定本机 Installation / RuntimeProfile / Path |
| `AssetStateObservation` | node-scoped | 绑定本机 AssetBinding |
| `ToolDefinition` | node-scoped | Alpha 不按 canonicalName 跨机合并，避免不同 Agent / Plugin 同名工具误合并 |
| `Interaction` | not-replicated | 派生 / 表现层边界，由 Hub Projection 重建 |
| `SessionRelationshipCandidate` | not-replicated | Node 本地解释中间态，只复制最终 Relationship |
| `SourceCheckpoint` | not-replicated | Node 本地摄取状态 |
| `SourceRuntimeStatus` | not-replicated | 运维 / Diagnostics；若 Hub 需要展示，通过 Control Plane 上报 |
| Projection / Summary / Usage / Overview / Facet | not-replicated | 可由 Hub Canonical Store 重建 |
| Replication Outbox / Cursor / Conflict / Node Registry | not-replicated-as-canonical | 属于 Replication Control Plane，不是 Agent 行为事实 |

`ObservationCapability` 当前属于运行时能力声明而不是持久 Canonical 行为事实；Alpha 不作为 Canonical Entity 复制。Hub 若需要显示 Node / Source 能力，通过 Node Status / Control Plane 或协议 Capability Negotiation 获取。

## 3. Node-scoped Replica Key

机器作用域 Entity 使用确定性 Replica Namespace：

```text
ReplicaKey = stable(nodeId, entityType, originEntityId)
```

Wire DTO 必须携带：

```text
originNodeId
entityType
originEntityId
```

`replicaKey` 可以由发送端携带用于诊断，但 Hub 必须能够自行按协议算法重新计算并校验，不能盲目信任客户端提供的目标主键。

同一个：

```text
nodeId + entityType + originEntityId
```

必须永远映射到同一个 Replica Key。

不同 Node 即使拥有相同本机 `host-xxx` / `session-xxx` / `observation-xxx`，在 Hub 中也不会碰撞。

## 4. Shared Identity Contract

Shared Entity 必须显式注册两类 Contract：

```text
SharedIdentityContract
MergeContract
```

没有二者，不允许 Shared。

### 4.1 AgentProduct

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

`productId` 是 Identity Field，不允许矛盾。

`name / vendor / homepage` 属于描述元数据，不应因为展示字段差异阻断整个 Batch。合并规则必须与到达顺序无关：

- 单边为空 -> 使用非空值；
- 明确 placeholder（例如 `name == productId`）与更丰富值并存 -> 使用更丰富值；
- 两个不同的非空非 placeholder 值 -> 记录 Replication Diagnostics，并按稳定 deterministic 规则选择展示值；不得 last-write-wins。

### 4.2 Project

`Project` 只有在存在可靠 Portable Repository Identity 时 Shared。

允许 Shared 的 identity 必须经过 Repository Identity Normalizer。Alpha 规则：

- 支持标准 URI 与常见 Git SCP-like Remote；
- 移除 userinfo / credential / query / fragment；
- hostname 小写；
- 去除尾部 `/` 与 `.git`；
- 默认保留 repository path 大小写；若某 Provider 明确大小写不敏感，可由 Provider-specific Normalizer 进一步规范化；
- 本机绝对路径、`repositoryRoot`、临时目录不得成为 Shared Identity。

示例：

```text
https://github.com/z7ping/agent-lens.git
git@github.com:z7ping/agent-lens.git
```

可归一为同一 Portable Identity：

```text
github.com/z7ping/agent-lens
```

Shared Key：

```text
SharedProjectKey = stable('project', normalizedRepositoryIdentity)
```

Merge：

- `repositoryIdentity` -> invariant identity；
- `createdAt` -> `min()`；
- `lastSeenAt` -> `max()`；
- `name` -> 展示元数据，不因大小写 / 本地目录名差异阻断 Batch；优先由 normalized repository identity 派生稳定 display name，差异进入 Diagnostics。

如果 Project 只有本机路径 identity，则按 Node-scoped 复制。

### 4.3 AssetDefinition

`AssetDefinition` 不能因为两个资产都叫 `review` / `default` / `memory` 就跨 Node 合并。

只有类型专用 Shared Identity Resolver 确认 `upstreamIdentity` 是 Portable Identity 时才 Shared。一个非空字符串本身不代表可全局共享：本机路径、临时 ID、安装目录等必须拒绝作为 Shared Identity。

Shared Key：

```text
SharedAssetKey = stable('asset', type, normalizedPortableUpstreamIdentity)
```

Merge：

- `type` -> invariant；
- normalized `upstreamIdentity` -> invariant；
- `canonicalName` -> 应一致；不可解释的非空冲突进入 Replication Conflict；
- `displayName` -> 展示元数据，允许 deterministic merge + diagnostics。

仅有 `canonicalName` 时，Alpha 一律 Node-scoped。

### 4.4 ToolDefinition

Alpha 中 `ToolDefinition` 一律 Node-scoped，即使本机 `installationId` 为空。

原因：`Read`、`Bash`、`Search` 等 canonicalName 不能证明跨 Agent / Plugin / MCP Schema 完全相同。跨机工具统计由 Projection 根据 `canonicalName + sourceType + asset identity + schemaHash` 等读取维度聚合，不通过提前合并 ToolDefinition 实体实现。

未来若要 Shared Tool，必须单独新增 Tool Global Identity Contract。

## 5. Typed EntityRef

Replication Wire Protocol 不传需要 Hub 猜作用域的裸 Canonical ID。

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
      entityType: SharedEntityType
      sharedKey: string
    }
```

Node-scoped Ref 的 `nodeId` 默认来自 Batch Header，跨 Node 引用在 Alpha 不允许；如果未来协议允许跨 Node Ref，必须显式携带目标 `originNodeId`。

Hub Importer 根据 EntityRef 解析最终 Hub ID：

```text
node ref   -> Entity Map / ReplicaKey / Alias
shared ref -> Shared Identity Map
```

禁止让 Importer根据字符串格式猜 `host-xxx`、`project-xxx` 属于哪种 Scope。

## 6. 只重写声明式 Domain Reference

Remote Import 只重写 Core / Replication Contract 明确定义的引用：

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
- 其他未来正式注册的 EntityRef 字段。

严禁对以下内容执行字符串搜索替换：

```text
CanonicalObservation.payload
SourceRecord.payload
Tool / Prompt 正文
Source Locator 文本
任意用户 / Agent 消息正文
```

即使 payload 中某个普通字符串恰好等于 `session-xxx`，也仍然是被观察事实内容，不是数据库外键。

### 6.1 CanonicalObservation

Wire DTO 不复制派生的 `interactionId`。Hub 根据 Canonical Observation 重新执行 Interaction Projection。

Observation 的 Domain refs 使用 Typed EntityRef；`payload` 只经过 Replication Policy 的 omitted / redacted / full 处理，不进行 Entity ID 重写。

### 6.2 Coverage

本机 `Coverage` 使用：

```text
subjectType
subjectId
```

Wire 层必须转换为：

```text
subjectRef: EntityRef
```

Hub 解析 EntityRef 后再落入自己的 `subjectType / subjectId`，避免 Shared / Node-scoped subject 混淆。

## 7. Remote Import Dependency DAG

Batch 不要求发送端严格按数据库外键顺序排列；Hub Importer 按协议注册的依赖 DAG 解析、校验和导入。

Alpha 推荐阶段：

```text
0. Identity / Scope Declarations / Identity Promotion
1. Shared Roots
   AgentProduct
   Shared Project
   Shared AssetDefinition
2. Node Root
   Host
3. Installation
   AgentInstallation
   RuntimeProfile
4. Node Conditional Roots
   Node-scoped Project
   Node-scoped AssetDefinition
5. Workspace
6. Session
   LogicalSession
   SourceSession
7. Evidence Source
   SourceRecord
   Evidence
8. Actor / Relationship
   AgentActor（parent actor 按 actor DAG）
   SessionRelationship
9. Asset
   AssetBinding
   AssetStateObservation
10. ToolDefinition
11. CanonicalObservation
12. Coverage
13. ObservationEvidence / 其他 join relation
```

循环引用、缺失必须引用、Actor parent cycle、非法跨 Node Ref 等都使 Batch 失败并整体回滚。

Hub 不因为 DTO 数组顺序不同而得到不同结果。

## 8. Shared Source Assertions

Shared Entity 不能只保存最终合并结果而丢失各 Node 的来源状态，否则删除、撤销或字段更新后无法重新计算 deterministic merge。

Replication Control Plane 必须保存每个 Shared Assertion 的来源，例如概念上：

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

Shared Canonical Row 是这些 active assertions 按 Merge Contract 得出的结果，并应能够从 assertions 重算。

因此：

- Node A / B 同时报告同一 Project 时，Hub 保留两个来源 assertion，但 Canonical Project 可只有一个 Shared Row；
- 某个 Node 撤回 assertion 后，重新从剩余 active assertions 计算 Merge；
- 一个来源撤回不能无条件删除仍由其他 Node 引用 / 断言的 Shared Entity。

## 9. Identity Promotion

Identity Promotion 只用于 `conditional-shared` Entity：某个 Entity 最初只能安全视为 Node-scoped，后来获得可靠 Portable Shared Identity。

典型例子：

```text
第一次观察：
D:\code\agent-lens
只有本机 repositoryRoot
-> Node-scoped Project

后来发现：
git@github.com:z7ping/agent-lens.git
-> Portable Repository Identity
-> Shared Project
```

### 9.1 晋升原则

Identity Promotion 必须：

- 显式：由 Node 发送正式 Promotion Assertion；Hub 不按名称 / 路径相似度自动猜；
- 单向：Alpha 只支持 `node-scoped -> shared`；
- 单调：同一个 origin entity 一旦晋升到某 Shared Key，不能静默晋升到另一个 Shared Key；
- 事务性：Shared merge、Alias、Reference Rewrite 必须在同一事务完成；
- 幂等：重复 Promotion Assertion 不产生重复实体或重复改写；
- 可追溯：永久保留 origin identity 与 promotion provenance；
- 可重放：旧 Batch 重放后仍解析到晋升后的 Shared Entity。

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

Promotion DTO 由 Node 身份签名，并遵守同一 Replication Protocol / Policy。

### 9.2 Hub 晋升事务

Hub 收到合法 Promotion 后：

```text
BEGIN
  validate origin ownership
  validate conditional-shared contract
  validate target Shared Identity
  create / merge Shared target
  persist source assertion
  persist permanent alias
  update origin -> resolved Hub entity mapping
  rewrite declared foreign-key references from old ReplicaKey -> SharedKey
  merge / remove unreferenced old replica row
COMMIT
```

永久 Alias 概念：

```text
(old ReplicaKey) -> (SharedKey)
```

Alias 不因旧 replica row 被移除而删除。

这样：

- 已经同步到 Hub 的旧 Session / Workspace / Observation 引用被事务性改到 Shared Entity；
- 后续 Node 仍发送旧 `originEntityId` 的 EntityRef 时，Importer 通过 Entity Map / Alias 解析到 SharedKey；
- Bootstrap 重放或旧 Batch 重试不会重新制造旧 Node-scoped Project。

### 9.3 Project Promotion 触发条件

Hub 自己绝不根据：

```text
name 相同
目录名相同
repositoryRoot 看起来相似
```

推断 Promotion。

Node 只有在能够明确断言“旧本机 Project 与新 Portable Repository Identity 是同一底层 Workspace / Repository”时才发送 Promotion。

Alpha 推荐的强证据：

- 同一个稳定 Node-scoped Workspace（本机 host + path 身份不变）；
- 此前只有本机 repositoryRoot；
- 后续在同一 Workspace 中读取到规范化后的 Git Remote / Repository Identity；
- 或 Source / Identity 层拥有更强的原生等价证据。

如果一个已经 Shared 的 Project 从 Repository A 改成 Repository B，这不是 Promotion，而是 Identity Rebind / Repository Change。Alpha 不做自动历史重绑：新的事实进入新的 Shared Identity，旧历史仍属于旧 Shared Identity；未来若要迁移历史必须单独设计 Rebind Contract。

### 9.4 AssetDefinition Promotion 触发条件

Asset 不能仅因为新旧 `canonicalName` 一样就晋升。

Node 必须拥有能证明同一个底层资产的来源特有等价证据，例如：

- 同一个本地 Binding / 安装上下文加稳定内容身份；
- Source 原生资产 ID；
- 后续解析出的 Portable Upstream Identity 与旧本地资产之间有明确来源映射。

没有强等价证据时，保留旧 Node-scoped AssetDefinition，新 Shared AssetDefinition 作为另一个实体；宁可重复，不误合并。

### 9.5 Promotion Conflict

以下情况必须拒绝并记录 Replication Conflict：

- 同一个 `originNodeId + entityType + originEntityId` 已晋升到 Shared A，又请求晋升到不同 Shared B；
- Promotion target 不满足对应 Shared Identity Contract；
- Node 试图晋升另一个 Node 拥有的 origin entity；
- 晋升需要形成非法 FK / cycle；
- Shared Identity 的 invariant fields 冲突。

Alpha 不提供“强制覆盖”快捷路径。

## 10. Shared 删除与 Node-scoped 删除语义不同

### 10.1 Node-scoped Tombstone

Node-scoped Entity 的 Tombstone 针对：

```text
originNodeId + entityType + originEntityId
```

Hub 解析 Replica / Alias 后执行依赖校验。存在未删除 dependent entity 时不得破坏 FK；Delete Batch 必须按依赖逆序处理或整体拒绝。

### 10.2 Shared Assertion Withdrawal

Shared Entity 的某个 Node 删除 / 不再声明，并不意味着 Hub 可以直接删除 Shared Row。

正确语义：

```text
withdraw source assertion
-> recompute shared merge
-> if other active assertions / canonical refs remain: keep Shared Entity
-> if no active assertion and no canonical refs remain: eligible for GC / tombstone cleanup
```

Identity Promotion 后，旧 Node-scoped origin 的 Tombstone 也只撤回该 origin 对 Shared Entity 的 assertion / membership，不得误删其他 Node 正在使用的 Shared Project / Asset。

因此 Shared 生命周期依赖来源 assertion 集，而不是 `last writer`。

## 11. Promotion 与 Node 本机数据解耦

Hub Promotion 不要求修改 Node 已经存在的 Canonical 主键。

例如 Node 本地可能同时留下：

```text
old local Project ID（路径 identity）
new local Project ID（repository identity）
```

这是本机 Identity Migration / Cleanup 问题，不由 Hub 强制重写。

Hub 可以把两个 origin IDs 通过明确 assertion / alias 解析到同一个 Shared Project，同时保留完整 provenance。

如果未来要清理 Node 本机重复 Project 或迁移 Host ID，必须作为独立 Core Identity Migration 处理，不能由 Replication Side Effect 静默改写本机数据库。

## 12. Contract 验收不变量

实现必须至少验证：

- 两台同 hostname / platform / arch 的 Node 上传相同本机 Host ID 时，Hub 产生不同 Replica Host；
- Project 只有本机路径时不会跨 Node 合并；
- SSH / HTTPS 表达的同一 Git Remote 经 Normalizer 后汇聚到同一 Shared Project；
- 两个同名但无 Portable Identity 的 Skill 不会被误合并；
- ToolDefinition 即使 canonicalName 相同也保持 Node-scoped；
- Interaction / Checkpoint / Runtime Status / Projection 不进入 Canonical Replication Batch；
- EntityRef 的 Scope 错误、引用缺失、非法跨 Node Ref 会使 Batch 事务回滚；
- Observation payload 内恰好出现某 Canonical ID 字符串时不会被 Reference Rewrite 修改；
- Coverage subject 使用 Typed EntityRef 正确映射；
- Project Promotion 后已有 Workspace / Session / Observation 引用统一改指 Shared Project；
- Promotion 后重放旧 Batch 不重新生成旧 Replica Project；
- 同一 origin 尝试晋升到两个 Shared Key 时被拒绝；
- 一个 Node 撤回 Shared Project assertion 不会删除其他 Node 仍使用的 Shared Project；
- Shared Merge / Promotion 结果与 Batch 到达顺序无关。

## 13. 当前非目标

Alpha Contract 不解决：

- Hub Federation；
- 多 upstream Hub；
- Shared Tool Global Identity；
- 已 Shared Entity 的自动 Rebind / 历史迁移；
- 本机 Host ID / Canonical ID 整库迁移；
- Hub 自动根据名称、路径、模糊相似度做跨 Node 身份推断；
- 通过 Replication 修改 Node 原生 Agent / Hook / Skill / Shell。

这些若未来需要，必须单独进行 Contract Review / ADR。
