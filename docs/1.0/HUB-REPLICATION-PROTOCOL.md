# AgentLens 1.0 Hub Replication Protocol

更新日期：2026-08-27  
状态：Alpha Wire Protocol 设计，尚未实现  
上位文档：
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-STATE-CONTRACT.md`

本文定义 AgentLens Node 与 Hub 之间的线上协议边界：Handshake、Replication Stream、Batch Envelope、Sequence / ACK、Bootstrap、Reconciliation、History / Policy Revision、Replica Generation、Shared Identity Assertion、错误模型、Capability Negotiation 与请求 / Hub 身份证明。本文不绑定 SQLite Schema，也不表示协议已经实现。

## 1. 协议目标

> 让一个已配对 Node 将经过 Replication Policy 与 History Scope 允许的 Canonical Entity State，可靠、可恢复、可验证地复制到唯一 upstream Hub。

不负责远程 Web、远程执行、Hub Federation、数据库文件同步、Projection 同步或 Node 直连。

## 2. 版本模型

```text
AgentLens Version       1.0.0-alpha.x
Replication Protocol   R1.x
Storage Schema          migration N
```

- Major：身份、引用、签名、删除、必填字段或 Entity 语义等不兼容变化；
- Minor：向后兼容可选扩展；
- Capability：语义兼容的可选能力，不能代替 Major。

Shared Identity Algorithm 也有独立版本，例如：

```text
project-repository-v1
asset-upstream-v1
```

如果 normalization / key derivation 的改变会让既有实体得到不同 SharedKey，不能只当普通实现优化；必须升级 Identity Algorithm Version，并评估 Protocol Major / Migration。

连接建立后固定使用协商版本。

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
- streamId：sequence / ACK namespace；
- generationId：某 Remote Node Replica 数据集的一代状态。

规则：stream UUID；一个 Node Alpha 最多一个 active stream；sequence 从 1 单调递增；Re-pair 默认新 stream；已认证 relationship 可 Stream Rollover；Cursor 以 nodeId + streamId 为键；Node Identity Reset 生成新 nodeId / stream；stream 不跨 hubId；换 stream 不自动换 generation；Re-bootstrap 可创建 staged generation。

## 4. Pairing Receipt 与 Hub Identity Proof

Pairing 成功后 Hub Identity Private Key 签名 Receipt，至少绑定：

```text
hubId
hubKeyId
nodeId
nodeKeyId / nodePublicKeyFingerprint
replicationStreamId
issuedAt
protocol major range
```

Node 保存 Hub Identity Public Key + Pairing Receipt。TLS Certificate 生命周期与 Hub Identity 分离。

## 5. Handshake

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
  replicationPolicy: 'metadata-only' | 'redacted' | 'full'
  policyRevision: number
  historyRevision: number
  lastLocalAckSequence?: number
}
```

`runtimeInstanceId` 是当前 Daemon 启动实例临时随机标识，只用于连接 / Clone Diagnostics。

```ts
interface ReplicationHandshakeResponse {
  hubId: string
  hubKeyId: string
  serverTime: string
  agentLensVersion: string
  selectedProtocol: { major: number; minor: number }
  capabilities: string[]
  sharedIdentityAlgorithms: string[]
  acceptedStreamId: string
  activeReplicaGenerationId?: string
  hubAckSequence: number
  requiredAction?: 'bootstrap' | 'resume' | 'reconcile' | 'none'
  serverProof: string
}
```

`sharedIdentityAlgorithms` 声明当前连接双方允许使用的 Shared Identity Algorithm。Node 不得发送 Hub 未支持的算法。

serverProof 至少签名 clientNonce、hubId、nodeId、streamId、selectedProtocol、hubAckSequence、serverTime。Node 用已配对 Hub Public Key 验证。

## 6. History Scope / Policy Revision

协议状态表达：

```text
policy
policyRevision
historyRevision
```

