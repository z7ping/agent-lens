# AgentLens 1.0 Hub Replication Protocol

更新日期：2026-08-27  
状态：Alpha R1 Wire Protocol 设计冻结，尚未实现  
上位文档：
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-STATE-CONTRACT.md`
- `docs/1.0/HUB-REPLICA-STORAGE-CONTRACT.md`

本文定义 Node 与 Hub 的线上协议。Protocol 不绑定 SQLite Row，也不要求 Remote Replica 与 Local Canonical 使用相同物理表。

## 1. 协议目标

让一个已配对 Node 将经过 Replication Policy 与 History Scope 授权的 Canonical Entity State，可靠、可恢复、可验证地复制到唯一 upstream Hub。

不负责：Remote Web、Remote Execution、Hub Federation、Projection 同步、数据库文件同步、Node 间直连。

## 2. 版本模型

```text
AgentLens Version       1.0.0-alpha.x
Replication Protocol   R1.x
Storage Schema          migration N
Identity Algorithms     project-repository-v1 / asset-upstream-v1 / ...
Entity Schema           entityType + entityVersion
```

- Protocol Major：破坏 Identity、Reference、Delete、History、Signature、必填 Wire 语义时升级；
- Minor：仅向后兼容扩展；
- Capability：兼容的可选能力，不能代替 Major；
- Identity Algorithm Version：Shared Identity normalization / key 结果改变时必须显式演进；
- `entityVersion`：某个 Replication Entity body 的独立 schema version。

Node 只能按已协商的 Protocol / Capability / Entity Version 发送数据。Hub 不允许“看不懂但先落盘以后再说”的静默降级。

## 3. Relationship / Stream / Generation

R1 区分：

```text
nodeId
hubId
replicationStreamId
replicaGenerationId
```

- nodeId：Node 长期身份；
- hubId：Hub 长期信任身份；
- streamId：Sequence / ACK namespace；
- generationId：该 Remote Node Replica 数据集的一代状态。

规则：一个 Node Alpha 最多一个 active stream；sequence 从 1 单调递增；Re-pair 默认新 stream；已认证关系可 Rollover；换 stream 不自动换 generation；Re-bootstrap 可建 staged generation。

## 4. Pairing Receipt

Hub Identity Private Key 签名 Receipt，至少绑定：

```text
hubId
hubKeyId
nodeId
nodeKeyId / nodePublicKeyFingerprint
replicationStreamId
issuedAt
protocolMajorRange
```

Node 保存 Hub Identity Public Key + Receipt。

Hub Local nodeId 不允许作为 Remote Pairing Node 注册到自己，避免自复制环。

## 5. Handshake

概念 Request：

```ts
interface ReplicationHandshakeRequest {
  nodeId: string
  knownHubId: string
  replicationStreamId: string
  runtimeInstanceId: string
  clientNonce: string
  agentLensVersion: string
  protocol: { major: number; minMinor: number; maxMinor: number }
  capabilities: string[]
  identityAlgorithms: string[]
  entityVersions: Record<string, number[]>
  replicationPolicy: 'metadata-only' | 'redacted' | 'full'
  policyRevision: number
  historyRevision: number
  lastLocalAckSequence?: number
}
```

Response：

```ts
interface ReplicationHandshakeResponse {
  hubId: string
  hubKeyId: string
  serverTime: string
  agentLensVersion: string
  selectedProtocol: { major: number; minor: number }
  capabilities: string[]
  acceptedIdentityAlgorithms: string[]
  acceptedEntityVersions: Record<string, number[]>
  acceptedStreamId: string
  activeReplicaGenerationId?: string
  hubAckSequence: number
  requiredAction?: 'bootstrap' | 'resume' | 'reconcile' | 'none'
  serverProof: string
}
```

`serverProof` 至少绑定：clientNonce、hubId、nodeId、streamId、selectedProtocol、hubAckSequence、serverTime。

没有共同 Protocol / 必需 Identity Algorithm / 必需 Entity Version 时只阻塞 Replication。

## 6. Policy / History Revision

Wire 状态至少关联：

```text
policy
policyRevision
historyRevision
```

History Boundary 的实现细节不要求塞进每个 Batch，但所有 Batch / Status 必须可追溯到对应 Revision。

## 7. Batch Envelope

```ts
interface ReplicationBatch {
  protocol: { major: number; minor: number }
  nodeId: string
  hubId: string
  replicationStreamId: string
  replicaGenerationId: string
  batchSequence: number
  batchId: string
  phase: 'bootstrap' | 'incremental' | 'reconcile'
  createdAt: string
  policy: 'metadata-only' | 'redacted' | 'full'
  policyRevision: number
  historyRevision: number
  entities: ReplicationEntityEnvelope[]
  promotions?: IdentityPromotion[]
  tombstones?: ReplicationTombstone[]
  contentHash: string
}
```

Batch 单事务提交 / 回滚；数组顺序不决定 Import DAG；Domain Ref 使用 Typed EntityRef；payload 不做 ID 字符串替换。

## 8. Deterministic Hash

R1 使用 RFC 8785 / JCS 兼容 Canonical JSON：

```text
SHA-256(canonical JSON bytes)
```

- Batch hash 排除自身 `contentHash`；
- Entity hash 在 Policy / History transform 后计算；
- entityVersion、Typed Ref、Shared Identity assertion、availability state 全部参与 hash；
- Request Signature body hash 对 Raw HTTP Body Bytes 计算。

## 9. Sequence / ACK

```text
ackSequence = 已事务提交的最高连续 batchSequence
```

- `seq == ack+1`：正常处理；
- `seq <= ack` 且 hash 相同：返回已有 ACK；
- `seq <= ack` 但 hash 不同：`SEQUENCE_REUSE_CONFLICT`；
- `seq > ack+1`：`SEQUENCE_GAP`，Hub 不缓存未来 Batch。

## 10. Commit Ambiguity

Batch 第一次可能发网前冻结：sequence、batchId、body、contentHash。

Timeout / connection reset / Hub commit 后 response lost 时，只能 exact retry 或查询 ACK。

只有 Hub 明确返回 `committed=false`，Node 才能重切当前 expected sequence。

## 11. Policy 收紧与 Stream Rollover

若旧 Policy ambiguous Batch 含新 Policy 已禁止内容：

```text
freeze old stream
 -> authenticated rollover
 -> new stream sequence=1
 -> keep active generation
 -> reconcile under new policy
