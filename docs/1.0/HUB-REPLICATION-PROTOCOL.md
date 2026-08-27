# AgentLens 1.0 Hub Replication Protocol

更新日期：2026-08-27  
状态：Alpha Wire Protocol 设计，尚未实现  
上位文档：
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`

本文定义 AgentLens Node 与 Hub 之间的线上协议边界：Handshake、Replication Stream、Batch Envelope、Sequence / ACK、Bootstrap、Reconciliation、错误模型、Capability Negotiation 与请求签名输入。本文不绑定 SQLite Schema，也不表示协议已经实现。

## 1. 协议目标

Replication Protocol 只解决一件事：

> 让一个已配对 Node 将经过 Replication Policy 允许的 Canonical Entity State，可靠、可恢复、可验证地复制到唯一 upstream Hub。

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

连接建立后，在当前连接 / stream 上使用双方协商出的固定协议版本，不在同一请求链中动态切换版本。

## 3. Replication Stream

Sequence 不能只按 `nodeId` 计数，因为重新配对、重建 upstream 关系或显式 Reset 时需要重新开始一条同步历史。

因此每次成功 Pairing 建立一条持久 `replicationStreamId`：

```text
nodeId
  + replicationStreamId
  -> exactly one upstream Hub relationship
```

规则：

- `replicationStreamId` 使用随机 UUID；
- 一个 Node Alpha 同时最多一个 active stream；
- 同一 stream 内 `batchSequence` 从 1 单调递增；
- 重新配对默认创建新 stream，旧 stream 冻结，不复用其 sequence；
- Hub Cursor 以 `nodeId + replicationStreamId` 为键；
- Node Identity Reset 必须创建新的 Node 身份与新 stream；
- stream 不能跨 Hub 搬用。

## 4. Handshake

已配对 Node 在发送数据前必须 Handshake。

概念请求：

```ts
interface ReplicationHandshakeRequest {
  nodeId: string
  replicationStreamId: string
  agentLensVersion: string
  protocol: {
    major: number
    minMinor: number
    maxMinor: number
  }
  capabilities: string[]
  replicationPolicy: 'metadata-only' | 'redacted' | 'full'
  lastLocalAckSequence?: number
}
```

概念响应：

```ts
interface ReplicationHandshakeResponse {
  hubId: string
  agentLensVersion: string
  selectedProtocol: {
    major: number
    minor: number
  }
  capabilities: string[]
  acceptedStreamId: string
  hubAckSequence: number
  requiredAction?: 'bootstrap' | 'resume' | 'reconcile' | 'none'
}
```

Hub 必须验证：

- Node 已配对且未撤销；
- stream 属于该 Node 且未冻结；
- 协议存在共同兼容版本；
- Node 报告的 Hub Identity 与 TLS Pinning 关系有效；
- 本地 ACK 与 Hub ACK 若不一致，按 Hub 已事务提交的 contiguous ACK 为恢复基准。

协议不兼容时只拒绝 Replication，不影响 Node 本地运行。

## 5. Batch Envelope

所有 Bootstrap、Incremental、Reconciliation、Promotion、Tombstone 使用同一个 Batch Envelope，不维护多套传输语义。

概念结构：

```ts
interface ReplicationBatch {
  protocol: 'R1.x'
  nodeId: string
  replicationStreamId: string
  batchSequence: number
  batchId: string
  phase: 'bootstrap' | 'incremental' | 'reconcile'
  createdAt: string
  policy: 'metadata-only' | 'redacted' | 'full'
  entities: ReplicationEntity[]
  promotions?: IdentityPromotion[]
  tombstones?: ReplicationTombstone[]
  contentHash: string
}
```

规则：

- `batchId` 为随机 UUID，只用于诊断 / 去重辅助，sequence 才是 stream 顺序事实；
- `contentHash` 对协议规范化后的 Batch 内容计算；
- 单 Batch 必须事务性导入，要么全部提交，要么全部回滚；
- Hub 不允许部分 ACK；
- Batch 数组顺序不决定落库顺序，Importer 按 Contract Dependency DAG 处理；
- Entity DTO 的引用必须使用 Typed `EntityRef`；
- payload 只经过 Replication Policy 处理，不做 Canonical ID 字符串替换。

## 6. Sequence 与 ACK

Alpha 使用严格 contiguous sequence，不做乱序并发提交。

Hub 对 stream 维护：

```text
ackSequence = 已完整事务提交的最高连续 batchSequence
```

处理规则：

### `batchSequence == ackSequence + 1`

正常验证、事务导入；成功后 ACK 推进 1。

### `batchSequence <= ackSequence`

视为重试 / 重放。Hub 必须验证该 sequence 对应已提交 Batch 的稳定摘要：

- 内容一致 -> 返回已有 ACK；
- 同一 sequence 但内容不同 -> `SEQUENCE_REUSE_CONFLICT`，拒绝。

### `batchSequence > ackSequence + 1`

出现 gap：

```text
SEQUENCE_GAP
expected = ackSequence + 1
```

Hub 不缓存未来 Batch，Node 从 expected sequence 恢复。

因此 Alpha 不需要复杂乱序窗口。

## 7. Bootstrap 是收敛扫描，不是假装一致性快照

Node 第一次连接已有历史数据时执行 Bootstrap。

Bootstrap 不要求冻结本机采集，也不声称是数据库某一瞬间的 MVCC Snapshot：

```text
Pair
 -> Bootstrap Scan
 -> Bootstrap Complete Marker
 -> Mandatory Reconciliation
 -> Incremental