History Boundary baseline 不要求进入每个 Batch，但 Status / Diagnostics 必须可关联 revision。

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
  entities: ReplicationEntity[]
  promotions?: IdentityPromotion[]
  tombstones?: ReplicationTombstone[]
  contentHash: string
}
```

单 Batch 完整事务提交 / 回滚，不部分 ACK；数组顺序不决定导入顺序；Domain Ref 使用 Typed EntityRef；payload 只做 Policy transform。

## 8. Deterministic Hash

R1 使用 RFC 8785 / JCS 兼容 Canonical JSON：

```text
SHA-256(canonical JSON bytes)
```

只允许合法 JSON 值；Batch hash 排除自身 contentHash；Entity hash 在 Policy transform 之后；entityVersion、Typed Ref、Shared Identity Assertion、omitted/redacted 都参与 hash；Request Signature 的 Body Hash 对实际 Raw HTTP Body Bytes 计算。

## 9. Sequence 与 ACK

```text
ackSequence = 已事务提交的最高连续 batchSequence
```

- seq == ack+1：正常处理；
- seq <= ack：hash 相同返回已有 ACK，不同 `SEQUENCE_REUSE_CONFLICT`；
- seq > ack+1：`SEQUENCE_GAP`，Hub 不缓存未来 Batch。

## 10. Batch Commit Ambiguity

Batch 第一次可能发网前冻结 sequence / batchId / body / contentHash。超时、连接断开、Hub crash / response lost 时只能 exact retry 或查询 ACK。只有 Hub 明确返回 `committed=false` 才能修正当前 expected sequence 内容。

## 11. Policy 收紧与 Stream Rollover

旧 Policy ambiguous Batch 若包含新 Policy 已禁止正文，不继续重发；旧 stream 暂停；authenticated rollover 建新 stream；generation 保留；新 stream 按新 Policy Reconcile。

## 12. Bootstrap

只有 History Scope 需要已有历史时执行：

```text
Pair -> Bootstrap Scan -> Complete -> Reconciliation -> Incremental
```

不冻结 Local Capture；中断按 ACK 恢复；from-now 遵守持久 History Boundary。

## 13. Replica Generation / Re-bootstrap

```text
G1 active
 -> G2 staged bootstrap
 -> G2 reconciliation
 -> validate complete
 -> atomic activate G2
 -> retire G1
```

G2 未激活前不进入正式 Projection。Generation 还必须包含该 Remote Node 的 Conditional Shared Membership staged set；只有 G2 激活时才原子切换该 Node memberships。

## 14. Incremental 与 Reconciliation

Fast Path：Canonical Change -> Cordis Event -> pending candidate。

Durable Repair：Canonical Store -> History Boundary -> Replication Policy -> Wire Serialization -> Hash -> Compare ACK State -> Repair。

正式语义：at-least-once + deterministic identity + idempotent import + reconciliation。

## 15. Replication Entity DTO

```ts
interface SharedIdentityAssertion {
  algorithm: 'project-repository-v1' | 'asset-upstream-v1' | string
  normalizedIdentity: string
  sharedKey: string
}

interface ReplicationEntityEnvelope {
  entityType: ReplicationEntityType
  scope: 'node' | 'shared'
  originEntityId: string
  sharedKey?: string
  sharedIdentity?: SharedIdentityAssertion
  entityVersion: number
  contentHash: string
  body: unknown
}
```

### Node-scoped

originEntityId 必填；Hub 按独立 `agentlens-replica-r1` domain 重算 ReplicaKey。

### Shared Root

scope=shared；sharedKey 必填；Alpha 主要用于 AgentProduct；Hub 按 Shared Root Contract 验证 / Merge。

### Conditional Shared

Project / AssetDefinition **始终 scope=node**。

有 Portable Identity 时可以附 `sharedIdentity`，但它只是 assertion。Hub 必须：

1. 检查 `algorithm` 已在 Handshake 协商；
2. 从当前 Entity Wire Body 中允许参与身份计算的字段重新运行对应 Replication Identity Resolver；
3. 得到自己的 normalized identity；
4. 按该算法的独立 shared-group domain separator 重新计算 SharedKey；
5. 与 Node 提供的 `normalizedIdentity / sharedKey` 比较；
6. 任一不一致都拒绝 Membership，不得直接信客户端 SharedKey。

R1 不允许 Project / AssetDefinition 以 scope=shared 发送，也不允许 Workspace / AssetBinding 直接引用 Shared Group Key。

## 16. Typed EntityRef

```ts
type EntityRef =
  | { scope: 'node'; entityType: ReplicationEntityType; originEntityId: string }
  | { scope: 'shared'; entityType: SharedRootEntityType; sharedKey: string }
```

Conditional Shared Domain Ref 始终 node ref；shared ref 只用于 Shared Root；Alpha 不允许跨 Node direct Ref。

## 17. Omitted / Redacted

```ts
type ReplicatedValue<T> =
  | { state: 'value'; value: T }
  | { state: 'omitted'; reason: 'policy' | 'not-captured' }
  | { state: 'redacted'; value?: T }
