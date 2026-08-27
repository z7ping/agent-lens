# AgentLens 1.0 Hub Replication Protocol

更新日期：2026-08-27  
状态：**Alpha R1 协议语义冻结；Protocol Core 已实现，Transport / Pairing / Remote Import 尚未实现**  
上位设计：`docs/1.0/HUB-DESIGN.md`  
安全边界：`docs/1.0/HUB-PAIRING-SECURITY.md`

本文只记录 R1 的**长期协议语义与兼容边界**。当前精确 Wire DTO、Validator、Canonical Hash、Compatibility 与 Sequence 语义以 `packages/protocol/src/replication/`（`@agent-lens/protocol/replication`）中的类型和测试为主要权威来源；本文不再手工复制每个字段，避免形成第二份 Wire 事实源。未来若出现独立发行/依赖需求，可再抽成独立 workspace，但不得改变这里冻结的协议语义。

## 1. 协议目标

一个已配对 Node 将经过 Replication Policy 与 History Scope 授权的 Canonical Entity State，可靠、可恢复、可验证地复制到唯一 upstream Hub。

不负责：

- Remote Web；
- Remote Execution；
- Hub Federation；
- Projection 同步；
- SQLite 文件 / Row 同步；
- Node 间直连。

## 2. 独立版本边界

```text
AgentLens Product Version
Replication Protocol R1.x
Storage Schema Migration
Shared Identity Algorithm Version
Replication Entity Version
```

规则：

- Protocol Major：破坏 Identity、Reference、History、Delete、Signature、必须 Wire 语义时升级；
- Protocol Minor：向后兼容扩展；
- Capability：仅表达兼容可选能力，不替代 Major；
- Identity Algorithm Version：Normalize / SharedKey 结果改变时显式演进；
- Entity Version：某一 `entityType` 的 body schema 独立版本。

没有共同 Protocol / 必需 Identity Algorithm / Entity Version 时，只暂停 Replication，不阻塞本机采集。

## 3. Relationship、Stream 与 Generation

R1 区分：

```text
nodeId
hubId
replicationStreamId
replicaGenerationId
```

- `nodeId`：Node 长期实例身份；
- `hubId`：Hub 长期信任身份；
- `streamId`：Sequence / ACK 命名空间；
- `generationId`：某 Remote Node Replica 数据集的一代状态。

一个 Node Alpha 最多一个 upstream Hub / active stream。Re-pair 默认新 Stream；已认证 Relationship 可以 Rollover；Re-bootstrap 可以新建 staged Generation。

Hub 必须拒绝 `nodeId == hubLocalNodeId` 的 self-pair。

## 4. Pairing 与 Handshake

Pairing 使用短期 Pair Secret + Node Key Possession。成功后 Hub 使用 Hub Identity Key 签名 Pairing Receipt。

Handshake 至少协商 / 验证：

```text
nodeId / hubId / streamId
AgentLens Version
Protocol Major / Minor
Capabilities
Identity Algorithms
Entity Versions
Replication Policy + Revision
History Revision
Hub ACK Sequence
Hub serverProof
serverTime
```

`serverProof` 绑定本次 client nonce、Hub/Node/Stream、选定 Protocol、Hub ACK 与 serverTime，防止仅凭 endpoint 或 TLS 连接误认 Hub。

H3 已实现 Protocol / Identity Algorithm / Entity Version 的纯兼容协商：可选能力取交集，只有调用方声明的 required Identity Algorithm / Entity Type 缺少共同版本时才拒绝。Pairing Receipt、serverProof 与真实网络 Handshake 仍属于后续安全/Transport 实现。

## 5. Batch

每个 Batch 至少具有这些语义字段：

```text
protocol version
nodeId / hubId / streamId / generationId
sequence / batchId
phase: bootstrap | incremental | reconcile
policy + policyRevision + historyRevision
entities
identity promotions
optional tombstones
contentHash
```

要求：

- Batch 单事务提交 / 回滚；
- 数组顺序不决定 Import DAG；
- Domain Ref 使用 Typed EntityRef；
- payload 不做任意 ID 字符串替换；
- 第一次可能发网后 sequence / batchId / body / contentHash immutable。

## 6. Deterministic Hash

