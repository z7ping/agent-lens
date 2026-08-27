# AgentLens 1.0 Hub Replication State Contract

更新日期：2026-08-27  
状态：Alpha 架构 Contract，尚未实现  
相关文档：
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-PROTOCOL.md`
- `docs/1.0/HUB-PAIRING-SECURITY.md`
- `docs/1.0/HUB-OPERATIONS.md`

本文补齐多机 Hub 在实现前复核中发现的状态语义缺口：能力组合合法性、历史同步边界、Policy 变更、Batch 不确定提交、Replication Stream Rollover、Replica Generation、Control Plane 保留规则、Hub 本机参与 Shared Identity、跨机时钟与发行共存。本文不表示这些能力已经实现。

## 1. 能力组合不是任意布尔组合

底层仍使用：

```text
localCapture
replicationUpstream
hubAccept
```

表达能力，而不是建立四套 Runtime Role；但 Alpha 并不允许任意组合。

合法 Profile：

| Profile | localCapture | replicationUpstream | hubAccept |
| --- | --- | --- | --- |
| Standalone | true | false | false |
| 普通接入节点 | true | true | false |
| Hub | true | false | true |
| Pure Hub | false | false | true |

Alpha 明确拒绝：

- `replicationUpstream=true && hubAccept=true`：会形成 Hub 级联 / Federation 语义；
- `localCapture=false && replicationUpstream=true`：没有定义“纯转发节点”的数据所有权；
- 三项全部为 `false`：没有实际产品能力，配置应提示而不是静默启动一个空运行时。

从“接入上游 Hub”切换为“作为 Hub”时，必须先明确断开 / 冻结 upstream relationship，再启用 `hubAccept`；不能通过两个布尔值同时为 true 偷偷形成 Hub 链路。

## 2. 四种不同身份 / 状态键

实现不得把下面几个概念混为一个 ID：

```text
nodeId
  = AgentLens 数据根 / 实例身份

hubId
  = upstream Hub 长期信任身份

replicationStreamId
  = 某次 Node <-> Hub 同步顺序流 / ACK 命名空间

replicaGenerationId
  = Hub 中某个 Node Replica 数据集的一代可激活状态
```

关系：

```text
Node Identity
  -> Pairing Relationship to Hub Identity
      -> active Replication Stream
          -> active Replica Generation