```

原因：AgentLens 在 Bootstrap 期间仍需 Local-first 持续采集。

规则：

- Bootstrap 按 Entity Scope / Dependency Contract 分批扫描当前允许复制的 Canonical State；
- Bootstrap Batch 使用同一 stream sequence；
- 网络中断后从 Hub ACK 恢复，不从零开始；
- Bootstrap 期间产生的新变化进入本地待同步状态 / Outbox；
- Bootstrap Complete 之后必须执行一次 Reconciliation；
- Reconciliation 修正 Bootstrap 扫描过程中发生的新增 / 更新；
- 删除不能通过“扫描不到”推断，仍依赖 Tombstone；
- 完成 Reconciliation 后进入稳定 Incremental。

这样目标是最终收敛，而不是为了一个个人多机 Hub 引入数据库级分布式 Snapshot。

## 8. Incremental 与 Reconciliation

Incremental Fast Path：

```text
Canonical Change
 -> Cordis Event
 -> enqueue replication candidate
 -> next batch
```

但 Event 不是 Durable Fact。

Reconciliation 必须定期 / 按恢复条件从 Canonical Store 计算可复制 Entity 的稳定 `contentHash`，与本地 Replication State 对账：

```text
Canonical Store
 -> replication serialization
 -> policy transform
 -> entity content hash
 -> compare last acknowledged hash
 -> repair missing / stale pending state
```

触发 Reconciliation 的最小条件：

- Bootstrap 完成后；
- Daemon 异常退出后恢复；
- Hub ACK 与 Node 本地 Cursor 不一致；
- Replication Policy 扩大后用户明确允许历史补传；
- 用户显式执行 repair / resync；
- 周期性低频完整性校准。

Alpha 不承诺 Exactly-once；正式语义为：

```text
at-least-once transport
+ deterministic identity
+ idempotent import
+ reconciliation
```

## 9. Replication Entity DTO

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

`entityVersion` 是某类 Entity DTO 的协议 Schema 版本，不是 SQLite migration。

Node-scoped Entity：

- `originEntityId` 必填；
- Hub 通过 `nodeId + entityType + originEntityId` 计算 Replica Key。

Shared Entity：

- `sharedKey` 必填；
- `originEntityId` 仍保留，用于 Shared Assertion provenance；
- Hub 按 Shared Identity / Merge Contract 处理。

## 10. Omitted / Redacted 必须是显式状态

Replication Policy 不能用 `null` 同时表达：

- 原始字段就是 null；
- 本机未采集；
- 本次不允许复制；
- 已脱敏。

Wire DTO 对受策略控制字段使用显式值语义，例如：

```ts
type ReplicatedValue<T> =
  | { state: 'value'; value: T }
  | { state: 'omitted'; reason: 'policy' | 'not-captured' }
  | { state: 'redacted'; value?: T }