R1 使用 RFC 8785 / JCS 兼容 Canonical JSON + SHA-256。

Entity / Batch hash 必须覆盖影响 Replica 语义的字段，包括：

```text
entityVersion
Typed Ref
Shared Identity assertion
availability state
policy/history transform 后的 body
```

H3 已实现对象键确定性排序、有限 JSON 数值门禁、Entity / Batch / Tombstone 语义 SHA-256；`contentHash` 本身不参与自身计算。

Request Signature 的 Body Hash 对 Raw HTTP Body Bytes 计算，与 Entity JCS Hash 分开，仍属于后续 Transport / Security 边界。

## 7. Sequence / ACK / Commit Ambiguity

```text
ackSequence = Hub 已事务提交的最高连续 sequence
```

语义：

- `seq == ack + 1`：处理；
- `seq <= ack` 且 hash 相同：返回已有 ACK；
- `seq <= ack` 且 hash 不同：`SEQUENCE_REUSE_CONFLICT`；
- `seq > ack + 1`：`SEQUENCE_GAP`，Hub 不缓存未来 Batch。

Timeout / connection reset / response lost 造成提交不确定时，只能 exact retry 或查询 Hub ACK。

只有 Hub 明确 `committed=false` 时，Node 才能重切当前 expected sequence。

H3 已实现上述 Sequence / ACK 纯决策语义；持久 ACK、Stream 状态与网络恢复尚未实现。

## 8. Policy 收紧与 Stream Rollover

若旧 Policy 的 ambiguous Batch 包含新 Policy 已禁止内容：

```text
freeze old stream
 -> authenticated rollover
 -> new stream sequence=1
 -> keep active generation
 -> reconcile under new policy
```

禁止为了填 Sequence gap 继续发送用户刚禁止的正文。

## 9. Entity Envelope 与 Scope

Wire Entity 不等于 Core Interface / SQLite Row。

每个 Entity 至少表达：

```text
entityType
scope: node | shared
originEntityId
entityVersion
contentHash
body
optional replicaKey assertion
optional SharedIdentityAssertion
```

规则：

- Node-scoped：Hub 按 `agentlens-replica-r1` 重算 ReplicaKey；
- Shared Root：Alpha 主要为 `AgentProduct`；
- Project / AssetDefinition：始终以 Node-scoped Origin Replica 传输，有 Portable Identity 时附 Shared Identity Assertion；
- Conditional Shared Group 不是领域 FK target；
- 未知 `entityType` -> `ENTITY_TYPE_UNSUPPORTED`；
- 未支持 `entityVersion` -> `ENTITY_VERSION_UNSUPPORTED`；
- 不允许看不懂字段却静默丢弃后返回同步成功。

H3 已将上述 Scope / Entity Version 规则编码为 Wire DTO 与 fail-closed Validator。

## 10. Shared Identity Assertion

Assertion 至少包含：

```text
identityAlgorithm
normalizedPortableIdentity
claimedSharedKey
```

Hub 必须重新 Normalize / 计算 SharedKey 并校验 claimed 值。

错误：

```text
IDENTITY_ALGORITHM_UNSUPPORTED
SHARED_IDENTITY_MISMATCH
IDENTITY_PROMOTION_CONFLICT
SHARED_MERGE_CONFLICT
```

H3 已定义 Assertion Wire 结构并校验算法/必需字段；真正使用 H2 Normalize / SharedKey 对 claimed 值进行重算属于后续 Import 集成。

Node Signature 只能证明“哪个已配对 Node 发出了声明”，不证明 Repository / Asset 在现实世界中的所有权。

## 11. Typed EntityRef

R1 Ref 只有两类：

```text
node ref   -> entityType + originEntityId
shared ref -> Shared Root entityType + sharedKey
```

Project / AssetDefinition 即使已经加入 Shared Group，领域 Ref 仍然是 Node Ref。

Alpha 禁止跨 Node direct Ref。H3 类型系统和运行时 Validator 当前都只允许 Shared Ref 指向 `AgentProduct` Shared Root。

## 12. Availability

Remote Replica 必须原生区分：

```text
value
real null
redacted
omitted(policy)
omitted(not-captured)
omitted(history-boundary)
omitted(dependency-minimized)
```