```

禁止为填 Sequence gap 继续发送用户刚禁止的正文。

## 12. Bootstrap / Reconciliation

`include-existing`：

```text
Bootstrap Scan
 -> Complete Marker
 -> Mandatory Reconciliation
 -> Incremental
```

`from-now`：建立持久 Boundary，不执行普通历史 backfill；Boundary 后新事实可以携带最小 Dependency Closure。

Reconciliation 负责修复 `Canonical COMMIT 成功但 fast path 未 enqueue` 等窗口。

## 13. Replica Generation

```text
G1 active
 -> G2 staged bootstrap
 -> G2 reconcile
 -> validate complete
 -> atomic activate G2
 -> retire G1
```

G2 未激活前不进入正式 Unified Read / Projection。

**所有 Remote origin 派生的 Shared Identity State 都必须跟随 Generation staged / activated**，包括：

- Conditional Shared Membership；
- Remote AgentProduct Shared Root assertion；
- 其他未来 Shared Root assertion。

否则 G2 尚未完整时就可能提前改变 active Shared Merge 结果。

Hub Local assertion 不属于 Remote Generation。

## 14. Replication Entity Envelope

Wire Entity 不等于 Core Interface / SQLite Row。

```ts
interface ReplicationEntityEnvelope {
  entityType: ReplicationEntityType
  scope: 'node' | 'shared'
  originEntityId: string
  replicaKey?: string
  sharedKey?: string
  sharedIdentity?: SharedIdentityAssertion
  entityVersion: number
  contentHash: string
  body: unknown
}
```

### Node-scoped

`originEntityId` 必填；Hub 使用 `agentlens-replica-r1` 算法重算 ReplicaKey。

### Shared Root

`scope='shared'`；Alpha 主要用于 AgentProduct。

### Conditional Shared

Project / AssetDefinition **始终 `scope='node'`**，保持 Origin Replica。拥有 Portable Identity 时附带 SharedIdentityAssertion；Shared Group 不是 Domain FK target。

### Entity Version

Hub 对每个 `entityType` 校验 `entityVersion`：

- 支持 -> 正常 decode；
- 未协商 / 未支持 -> `ENTITY_VERSION_UNSUPPORTED`；
- 未知 Entity Type -> `ENTITY_TYPE_UNSUPPORTED`；
- 不允许静默丢字段后假装同步成功。

只有被当前 selected Protocol 明确定义为 optional、且不参与必须 Reference Graph 的扩展，才允许通过 Capability 做可选忽略。

## 15. Shared Identity Assertion

概念：

```ts
interface SharedIdentityAssertion {
  algorithm: 'project-repository-v1' | 'asset-upstream-v1' | string
  normalizedIdentity: string
  claimedSharedKey: string
}
```

规则：

1. Node 先按协商算法 Normalize；
2. 明确凭据在 Normalize / Wire 前去除；
3. Hub 不信任 `claimedSharedKey`；
4. Hub 根据 `algorithm + normalizedIdentity + entityType` 重算 SharedKey；
5. 不一致返回 `SHARED_IDENTITY_MISMATCH`；
6. Hub 不支持算法返回 `IDENTITY_ALGORITHM_UNSUPPORTED`；
7. Project / AssetDefinition 的领域 Ref 仍指 Origin Replica。

Node Signature 证明声明来自哪个 Node，不证明声明的 Repository / Asset 在现实世界一定真实；Alpha 安全模型见 Pairing/Security Contract。

## 16. Typed EntityRef

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

- Project / AssetDefinition 即使有 Membership，Domain Ref 仍是 node ref；
- shared ref 只用于真正 Shared Root；
- Alpha 禁止跨 Node direct Ref；
- Hub Importer 将 node ref 映射到 ReplicaKey，将 shared ref 映射到 Shared Root。

## 17. ReplicatedValue / Availability

R1 必须原生表达缺失原因：

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

真实 null 表达为：

```text
{ state: 'value', value: null }
```

不得用 `null / '' / {} / [hidden]` 混淆这些状态。

Remote Replica Storage 必须持久化 state/reason；Projection 必须尊重 availability。

## 18. `from-now` Dependency-Minimized DTO

Boundary 前 dependency 可以发送 identity / FK 所需字段，但不因此授权整行历史元数据。

Serializer 必须针对 Entity Type 定义 Minimum Dependency Shape。例如旧 Session 被新 Observation 引用时，可携带 session origin identity 与必要 refs，但非必要 title / path / old body / old timing 继续 `omitted(history-boundary|dependency-minimized)`。

这类 DTO 仍使用同一个 entityVersion / Wire Contract，不另建“假 Session”类型。

## 19. Identity Promotion

Promotion 对 Conditional Shared 的固定语义是：

```text
origin without membership
 -> joins target Shared Group