```

规则：

- 换 Stream 不等于换 Node；
- 换 TLS Certificate 不等于换 Hub；
- Re-bootstrap 可以换 Replica Generation，但不必换 Stream；
- Re-pair 默认换 Stream，但如果 Node Identity 和 Hub Identity 都未变，可以继续复用已有 Replica Generation；
- Node Identity Reset 必须形成新的 Replica Namespace，不复用旧 Node 的 Replica Generation。

## 3. History Scope 与 Replication Policy 是两个维度

Replication Policy 回答：

> 允许传哪些字段 / 内容？

History Scope 回答：

> 允许把哪个时间边界之前已经存在的历史事实补传？

不能只靠：

```text
metadata-only | redacted | full
```

表达“从现在开始”或“包含已有历史”。

Alpha 至少支持：

```text
historyMode = from-now | include-existing
```

首次 Pairing 与后续 Policy 放宽都必须明确 History Scope。

## 4. `from-now` 不是简单按 occurredAt 过滤

不能用：

```text
occurredAt >= pairingTime
```

作为唯一规则，因为：

- 不同 Agent 原生时间质量不同；
- 某些事件没有可靠 `occurredAt`；
- Source History 可能在配对之后才发现更早发生的事实；
- 新事件可能引用配对前已存在的 Installation / Project / Session。

因此 `from-now` 的正式语义是：

> 不对“建立 History Boundary 时已经存在于 Local Canonical Store 的历史事实集合”执行普通历史补传；但为了复制边界之后的新事实，允许发送其所需的身份 / 关系依赖。

实现可以使用 Replication Control Plane 的 baseline / high-water / per-entity suppression 等方式优化，但必须达到上述语义，不能把本机事件时钟当作唯一事实边界。

### 4.1 Dependency Closure

即使用户选择“从现在开始”，如果新的 Observation 引用一个配对前已经存在的：

```text
Host
AgentInstallation
Project
Workspace
LogicalSession
SourceSession
AgentActor
AssetDefinition / AssetBinding
```

对应依赖仍允许按当前 Replication Policy 发送，否则 Hub 无法形成合法 FK 图。

这不等于补传该 Session 过去的所有 Observation / Prompt / Tool 正文。

## 5. History Boundary 必须持久化

Node 必须在本地 Replication Control Plane 保存 History Boundary，至少包含：

```text
relationship / hubId
createdAt
historyMode
revision
implementation-specific baseline state
```

Reconciliation 必须遵守该 Boundary，不能因为“全量扫描 Canonical Store”就把用户明确排除的旧历史重新补传。

如果用户以后明确选择“补传已有历史”，创建新的 History Revision，并把原先 suppressed 的历史事实重新纳入 Bootstrap / Reconciliation。

## 6. Policy Revision

Node 为每次 Replication Policy 变更维护单调递增的：

```text
replicationPolicyRevision
```

Batch / Status 必须能够关联：

```text
policy
policyRevision
historyRevision
```

这样 diagnostics 能回答：

> 这批数据是在什么授权边界下序列化 / 发送的？

Hub 不根据 `policyRevision` 获得修改 Node Policy 的能力；它只是验证与审计同步边界。

## 7. Batch 在首次可能发送前必须冻结内容

Node 可以先维护“待同步 Entity Candidate”，但真正分配：

```text
batchSequence
batchId
contentHash
```

并准备发网后，该 Batch Body 必须视为 immutable，直到得到明确结果。

原因：如果请求已经到达 Hub 并完成事务，但 ACK Response 丢失，Node 无法知道 Hub 是否提交。

此时只能：

```text
resend same sequence + same content hash
```

不能把同一个 sequence 重新序列化成另一份内容。

## 8. 明确失败与提交不确定必须区分

### 明确未提交

例如 Hub 在进入事务前返回：

```text
BATCH_TOO_LARGE
PROTOCOL_CAPABILITY_REQUIRED
BATCH_POLICY_INVALID
```

且响应明确声明：

```text
committed = false
```

Node 可以在不跳过 expected sequence 的前提下重新切批 / 修正请求。

### 提交结果不确定

例如：

```text
request timeout
connection reset after upload
Hub crash / response lost
```

Node 必须假设“可能已提交”。

处理：

```text
retry exact immutable batch
or
query / handshake Hub ACK
```

不能用同一 sequence 发送新内容。

## 9. Policy 收紧必须立即停止旧策略继续出站

例如：

```text
full -> metadata-only
```

用户保存新策略后：

1. 立即阻止产生新的旧 Policy 网络请求；
2. 未序列化 Candidate 按新 Policy 重新计算；
3. 已 ACK 的旧数据不会自动从 Hub 删除；需要独立 Purge；
4. 已明确未提交的旧 Batch 可以废弃并按新 Policy 重建；
5. 对“是否已经提交不确定”的旧 Batch，不能为了补 sequence gap 再继续发送已被新 Policy 禁止的正文。

第 5 种情况必须进入安全暂停，并通过 Stream Rollover 恢复，而不是牺牲用户刚刚收紧的隐私边界。

## 10. Replication Stream Rollover

除 Re-pair 外，Alpha 允许由已认证 Node 与 Hub 显式执行 Stream Rollover：

```text
old stream -> freeze
new stream -> sequence starts at 1
nodeId / hubId / trust relationship unchanged
existing Replica Generation preserved
```

适用：

- Policy 收紧遇到旧策略 ambiguous in-flight Batch；
- Stream Cursor / receipt 状态需要安全重建；
- 明确的协议恢复流程要求重新建立 sequence namespace。

Rollover 必须由当前 Node Key 签名并由 Hub 接受，不等于重新 Pair，也不允许改变 upstream Hub Identity。

新 Stream 通过 Reconciliation 与已有 Replica Generation 收敛。

## 11. Policy 放宽不能自动扩大历史授权

例如：

```text
metadata-only -> full
```

用户必须分别选择：

```text
A. 仅未来新事实按 full
B. 未来 + 既有历史都按 full 补传
```

A 只增加 Policy Revision，不扩大 History Boundary。

B 同时增加 History Revision，并触发受控 Bootstrap / Reconciliation。

## 12. Replica Generation 解决 Re-bootstrap 的“缺失是否等于删除”问题

普通 Reconciliation 永远不能把：

```text
这次扫描没看到 Entity X
```

解释成删除。

但是显式 Re-bootstrap 的目的就是重建某个 Node 在 Hub 的完整 Replica。如果不定义新的 Replica Generation，Hub 可能永久留下早已不再存在、但 Tombstone 已丢失的陈旧 Replica。

因此 Re-bootstrap 使用新的：

```text
replicaGenerationId
```

概念流程：

```text
active generation G1
  -> create staged generation G2
  -> bootstrap current authorized state into G2
  -> mandatory reconciliation into G2
  -> validate completeness
  -> atomically activate G2
  -> retire G1
  -> GC retired generation later