不得用 `null / '' / {} / [hidden]` 混淆这些状态。

H3 已将这些状态编码为显式判别联合类型和 Validator；真正由 Replication Policy / History Boundary 产生何种状态属于 H4。

`from-now` 的 Boundary 前依赖使用同一个 Entity Version，但只发送对应 Entity 的 Minimum Dependency Shape。

## 13. Bootstrap / Reconcile / Generation

`include-existing`：

```text
Bootstrap
 -> Complete
 -> Mandatory Reconciliation
 -> Incremental
```

`from-now`：建立持久 History Boundary，不执行普通历史 backfill，Reconciliation 仍遵守 Boundary。

Re-bootstrap：

```text
G1 active
 -> G2 staged
 -> bootstrap
 -> reconcile
 -> validate
 -> atomic activate G2
 -> retire G1
```

所有来自该 Remote Node 的 Shared Identity State 都随 Generation staged / activate，包括 Conditional Shared Membership 与 Shared Root assertion。

## 14. Tombstone

Node-scoped / Conditional Origin 删除通过 Tombstone 表达。

普通 scan absence 不能制造 Tombstone。

Conditional Origin 删除同时撤回自己的 Membership；一个 Node 的删除不能删除其他 Node / Hub Local origin。

H3 已定义 Tombstone Wire 结构与内容哈希校验；Tombstone 的产生、持久化和导入仍属于后续阶段。

## 15. Hub 公开 ID

Hub Unified Read / `/api/v1/*`：

- Local Entity：保持 Local Canonical ID；
- Remote Entity：使用 ReplicaKey；
- Shared Group：使用 SharedGroupKey，仅作 Group / Filter / Aggregation；
- Web 把 ID 视为 opaque string，不通过前缀推断业务 scope。

## 16. Request Signature

R1 签名输入至少绑定：

```text
protocol marker
HTTP method
path
hubId
nodeId
streamId
keyId
timestamp
nonce
SHA-256(raw body)
```

Hub 验证 Node Key、ownership、timestamp、nonce 与 body hash。

## 17. 稳定错误类别

至少覆盖：

```text
AUTH_*                 认证 / 撤销 / 时钟
PROTOCOL_*             协议协商
IDENTITY_*             Node / Shared Identity
ENTITY_*               Type / Version / Size
STREAM_*               Stream 状态
SEQUENCE_*             ACK / Gap / Reuse
BATCH_*                大小 / 引用 / Policy
SHARED_*               Merge
SERVER_BUSY
SERVER_STORAGE_PRESSURE
INTERNAL_ERROR
```

H3 已实现当前 Protocol Core 会产生的稳定错误码子集；后续 Transport / Storage / Security 实现再按本节类别扩展，不重用现有码表达不同语义。

## 18. Runtime Invalidation

Remote Import 事务成功后，Hub 发布独立的 Replication runtime invalidation，例如概念上的：

```text
replication/committed
```

用于 Unified Read / Projection / SSE 刷新。

它不是 Agent 行为事实：

- 不进入 Canonical Observation；
- 不伪造 Local `observation/committed`。

## 19. Transport Surface

Alpha 使用独立 authenticated HTTPS Surface，概念能力包括：

```text
pair
handshake
stream rollover
batch ingest
status / ack recovery
```

H3 **没有**实现这些网络 Route。精确 URL / Request / Response 在 Transport 实现后应由正式 Route + Schema / OpenAPI 或项目采用的等价标准工件表达，不再在本文维护第二份完整接口表。

## 20. R1 冻结不变量

- Pairing Receipt / serverProof 可验证；
- Hub 拒绝 self-pair；
- Header / Body 修改导致签名失败；
- Sequence retry / gap / ambiguity 正确；
- Policy 收紧可安全 Rollover；
- `from-now` 不被 Reconcile 绕过；
- Project / AssetDefinition 保持 Origin Replica；
- Hub 重算 Shared Identity；
- unknown Entity Type / Version 不静默丢弃；
- staged Generation 未完成不进入正式查询；
- Remote Shared assertions 随 Generation 激活；
- Remote Import commit 后只有 Replication invalidation；
- Protocol 不兼容只阻塞同步；
- Node 本机采集始终独立。
