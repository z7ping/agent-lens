# AgentLens 1.0 Hub Replication Protocol

更新日期：2026-08-27  
状态：Alpha Wire Protocol 设计，尚未实现  
上位文档：
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-STATE-CONTRACT.md`

本文定义 AgentLens Node 与 Hub 之间的线上协议边界：Handshake、Replication Stream、Batch Envelope、Sequence / ACK、Bootstrap、Reconciliation、History / Policy Revision、Replica Generation、错误模型、Capability Negotiation 与请求 / Hub 身份证明。本文不绑定 SQLite Schema，也不表示协议已经实现。

## 1. 协议目标

Replication Protocol 只解决一件事：

> 让一个已配对 Node 将经过 Replication Policy 与 History Scope 允许的 Canonical Entity State，可靠、可恢复、可验证地复制到唯一 upstream Hub。

不负责：

- 远程 Web 登录；
- Agent / Shell / Hook / Skill 远程执行；
- Hub Federation；
- 数据库文件同步；
- Projection 同步；
- Node 之间直接通信。

## 2. 版本模型

协议版本与 AgentLens 产品版本、Storage Schema 独立：

```text
AgentLens Version       1.0.0-alpha.x
Replication Protocol   R1.x
Storage Schema          migration N
```

Alpha 初始协议为 `R1`。

语义：

- Major：不兼容的身份、引用、签名、删除、必填字段或 Entity 语义变化；
- Minor：保持向后兼容的可选字段 / Capability 扩展；
- Capability：只表达语义兼容的可选能力，不能替代真正的 Major 升级。

连接建立后，在当前连接上使用双方协商出的固定协议版本，不在同一请求链中动态切换版本。

## 3. Replication Relationship / Stream / Generation

R1 明确区分：

```text
nodeId
hubId
replicationStreamId
replicaGenerationId
```

- `nodeId`：Node 长期实例身份；
- `hubId`：Hub 长期信任身份；
- `replicationStreamId`：sequence / ACK 的顺序命名空间；
- `replicaGenerationId`：Hub 中某个 Node Replica 数据集的一代状态。

每次成功 Pairing 建立第一条持久 Stream：

```text
nodeId + hubId + replicationStreamId
```

规则：

- `replicationStreamId` 使用随机 UUID；
- 一个 Node Alpha 同时最多一个 active stream；
- 同一 stream 内 `batchSequence` 从 1 单调递增；
- Re-pair 默认创建新 stream，旧 stream 冻结；
- 已认证 relationship 可以按 State Contract 执行 Stream Rollover，不要求重新 Pair；
- Hub Cursor 以 `nodeId + replicationStreamId` 为键；
- Node Identity Reset 必须创建新 nodeId 与新 stream；
- stream 不能跨 `hubId` 搬用；
- 换 stream 不自动换 Replica Generation；
- Re-bootstrap 可以创建新的 staged Replica Generation。

## 4. Pairing Receipt 与 Hub Identity Proof

Hub Identity 不能只是数据库里一个从未参与密码学验证的 UUID / Public Key。

Pairing 成功后，Hub 使用 Hub Identity Private Key 生成签名 Receipt，至少绑定：

```text
hubId
hubKeyId
nodeId
nodeKeyId / nodePublicKeyFingerprint
replicationStreamId
issuedAt
protocol major range
```

Node 保存：

```text
Hub Identity Public Key
Pairing Receipt
```

Pairing Receipt 用于证明：

> 这个 Node / Stream 确实由持有该 Hub Identity Private Key 的 Hub 授权建立。

TLS Certificate 续期不能替代或重写这条长期 Hub Identity 关系。

## 5. Handshake

已配对 Node 在发送数据前必须 Handshake。

概念请求：

```ts
interface ReplicationHandshakeRequest {
  nodeId: string
  knownHubId: string
  replicationStreamId: string
  runtimeInstanceId: string
  clientNonce: string
  agentLensVersion: string
  protocol: {
    major: number
    minMinor: number
    maxMinor: number
  }
  capabilities: string[]
  replicationPolicy: 'metadata-only' | 'redacted' | 'full'
  policyRevision: number
  historyRevision: number
  lastLocalAckSequence?: number
}
```

`runtimeInstanceId` 是当前 Daemon 启动实例的临时随机标识，只用于连接 / Clone Diagnostics，不属于 Node 长期身份。

概念响应：

```ts
interface ReplicationHandshakeResponse {
  hubId: string
  hubKeyId: string
  serverTime: string
  agentLensVersion: string
  selectedProtocol: {
    major: number
    minor: number
  }
  capabilities: string[]
  acceptedStreamId: string
  activeReplicaGenerationId?: string
  hubAckSequence: number
  requiredAction?: 'bootstrap' | 'resume' | 'reconcile' | 'none'
  serverProof: string
}
```

`serverProof` 由 Hub Identity Private Key 对至少以下内容签名：

```text
clientNonce
hubId
nodeId
replicationStreamId
selectedProtocol
hubAckSequence
serverTime
```

Node 必须使用已配对的 Hub Identity Public Key 验证，而不是只因为 endpoint / IP 相同就接受响应。

Hub 必须验证：

- Node 已配对且未撤销；
- `knownHubId` 与当前 Hub Identity 一致；
- stream 属于该 Node / Hub relationship 且未冻结；
- 协议存在共同兼容版本；
- Node Request Signature 有效；
- 本地 ACK 与 Hub ACK 若不一致，以 Hub 已事务提交的 contiguous ACK 为恢复基准。

协议不兼容时只拒绝 Replication，不影响 Node 本地运行。

## 6. History Scope / Policy Revision

Replication Policy 与 History Scope 分离。

协议状态至少能表达：

```text
policy
policyRevision
historyRevision
```

`policyRevision` / `historyRevision` 都是 Node relationship 内单调递增的运维版本，不等于 Protocol Version。

History Boundary 的具体 baseline 不要求放进每个 Batch，但 Hub Status / Diagnostics 必须能关联当前 revision。

`from-now` 的语义、Dependency Closure 与 Policy 收紧 / 放宽规则见 `HUB-REPLICATION-STATE-CONTRACT.md`。

## 7. Batch Envelope

Bootstrap、Incremental、Reconciliation、Promotion、Tombstone 使用同一个 Batch Envelope。

概念结构：

```ts
interface ReplicationBatch {
  protocol: {
    major: number
    minor: number
  }
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

规则：

- `batchId` 为随机 UUID，只用于诊断 / 去重辅助；
- sequence 才是 stream 的顺序事实；
- `hubId` 必须与当前 Pairing Relationship 一致；
- Batch 必须绑定当前 / staged Replica Generation；
- 单 Batch 要么完整事务提交，要么完整回滚；
- Hub 不允许部分 ACK；
- Batch 数组顺序不决定落库顺序，Importer 按 Contract Dependency DAG 处理；
- Entity DTO 引用必须使用 Typed `EntityRef`；
- payload 只经过 Replication Policy 处理，不做 Canonical ID 字符串替换。

## 8. Deterministic Hash

`Entity.contentHash` 与 `Batch.contentHash` 必须跨平台、跨进程确定性一致。

R1 使用 UTF-8 JSON Wire DTO，并采用 RFC 8785 / JCS 兼容的 Canonical JSON 规则计算内容摘要：

```text
SHA-256(canonical JSON bytes)
```

要求：

- Wire DTO 只能包含合法 JSON 值；
- 禁止 `undefined`、NaN、Infinity 等非 JSON 值；
- `Batch.contentHash` 计算时排除自身 `contentHash` 字段；
- `Entity.contentHash` 计算在 Replication Policy transform 之后进行；
- `entityVersion`、Typed Ref 与 omitted / redacted 状态均参与 hash；
- Protocol Major 若改变 Canonical Encoding，必须明确升级兼容边界。

Request Signature 的 Body Hash 与这里不同：它对实际发送的 Raw HTTP Body Bytes 做 SHA-256，不要求服务器重新 stringify 对象。

## 9. Sequence 与 ACK

Alpha 使用严格 contiguous sequence，不做乱序并发提交。

Hub 对 stream 维护：

```text
ackSequence = 已完整事务提交的最高连续 batchSequence
```

### `batchSequence == ackSequence + 1`

正常验证、事务导入；成功后 ACK 推进。

### `batchSequence <= ackSequence`

视为重试 / 重放。Hub 使用已保存 Sequence Receipt 验证：

- contentHash 一致 -> 返回已有 ACK；
- 同一 sequence 但 contentHash 不同 -> `SEQUENCE_REUSE_CONFLICT`。

### `batchSequence > ackSequence + 1`

返回：

```text
SEQUENCE_GAP
expected = ackSequence + 1
```

Hub 不缓存未来 Batch。

## 10. Batch Commit Ambiguity

Batch 第一次可能发网前必须冻结：

```text
sequence
batchId
body
contentHash
```

如果发生：

```text
timeout
connection reset
Hub crash / ACK response lost
```

Node 必须假设“可能已提交”，只能：

```text
resend exact same batch
or handshake/status query ACK
```

不能使用同 sequence 重新序列化另一份内容。

如果 Hub 明确在事务前拒绝并返回：

```text
committed = false
```

例如 `BATCH_TOO_LARGE`，Node 才能按返回规则重切该 expected sequence 的待同步内容。

## 11. Policy 收紧与 Stream Rollover

Policy 收紧必须立即停止新的旧 Policy 出站请求。

如果存在“提交结果不确定”的旧 Policy Batch，而新 Policy 已禁止其中正文：

- Node 不得为了填 sequence gap 继续发送旧敏感内容；
- 旧 stream 进入安全暂停；
- 使用已认证 Stream Rollover 建立新 stream；
- existing Replica Generation 保留；
- 新 stream 按新 Policy 执行 Reconciliation。

Stream Rollover 不是 Re-pair，也不改变 nodeId / hubId / Node Key。

## 12. Bootstrap 是收敛扫描，不是假装一致性快照

第一次需要补传历史时：

```text
Pair
 -> Bootstrap Scan
 -> Bootstrap Complete Marker
 -> Mandatory Reconciliation
 -> Incremental
```

规则：

- 不冻结 Local Capture；
- 按 History Scope 与 Entity Dependency 分批扫描；
- 使用同一 stream sequence；
- 网络中断从 Hub ACK 恢复；
- Bootstrap 期间的新变化进入待同步状态；
- Complete 后必须 Reconcile；
- 删除仍依赖 Tombstone；
- `from-now` 必须遵守持久 History Boundary，不因全量扫描偷偷补传旧事实。

## 13. Replica Generation / Re-bootstrap

普通 Reconciliation：

```text
absence != delete
```

显式 Re-bootstrap 创建 staged `replicaGenerationId`：

```text
G1 active
 -> G2 staged bootstrap
 -> G2 mandatory reconciliation
 -> validate complete
 -> atomic activate G2
 -> retire G1
```

在 G2 激活前：

- G1 仍是可查询 active Replica；
- G2 不能混入用户正式 Projection；
- Local Capture 继续；
- Re-bootstrap 失败不能把半成品当 active。

只有完整 Generation 激活时，旧 Generation 中存在而新完整 Generation 不存在的 origin entity 才可以作为重建结果清理；普通 scan absence 永远不能制造 Tombstone。

## 14. Incremental 与 Reconciliation

Incremental Fast Path：

```text
Canonical Change
 -> Cordis Event
 -> enqueue replication candidate
 -> next batch
```

但 Event 不是 Durable Fact。

Reconciliation：

```text
Canonical Store
 -> History Boundary
 -> Replication Policy
 -> Wire serialization
 -> entity contentHash
 -> compare acknowledged state
 -> repair pending / stale state
```

最小触发：

- Bootstrap 完成后；
- Daemon 异常退出后；
- Hub ACK 与 Node Cursor 不一致；
- 用户确认扩大历史授权；
- Stream Rollover 后；
- 用户显式 repair / resync；
- 周期性低频校准。

正式语义：

```text
at-least-once transport
+ deterministic identity
+ idempotent import
+ reconciliation
```

## 15. Replication Entity DTO

Wire Entity 不直接等于 Core Interface 或 SQLite Row。

概念公共头：

```ts
interface ReplicationEntityEnvelope {
  entityType: ReplicationEntityType
  scope: 'node' | 'shared'
  originEntityId: string
  sharedKey?: string
  entityVersion: number
  contentHash: string
  body: unknown
}
```

Node-scoped：

- `originEntityId` 必填；
- Hub 通过 `nodeId + entityType + originEntityId` 计算 Replica Key。

Shared：

- `sharedKey` 必填；
- `originEntityId` 保留 provenance；
- Hub 按 Shared Identity / Merge Contract 处理。

## 16. Omitted / Redacted 必须显式

受 Policy 控制字段不能用 `null` 混淆多种含义：

```ts
type ReplicatedValue<T> =
  | { state: 'value'; value: T }
  | { state: 'omitted'; reason: 'policy' | 'not-captured' }
  | { state: 'redacted'; value?: T }
```

Hub 必须能区分：

- 原事实为空；
- 本机没采集；
- 本机有但不允许复制；
- 已脱敏。

字段级边界见 `HUB-DATA-EXPOSURE-MATRIX.md`。

## 17. Identity Promotion

Promotion 与普通 Entity 可以出现在同一 Batch，但 Importer 必须在 Dependency DAG identity 阶段优先处理。

必须满足：

- 幂等；
- 单向 `node-scoped -> shared`；
- origin / Shared Identity provenance 可追溯；
- 同 origin 晋升到另一个 Shared Key 属于冲突；
- 旧 Batch 重试不能重新制造重复 Identity。

Hub 本机 Conditional Shared Entity 的参与规则见 State Contract；不要求通过 HTTPS 自我复制。

## 18. Tombstone

概念结构：

```ts
interface ReplicationTombstone {
  entityType: ReplicationEntityType
  scope: 'node' | 'shared-assertion'
  originEntityId: string
  sharedKey?: string
  deletedAt: string
  reason?: string
}
```

规则：

- Node-scoped 删除针对 origin identity；
- Shared 删除是撤回该 Node 的 Shared Assertion；
- 其他 Node 仍断言 / 引用时不能删除 Shared Identity；
- Tombstone 必须持久化并参与 Reconciliation；
- Tombstone GC 遵守 `HUB-REPLICATION-STATE-CONTRACT.md`；
- 普通扫描缺失不能制造 Tombstone。

## 19. 错误模型

所有 Remote Protocol Error 返回稳定 `code`，客户端不依赖英文 message。

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

Alpha 至少定义：

| Code | Retryable | 含义 |
| --- | --- | --- |
| `AUTH_INVALID_SIGNATURE` | 否 | Node 请求签名无效 |
| `AUTH_NODE_REVOKED` | 否 | Node 已撤销 |
| `AUTH_CLOCK_SKEW` | 否 | 请求时间超出允许窗口 |
| `PROTOCOL_UNSUPPORTED` | 否 | 无共同协议版本 |
| `PROTOCOL_CAPABILITY_REQUIRED` | 否 | 使用未协商能力 |
| `STREAM_UNKNOWN` | 否 | stream 不存在 / 不属于 Node |
| `STREAM_FROZEN` | 否 | stream 已被冻结 |
| `SEQUENCE_GAP` | 是 | 缺少前序 Batch |
| `SEQUENCE_REUSE_CONFLICT` | 否 | 已提交 sequence 内容变化 |
| `BATCH_TOO_LARGE` | 是 | 需要缩小批次 |
| `ENTITY_TOO_LARGE` | 否 | 单 Entity 超出协议限制 |
| `BATCH_INVALID_REFERENCE` | 否 | Typed Ref / 依赖非法 |
| `BATCH_POLICY_INVALID` | 否 | Wire 内容违反声明 Policy |
| `IDENTITY_NODE_CONFLICT` | 否 | 同 nodeId 疑似被两个活跃实例使用 |
| `IDENTITY_PROMOTION_CONFLICT` | 否 | Promotion 目标冲突 |
| `SHARED_MERGE_CONFLICT` | 否 | Shared invariant 无法合并 |
| `SERVER_BUSY` | 是 | Hub 暂时不可处理 |
| `SERVER_STORAGE_PRESSURE` | 是 | Hub 存储压力，需要释放容量 |
| `INTERNAL_ERROR` | 是 | Hub 内部临时错误；不得暴露敏感详情 |

TLS / SPKI / Hub Identity 在收到可信服务器响应之前就失败时，属于 Node 本地 Transport / Security Diagnostic，不应伪装成“Hub 返回的协议错误”。例如：

```text
LOCAL_TLS_VALIDATION_FAILED
LOCAL_HUB_IDENTITY_MISMATCH
LOCAL_NETWORK_UNREACHABLE
```

不可重试 Remote Error 不等于删除 Outbox；Node 应 blocked / paused 并等待用户处理。

## 20. 请求签名输入

TLS 之外，已配对 Node 对认证请求使用 Node Private Key 签名。

签名必须绑定身份 Header，不能只签 Body，否则攻击者可能把合法 Body 重新标成另一个 Stream / Node 请求。

R1 Canonical Signature Input：

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

请求携带：

```text
Hub-Id
Node-Id
Replication-Stream-Id
Key-Id
Timestamp
Nonce
Signature
```

Hub 验证：

- Hub-Id 是否就是当前 Hub；
- Node / Key 是否 active；
- timestamp 是否在允许窗口；
- nonce 是否未重放；
- body hash / signature 是否匹配；
- stream / node / hub ownership 是否一致。

## 21. Pairing Request 的 Key Possession

Pairing Request 虽然尚未拥有长期 Hub 注册身份，但 Node 已在本地生成新 Key Pair。

因此 Pairing Request 必须包含对自身关键字段的 `nodeProof`，证明请求者持有 `nodePublicKey` 对应 Private Key，避免只提交一个任意 Public Key 字符串。

Pairing Secret 提供“用户授权”，`nodeProof` 提供“Node Key possession”，两者职责不同。

## 22. Transport Surface

Replication 使用独立 HTTPS Surface，不复用本机 `/api/v1/*`。

Alpha 逻辑路由：

```text
POST /replication/v1/pair
POST /replication/v1/handshake
POST /replication/v1/streams/rollover
POST /replication/v1/batches
GET  /replication/v1/status
```

- `/pair` 使用 Pairing Secret + Node Key Possession，不依赖已注册 Node Signature；
- 其余路由均需长期 Node Request Signature；
- `status` 不能泄露其他 Node 的控制面信息。

监听地址 / 端口属于部署配置，不在 Wire Protocol 写死。

现有 Web API 继续：

```text
127.0.0.1:56789
```

## 23. Batch 大小、流控与压缩

Hub 在 Handshake / Status 可以返回：

```text
maxBatchBytes
maxEntityBytes
maxEntitiesPerBatch
recommendedBatchBytes
retryAfterMs
```

要求：

- Node 优先按字节而非只按 Entity 数切批；
- HTTP Surface 在完整 parse 前限制 Body Size；
- 单 Entity 超限返回 `ENTITY_TOO_LARGE`；
- `SERVER_STORAGE_PRESSURE` 不影响 Node 本地 Pipeline。

R1 基础能力不要求 HTTP Compression。以后若新增 Compression Capability，必须同时限制压缩体和解压后字节数，防止压缩炸弹。

## 24. Clock Skew

Security Timestamp 默认允许有限时钟偏差；具体策略见安全文档。

Handshake Response 提供 `serverTime`，Node 可以估算 Clock Skew。

重要：

```text
Security Timestamp 可接受
!=
跨机器业务事件具有精确全序
```

Hub 不使用 receive / replicated time 覆盖 `occurredAt / capturedAt`。跨 Node 排序与 tie-break 规则见 State Contract。

## 25. Node Replication 状态机

至少包括：

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

`paused` 用于用户 / Policy 安全暂停，例如旧 Policy ambiguous Batch 等待 Stream Rollover。

网络暂时不可达属于 `degraded`；协议 / 身份冲突属于 `blocked`；本地 Canonical Pipeline 始终独立。

## 26. Sequence Receipt Retention

Hub 不需要永久保存完整 Batch Body，但至少为 active / 可重放 Stream 保存：

```text
nodeId
streamId
sequence
contentHash
committedAt
```

用于验证 `same sequence + same content`。

Receipt、Alias、Tombstone、Generation 等保留规则见 State Contract。

## 27. R1 验收不变量

实现 R1 时至少验证：

- Pairing Receipt 可由 Hub Identity Public Key 验证；
- Handshake `serverProof` 错误时 Node 不继续发送数据；
- 修改 Node-Id / Stream-Id Header 会导致 Request Signature 失败；
- 重试同一已 ACK Batch 不重复写；
- 同已提交 sequence 不同内容被拒绝；
- sequence gap 不被静默跳过；
- ambiguous commit 只重试同一 immutable Batch；
- Policy 收紧后旧敏感 ambiguous Batch 不被继续重发，可通过 Stream Rollover 恢复；
- Bootstrap 中持续采集后能通过 Reconciliation 收敛；
- `from-now` 不会被 Reconciliation 绕过；
- Re-bootstrap staged Generation 未完成时不替换 active Generation；
- Daemon 在 Canonical Commit 后、Fast Path 前崩溃能被 Reconciliation 补齐；
- policy omitted 与真实 null 可区分；
- Shared Assertion Withdrawal 不误删其他 Node；
- Nonce、Clock Skew、stream/node/hub 不匹配被拒绝；
- Protocol 不兼容只阻塞 Replication，不影响本地采集 / Web；
- Clock Skew 不会导致 Hub 改写业务事件时间。

## 28. 当前非目标

R1 不解决：

- Batch 乱序并发提交；
- 多 upstream Hub；
- Hub Federation；
- 双向 Canonical Replication；
- 分布式事务 / Exactly-once；
- Remote Web Session；
- Server push 控制 Node；
- SQLite / PostgreSQL Schema 传输；
- 基础协议强制压缩。