```

Local Capture 在此期间继续运行。

具体 SQLite 可以使用 staging metadata、shadow namespace 或其他实现；Contract 只要求“旧 generation 在新 generation 完成之前仍可查询，不把半成品当 active”。

## 13. Absence 只有在完整 Generation 激活时才有权威语义

普通扫描：

```text
absence != delete
```

显式 Re-bootstrap Generation 完整激活时：

```text
old generation 中存在
new complete generation 中不存在
```

可以作为“新 Replica 数据集不再包含该 origin entity”的重建结果处理。

这是一个严格限定的例外，不得让普通 Reconciliation 靠 absence 制造 Tombstone。

Shared Assertion 也必须按新 Generation 的完整来源集合重新计算，避免旧 generation 的来源 assertion 永久残留。

## 14. Tombstone 保留

Node-side Tombstone 是不可仅靠 Canonical Scan 重建的 Durable Replication State。

至少在以下条件满足前不得 GC：

- 对应 Tombstone 已被 Hub ACK；
- 当前 relationship 的 active Replica Generation 已包含该删除结果；
- Tombstone ACK 后至少完成一次成功 Reconciliation / consistency checkpoint；
- 没有需要复用旧 generation / stream 恢复的未决状态。

实现可以采用更保守保留策略。

不得仅因为“发送过一次”就删除 Tombstone。

## 15. Control Plane Retention 分类

### 短期状态

可以按时间窗口 GC：

```text
nonce replay cache
transient retry logs
temporary pairing offers
```

### Stream 级状态

至少保留到 Stream 被明确 retired 且不再需要处理重试：

```text
sequence receipt hash
ack cursor
batch diagnostic receipt
```

冻结 Stream 的 receipt 不能在仍可能收到旧重放请求时立即清空。

### Node / Replica 长期状态

只允许显式清理或安全 GC：

```text
Replica Entity Map
Permanent Alias
Shared Identity Assertion provenance
Replica Generation metadata
Tombstone（按上一节）
```

Permanent Alias 不能因为旧 Replica Row 已移除就立即删除，否则旧 Batch 重放可能重新制造重复实体。

### Diagnostics

Conflict / Security Event 的保留可以有运维期限，但清理 Diagnostics 不能改变 Canonical / Replica 实际状态。

## 16. Sequence Receipt 不要求永久保留每个完整 Batch Body

Hub 为防止：

```text
same sequence + different body
```

至少要保留稳定 receipt：

```text
nodeId
streamId
sequence
contentHash
committedAt
```

不要求为了重试校验永久保存原始 Batch Body。

Stream retire 后 receipt 可按明确 retention / checkpoint 策略压缩或清理，但不得导致 frozen stream 被错误重新激活。

## 17. Hub 本机参与 Shared Identity

Hub 默认也可以 `localCapture=true`。本机 Project / AssetDefinition 不经过网络 Replication Client，但不能因此被排除在跨机器 Shared Identity 汇聚之外。

因此 Hub 的 Shared Identity Resolver 必须把本机 Node 视为一个合法 origin：

```text
originNodeId = Hub 自己的 nodeId
originEntityId = 本机 Canonical Entity ID
```

当本机 Project / AssetDefinition 获得可靠 Portable Identity 时，可以产生本地 Shared Assertion / Membership。

关键要求：

- 不为了“自我同步”走 HTTPS；
- 不把本机 Canonical ID 假装成天然跨机全局 ID；
- Shared Projection / Group Resolver 必须同时考虑 Hub-local assertion 与 Remote assertions；
- Hub 本机引用无需为了网络复制强制改写 payload；
- 如果实现选择对本机 Canonical FK 做 Shared Promotion，必须保证 IdentityService / Alias 长期可重入，不能下一次本机 Source 扫描又重新制造旧 Project；
- Alpha 更保守的实现可以让 Hub-local origin row 保持原 ID，通过 Shared Identity Membership 在 Projection 层统一聚合。

这一节优先保证本机与远程在产品聚合语义上对等，不强制某一种 SQLite 物理表示。

## 18. 跨机器时钟不是一个可信全序

Replication Security 使用 Timestamp 防重放，但这不等于不同机器的业务事件时钟完全同步。

Node / Hub 必须保留原始：

```text
occurredAt
capturedAt
```

Hub 不使用 `replicatedAt` 覆盖业务事件时间。

Handshake / Status 应允许 Hub 返回：

```text
serverTime
```

Node 可以估算 clock skew 并做 diagnostics。

如果安全签名时间超过允许窗口，Replication 可以被阻塞；如果仍在允许窗口内，也不能据此声称跨 Node 事件具有毫秒级全局先后关系。

## 19. Hub Projection 的跨机排序语义

跨 Node Unified Timeline / Session List：

- 优先使用当前 Canonical Projection 已定义的业务时间；
- 在不同 Node 之间只提供 best-effort 时间排序；
- 不从时间戳自动推断跨 Node 因果关系；
- clock skew 明显时可在 Diagnostics / UI 给出提示；
- 相同时间或无法可靠比较时使用稳定 tie-breaker，例如 `originNodeId + canonicalSequence / replicaKey`，保证分页结果确定，而不是依赖 SQLite 插入顺序。

Shared Merge 中 `createdAt=min()` / `lastSeenAt=max()` 仍是确定性聚合元数据，但各 Node assertion 的原始时间必须保留；这些字段不能被解释为外部仓库真实创建时间。

## 20. Hub 配置属于共享 AgentLens 数据根

npm / Desktop 是双发行、单运行时、共享数据。

因此以下内容不能分别存在“npm 一份 / Desktop 一份”：

```text
nodeId
Hub capability config
upstream Hub relationship
Replication Policy / History Boundary
Hub Identity metadata
Node Registry / Stream metadata
```

它们属于同一个默认数据根 / Daemon Runtime。

平台壳可以提供不同设置入口，但最终必须落到同一配置 / Control Plane。

卸载 npm 或 Desktop 其中一种发行方式，不能顺带删除另一发行仍依赖的 Hub Identity / Node Identity / Replication State。

## 21. Headless Pure Hub 的管理边界

Alpha 不开放带账号认证的 Remote Web。

因此 Pure Hub 跑在 NAS / Linux Server 时，正式管理方式是：

- 本机 CLI；
- SSH 后在服务器上执行 CLI；
- 用户自己建立可信的本机端口转发 / OS 远程会话访问 loopback Web（AgentLens 不把该隧道当成内建 Remote Web）。

AgentLens 不为了方便 Headless 部署把 `127.0.0.1:56789` 改成无认证网络监听。

## 22. 验收不变量

实现前至少把以下场景纳入 Test Matrix：

- `hubAccept=true && replicationUpstream=true` 被配置层拒绝；
- “从现在开始”不会在后续 Reconciliation 中偷偷补传既有旧 Observation；
- 新 Observation 可以携带配对前的 Session / Project 等依赖闭包；
- Policy 收紧后不再发送新的旧 Policy Batch；
- ambiguous in-flight Batch 不能用同 sequence 改内容；
- Stream Rollover 后 existing Replica 不重复；
- Re-bootstrap 失败时 active Generation 仍保持可查询；
- staged Generation 完成前不能成为 active；
- new complete Generation 激活后可以清除旧 generation 的 stale replica / assertion；
- Tombstone 未达到安全条件不能 GC；
- Hub 本机与远程 Node 的同一 Portable Project 可以出现在同一个 Shared Project 聚合中；
- clock skew 不会把 `replicatedAt` 错当业务事件时间；
- npm / Desktop 切换 Runtime owner 不改变 nodeId / Hub relationship。