```

Hub 区分真实 null、未采集、Policy omitted、redacted。

## 18. Identity Promotion = Membership Promotion

Promotion = Conditional origin 无 Membership -> 加入 target Shared Group。

DTO 必须携带 Identity Algorithm。Hub 按同算法重算 SharedKey。Promotion 幂等、单向、可追溯；同 origin 不静默改 Group；不得批量改写 Canonical FK。

## 19. Tombstone / Membership Withdrawal

Origin tombstone 删除 origin entity；Conditional origin 删除时撤回自己的 Membership；Shared assertion withdrawal 不影响其他 members；普通扫描缺失不能制造 Tombstone。

## 20. 错误模型

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

| Code | Retryable | 含义 |
| --- | --- | --- |
| `AUTH_INVALID_SIGNATURE` | 否 | Node 请求签名无效 |
| `AUTH_NODE_REVOKED` | 否 | Node 已撤销 |
| `AUTH_CLOCK_SKEW` | 否 | 请求时间超窗 |
| `PROTOCOL_UNSUPPORTED` | 否 | 无共同协议版本 |
| `PROTOCOL_CAPABILITY_REQUIRED` | 否 | 使用未协商能力 |
| `STREAM_UNKNOWN` | 否 | stream 不存在 / ownership 错误 |
| `STREAM_FROZEN` | 否 | stream 已冻结 |
| `SEQUENCE_GAP` | 是 | 缺前序 Batch |
| `SEQUENCE_REUSE_CONFLICT` | 否 | 已提交 sequence 内容变化 |
| `BATCH_TOO_LARGE` | 是 | 需要缩小 Batch |
| `ENTITY_TOO_LARGE` | 否 | 单 Entity 超限 |
| `BATCH_INVALID_REFERENCE` | 否 | Typed Ref / 依赖非法 |
| `BATCH_POLICY_INVALID` | 否 | Wire 内容违反 Policy |
| `IDENTITY_NODE_CONFLICT` | 否 | 同 nodeId 强冲突 |
| `IDENTITY_ALGORITHM_UNSUPPORTED` | 否 | Shared Identity Algorithm 未协商 |
| `SHARED_IDENTITY_MISMATCH` | 否 | Hub 重算 normalized identity / sharedKey 与 Node assertion 不一致 |
| `IDENTITY_PROMOTION_CONFLICT` | 否 | Membership Promotion 冲突 |
| `SHARED_MERGE_CONFLICT` | 否 | Shared invariant 无法合并 |
| `SERVER_BUSY` | 是 | Hub 暂忙 |
| `SERVER_STORAGE_PRESSURE` | 是 | Hub 存储压力 |
| `INTERNAL_ERROR` | 是 | Hub 临时内部错误 |

本地 TLS / Hub Identity / 网络失败使用 Local Diagnostic，不伪装为 Hub 返回错误。

## 21. 请求签名

```text
agentlens-r1\n
<HTTP_METHOD>\n
<PATH>\n
<HUB_ID>\n
<NODE_ID>\n
<REPLICATION_STREAM_ID>\n
<KEY_ID>\n
<TIMESTAMP>\n
<NONCE>\n
<SHA256_RAW_BODY>
```

Hub 验证身份、时钟、nonce、body hash、stream ownership。

## 22. Pairing Request Key Possession

Pair Request 必须有 nodeProof。Pairing Secret = 用户授权；nodeProof = Key possession。

## 23. Transport Surface

```text
POST /replication/v1/pair
POST /replication/v1/handshake
POST /replication/v1/streams/rollover
POST /replication/v1/batches
GET  /replication/v1/status
```

/pair 用 Pair Secret + nodeProof；其他路由用长期 Node Signature。Local Web 继续 127.0.0.1:56789。

## 24. Batch 大小 / 流控

Handshake / Status 可返回 maxBatchBytes / maxEntityBytes / maxEntitiesPerBatch / recommendedBatchBytes / retryAfterMs。Surface 必须在完整 parse 前限 Body Size。R1 不要求压缩。

## 25. Clock Skew

serverTime 只用于安全与 diagnostics，不构成跨机器业务全序。Hub 不用 replicatedAt 覆盖 occurredAt / capturedAt。

## 26. Node Replication 状态机

```text
unpaired
paired
handshaking
bootstrapping
reconciling
synced
degraded
paused
blocked
revoked
```

本地 Canonical Pipeline 独立。

## 27. Sequence / Identity State Retention

Hub 不永久保存 Batch Body，但为可重放 Stream 保存 nodeId / streamId / sequence / contentHash / committedAt。

长期 Identity State 包括 Replica Entity Map、Shared Assertions / Membership、Identity Algorithm Version、Promotion Provenance、Generation、Tombstone；不依赖 Conditional Shared 主键 Alias。

## 28. R1 验收不变量

- Pairing Receipt / serverProof 可验证；
- Signature 身份绑定有效；
- Sequence retry / gap / ambiguity 正确；
- Policy 收紧可 rollover；
- Bootstrap / Reconcile / from-now 正确；
- staged Generation 正确；
- ReplicaKey domain 与本机 ID domain 分离；
- Conditional Shared 始终以 origin node entity 传输；
- Hub 必须按协商 Identity Algorithm 重算 normalized identity / sharedKey；
- Shared Identity mismatch 被拒绝；
- Algorithm Version 不兼容不能静默混用；
- Conditional Shared Ref 不指 Group Key；
- Promotion 只改 Membership；
- Hub Local / Remote 用同一 Identity Algorithm；
- member withdrawal 不影响其他 member；
- omitted / null / redacted 可区分；
- Nonce / Clock Skew / ownership 校验有效；
- Protocol 不兼容不影响本地采集。

## 29. 当前非目标

- Batch 乱序并发；
- 多 upstream Hub / Federation；
- 双向 Canonical Replication；
- Exactly-once；
- Remote Web；
- Server push 控制 Node；
- SQLite / PostgreSQL Schema 传输；
- 基础协议强制压缩；
- Conditional Shared Group Key 成为 Project / AssetDefinition 物理主键。