```

Promotion 不修改 Origin 主键，也不 Rewrite Workspace / Session / Observation / AssetBinding FK。

## 20. Tombstone / Membership Withdrawal

Node-scoped / Conditional Origin 删除通过 Tombstone 表达；Conditional Origin 删除同时撤回自己的 Membership。

一个 Member withdrawal 不删除其他 Node / Hub Local Member。普通 scan absence 不制造 Tombstone。

## 21. Hub 对外统一 Entity ID

R1 Replication Wire 使用 originEntityId；Hub Unified Read / `/api/v1/*` 对外 ID：

- Hub Local：保持现有 Local Canonical ID；
- Remote：使用带保留 Replica namespace 的 ReplicaKey；
- Shared Group：使用独立 SharedGroupKey，只用于 Group / Filter / Aggregation；
- 所有 ID 对 Web 都是 opaque string，Web 不通过前缀解析业务语义。

这样现有 `/review/:logicalSessionId` 等路由在 Hub 上也不会因两个 Node 拥有相同本机 Session ID 而歧义。

## 22. 错误模型

```ts
interface ReplicationError {
  code: string
  message: string
  retryable: boolean
  committed?: boolean
  expectedSequence?: number
  conflictId?: string
  retryAfterMs?: number
  suggestedAction?: string
}
```

Alpha 至少：

```text
AUTH_INVALID_SIGNATURE
AUTH_NODE_REVOKED
AUTH_CLOCK_SKEW
PROTOCOL_UNSUPPORTED
PROTOCOL_CAPABILITY_REQUIRED
IDENTITY_ALGORITHM_UNSUPPORTED
SHARED_IDENTITY_MISMATCH
ENTITY_TYPE_UNSUPPORTED
ENTITY_VERSION_UNSUPPORTED
STREAM_UNKNOWN
STREAM_FROZEN
SEQUENCE_GAP
SEQUENCE_REUSE_CONFLICT
BATCH_TOO_LARGE
ENTITY_TOO_LARGE
BATCH_INVALID_REFERENCE
BATCH_POLICY_INVALID
IDENTITY_NODE_CONFLICT
IDENTITY_PROMOTION_CONFLICT
SHARED_MERGE_CONFLICT
SERVER_BUSY
SERVER_STORAGE_PRESSURE
INTERNAL_ERROR
```

## 23. Request Signature

R1 Canonical Signature Input：

```text
agentlens-r1
<HTTP_METHOD>
<PATH>
<HUB_ID>
<NODE_ID>
<REPLICATION_STREAM_ID>
<KEY_ID>
<TIMESTAMP>
<NONCE>
<SHA256_RAW_BODY>
```

Hub 验证身份、ownership、timestamp、nonce、body hash。

## 24. Pairing Request Key Possession

Pairing Request 必须有 `nodeProof`，证明提交者持有 nodePublicKey 对应 Private Key。

Pair Secret = 用户授权；nodeProof = Key possession。

Hub 必须拒绝 `nodeId == hubLocalNodeId` 的自配对关系。

## 25. Transport Surface

```text
POST /replication/v1/pair
POST /replication/v1/handshake
POST /replication/v1/streams/rollover
POST /replication/v1/batches
GET  /replication/v1/status
```

`/pair` 使用 Pair Secret + nodeProof；其他路由使用长期 Node Signature。

Local Web 继续 loopback `127.0.0.1:56789`。

## 26. Resource Limits

Handshake / Status 可返回：

```text
maxBatchBytes
maxEntityBytes
maxEntitiesPerBatch
recommendedBatchBytes
retryAfterMs
```

Surface 必须在完整 parse 前限制 Body Size。R1 不要求压缩。

## 27. Clock Skew

`serverTime` 用于安全 / diagnostics，不构成跨 Node 业务全序。Hub 不用 `replicatedAt` 覆盖 origin `occurredAt / capturedAt`。

## 28. Sequence / Identity Retention

Hub 不永久保存 Batch Body，但为可重放 Stream 至少保存：

```text
nodeId
streamId
sequence
contentHash
committedAt
```

长期状态包括 Replica Entity Map、Shared Assertions / Membership、Promotion provenance、Generation、Tombstone；Conditional Shared 不依赖主键 Alias 维持 FK。

## 29. Runtime Invalidation

Remote Import 事务成功后，Hub 必须发布独立的运行时变更 / invalidation 事件，用于：

```text
Unified Read invalidation
Projection refresh / cache invalidation
surface-http SSE notification
```

它不是 Agent 行为事实，不进入 Canonical Observation，也不能伪造成本机 `observation/committed`。

概念上可以使用：

```text
replication/committed
```

事件至少携带 nodeId、generationId、affected entity/scope 摘要；具体 Cordis Event 名称 H5/H8 可调整。

## 30. R1 验收不变量

- Pairing Receipt / serverProof 可验证；
- Hub 不允许自配对；
- Header / Body 修改导致签名失败；
- Sequence retry / gap / ambiguity 正确；
- Policy 收紧可安全 Rollover；
- `from-now` 不被 Bootstrap / Reconcile / Dependency Closure 绕过；
- `history-boundary / dependency-minimized` 在 Wire / Storage 中可区分；
- staged Generation 未完成不进入正式查询；
- Remote Shared Root assertion 与 Conditional Membership 都跟随 Generation；
- Project / AssetDefinition 以 Origin Replica 传输；
- Promotion 只建立 Membership；
- Hub 对 SharedKey / Identity Algorithm 自行重算验证；
- unknown entity type/version 不静默丢弃；
- Remote Entity Unified ID 不与 Hub Local ID 冲突；
- omitted / redacted / null / retained prior state 可解释；
- Remote Import commit 后有独立 runtime invalidation；
- 非共同 Protocol / Algorithm / Entity Version 只阻塞 Replication；
- Node 本地采集始终独立。

## 31. 当前非目标

- Batch 乱序并发；
- 多 upstream / Federation；
- 双向 Canonical Replication；
- Exactly-once；
- Remote Web；
- Server push 控制 Node；
- SQLite / PostgreSQL Schema 传输；
- 基础协议强制压缩；
- Remote Attestation；
- 把 Conditional Shared GroupKey 变成 Project / AssetDefinition 物理主键。