```

Hub Projection 必须能区分“事实为空”与“Hub 没有获得该正文”。

## 11. Identity Promotion

Promotion 与普通 Entity 可以出现在同一 Batch，但 Importer 必须在 Dependency DAG 的 identity 阶段先处理。

同一 stream 中 Promotion：

- 幂等；
- 单向 `node-scoped -> shared`；
- Promotion 后旧 origin Ref 永久通过 Alias 解析至 Shared Key；
- 同 origin 晋升到另一个 Shared Key 属于冲突；
- 旧 Batch 重试仍必须解析到晋升后的 Shared Entity。

详细规则见 `HUB-REPLICATION-CONTRACT.md`。

## 12. Tombstone

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
- Shared 删除实际是撤回该 Node 的 Shared Assertion；
- Hub 不因为 Shared Assertion Withdrawal 直接删除仍被其他 Node 断言 / 引用的 Shared Entity；
- Tombstone 必须持久化并参与 Reconciliation；
- Alpha 不通过“当前扫描中缺失”推断删除。

## 13. 错误模型

所有协议错误返回稳定 `code`，不让客户端依赖英文 message。

概念：

```ts
interface ReplicationError {
  code: string
  message: string
  retryable: boolean
  expectedSequence?: number
  conflictId?: string
  suggestedAction?: string
}
```

Alpha 至少定义：

| Code | Retryable | 含义 |
| --- | --- | --- |
| `AUTH_INVALID_SIGNATURE` | 否 | Node 请求签名无效 |
| `AUTH_NODE_REVOKED` | 否 | Node 已撤销 |
| `AUTH_HUB_IDENTITY_MISMATCH` | 否 | Hub 身份 / Pin 不匹配 |
| `PROTOCOL_UNSUPPORTED` | 否 | 无共同协议版本 |
| `PROTOCOL_CAPABILITY_REQUIRED` | 否 | Batch 使用未协商能力 |
| `STREAM_UNKNOWN` | 否 | stream 不存在 / 不属于 Node |
| `STREAM_FROZEN` | 否 | stream 已被冻结 |
| `SEQUENCE_GAP` | 是 | 缺少前序 Batch |
| `SEQUENCE_REUSE_CONFLICT` | 否 | 同一 sequence 内容变化 |
| `BATCH_TOO_LARGE` | 是 | 需要缩小批次 |
| `BATCH_INVALID_REFERENCE` | 否 | Typed Ref 不合法 / 缺依赖 |
| `BATCH_POLICY_INVALID` | 否 | 出站数据违反声明策略 |
| `IDENTITY_NODE_CONFLICT` | 否 | 同 nodeId 疑似被两个活跃实例使用 |
| `IDENTITY_PROMOTION_CONFLICT` | 否 | Promotion 目标冲突 |
| `SHARED_MERGE_CONFLICT` | 否 | Shared invariant 无法合并 |
| `SERVER_BUSY` | 是 | Hub 暂时不可处理 |
| `INTERNAL_ERROR` | 是 | Hub 内部临时错误；不得暴露敏感详情 |

不可重试错误不等于删除 Outbox；Node 应暂停该 stream 并展示明确诊断，等待用户处理 / 升级 / 修复。

## 14. 请求签名输入

TLS 之外，已配对 Node 对需要认证的 Replication 请求使用 Node Private Key 签名。

为避免 JSON 字段顺序导致签名不稳定，签名针对原始 HTTP Body 的 SHA-256，而不是客户端自行 stringify 后比较对象。

概念签名输入：

```text
agentlens-r1\n
<HTTP_METHOD>\n
<PATH>\n
<TIMESTAMP>\n
<NONCE>\n
<SHA256_RAW_BODY>
```

请求携带：

```text
Node-Id
Replication-Stream-Id
Key-Id
Timestamp
Nonce
Signature
```

Hub 验证：

- Node / Key 是否 active；
- timestamp 在允许时钟偏差范围内；
- nonce 未在重放窗口内使用；
- body hash 与签名一致；
- stream / node ownership 一致。

具体密钥生命周期与 TLS Pinning 见 `HUB-PAIRING-SECURITY.md`。

## 15. Transport Surface

Replication 使用独立 HTTPS Surface，不复用本机 `/api/v1/*`。

Alpha 逻辑路由建议：

```text
POST /replication/v1/pair
POST /replication/v1/handshake
POST /replication/v1/batches
GET  /replication/v1/status
```

路由是 Wire Contract；监听地址 / 端口属于部署配置，不在本协议写死。

现有 Web API 继续保持：

```text
127.0.0.1:56789
```

禁止通过 Hub 功能顺手把本机无认证 API 暴露到网络。

## 16. Batch 大小与流控

Alpha 不提前写死一个永久最大值，但协议必须允许 Hub 返回限制：

```text
maxBatchBytes
maxEntitiesPerBatch
recommendedBatchBytes
retryAfterMs
```

Node 应优先按字节大小而不是只按 Entity 数量切批，因为 Prompt / Tool payload 大小差异很大。

超限返回 `BATCH_TOO_LARGE`，Node 缩小批次后重试同一待同步内容，并生成新的 sequence 之前不得跳过失败 sequence。

## 17. 状态机

Node Replication 状态至少包括：

```text
unpaired
paired
handshaking
bootstrapping
reconciling
synced
degraded
blocked
revoked
```

关键转换：

```text
unpaired -> paired -> handshaking
handshaking -> bootstrapping | reconciling | synced
bootstrapping -> reconciling -> synced
synced -> degraded -> synced
any active -> blocked      # protocol/conflict/manual intervention
any active -> revoked
```

网络暂时不可达属于 `degraded`，不是 `blocked`。本地 Canonical Pipeline 不受这些状态影响。

## 18. R1 验收不变量

实现 R1 时至少验证：

- 重试同一已 ACK Batch 不重复写 Canonical Entity；
- 同 sequence 不同内容被拒绝；
- sequence gap 不被 Hub 静默跳过；
- Bootstrap 中持续产生新 Observation，最终经过 Reconciliation 后 Hub 收敛；
- Daemon 在 Canonical Commit 后、Outbox Fast Path 前崩溃，恢复后 Reconciliation 能补齐；
- 重新 Pair 后新 stream 可以从 sequence 1 开始而不与旧 stream 混淆；
- policy omitted 与真实 null 在 Hub 可区分；
- Promotion 后旧 Batch 重试不会重新创建旧 Node-scoped Entity；
- Shared Assertion Withdrawal 不误删其他 Node 的 Shared Entity；
- 签名重放、Nonce 重用、stream/node 不匹配被拒绝；
- Protocol 不兼容只阻塞 Replication，不影响 Node 本地采集与 Web。

## 19. 当前非目标

R1 不解决：

- Batch 乱序并发提交；
- 多 upstream Hub；
- Hub Federation；
- 双向 Canonical Replication；
- 分布式事务 / Exactly-once；
- Remote Web Session；
- Server push 控制 Node；
- SQLite / PostgreSQL Schema 传输。
