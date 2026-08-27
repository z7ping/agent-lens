# AgentLens 1.0 Hub Replication State Contract

更新日期：2026-08-27  
状态：Alpha 架构 Contract，尚未实现  
相关文档：
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-PROTOCOL.md`
- `docs/1.0/HUB-PAIRING-SECURITY.md`
- `docs/1.0/HUB-OPERATIONS.md`

本文补齐多机 Hub 的状态语义：能力组合合法性、历史同步边界、Policy 变更、Batch 不确定提交、Replication Stream Rollover、Replica Generation、Control Plane 保留规则、Conditional Shared Group、Hub 本机参与 Shared Identity、跨机时钟与发行共存。本文不表示这些能力已经实现。

## 1. 能力组合不是任意布尔组合

底层使用：

```text
localCapture
replicationUpstream
hubAccept
```

表达能力，而不是建立四套 Runtime Role；Alpha 只允许：

| Profile | localCapture | replicationUpstream | hubAccept |
| --- | --- | --- | --- |
| Standalone | true | false | false |
| 普通接入节点 | true | true | false |
| Hub | true | false | true |
| Pure Hub | false | false | true |

拒绝：

- `replicationUpstream=true && hubAccept=true`：形成 Hub 级联 / Federation；
- `localCapture=false && replicationUpstream=true`：未定义纯转发 ownership；
- 全 false：空运行时。

从接入节点切换为 Hub，必须先冻结 / 断开 upstream relationship。

## 2. 四种不同身份 / 状态键

```text
nodeId
  = AgentLens 数据根 / 实例身份

hubId
  = Hub 长期信任身份

replicationStreamId
  = sequence / ACK 命名空间

replicaGenerationId
  = Hub 中某个 Remote Node Replica 数据集的一代状态
```

关系：

```text
Node Identity
  -> Pairing Relationship
      -> active Stream
          -> active Replica Generation
```

规则：

- 换 Stream 不等于换 Node；
- 换 TLS Certificate 不等于换 Hub；
- Re-bootstrap 可以换 Generation，不必换 Stream；
- Re-pair 默认换 Stream；
- Node Identity Reset 形成新的 Replica Namespace；
- Shared Project / Asset Group Key 不属于上述四种状态键，它描述跨 origin 聚合身份。

## 3. History Scope 与 Replication Policy 是两个维度

Replication Policy：允许传哪些字段 / 内容。

History Scope：允许补传哪些既有历史事实。

Alpha：

```text
historyMode = from-now | include-existing
```

首次 Pairing 与后续 Policy 放宽都必须明确 History Scope。

## 4. `from-now` 不是按 occurredAt 简单过滤

不能只用：

```text
occurredAt >= pairingTime
```

因为来源时间质量不同、新发现的 History 可能发生在更早时间、新事实又可能依赖旧身份实体。

正式语义：

> 不对建立 History Boundary 时已经存在于 Local Canonical Store 的普通历史事实集合执行补传；但为了复制边界之后的新事实，允许发送必要依赖闭包。

### 4.1 Dependency Closure

新 Observation 可以携带配对前已有的：

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

但这不授权补传该 Session 过去的全部 Observation / Prompt / Tool 正文。

对于 Conditional Shared Project / AssetDefinition，发送依赖时仍发送 origin entity；Shared Membership 只描述聚合身份。

## 5. History Boundary 必须持久化

本地 Control Plane 至少保存：

```text
relationship / hubId
createdAt
historyMode
revision
implementation-specific baseline state
```

Reconciliation 必须遵守 Boundary。

用户后来明确补传历史时创建新的 History Revision。

## 6. Policy Revision

每次 Replication Policy 变更维护单调：

```text
replicationPolicyRevision
```

Batch / Status 关联：

```text
policy
policyRevision
historyRevision
```

Hub 只能验证 / 审计，不能远程改变 Node Policy。

## 7. Batch 第一次可能发送前冻结内容

真正分配：

```text
batchSequence
batchId
contentHash
```

后，Batch Body 必须 immutable，直到得到明确提交结果。

ACK 丢失时只能重发完全相同 sequence + content hash。

## 8. 明确失败与提交不确定分离

### 明确未提交

Hub 明确返回：

```text
committed = false
```

Node 才能修正 / 重切当前 expected sequence 的待同步内容。

### 提交不确定

```text
timeout
connection reset
Hub crash / response lost
```

必须认为“可能已提交”，只能 exact retry 或查询 Hub ACK。

## 9. Policy 收紧立即阻止旧策略出站

例如：

```text
full -> metadata-only
```

规则：

1. 停止新的旧 Policy 网络请求；
2. 未序列化 Candidate 按新 Policy 重算；
3. 已 ACK 的旧正文不会自动 Purge；
4. 明确未提交 Batch 可按新 Policy 重建；
5. ambiguous 旧 Batch 不能为了 sequence 连续性继续发送已经禁止的正文。

第 5 类进入安全暂停并执行 Stream Rollover。

## 10. Replication Stream Rollover

```text
old stream -> freeze
new stream -> sequence=1
nodeId / hubId / trust unchanged
active Replica Generation preserved
```

适用：

- Policy 收紧遇到 ambiguous Batch；
- Cursor / receipt 需要安全重建；
- 协议恢复明确需要新的 sequence namespace。

Rollover 必须由当前 Node Key 签名并由 Hub 接受。

## 11. Policy 放宽不能自动扩大历史授权

```text
metadata-only -> full
```

用户选择：

```text
A. 仅未来按 full
B. 未来 + 既有历史按 full
```

A 只增加 Policy Revision。

B 同时增加 History Revision，并触发 Bootstrap / Reconciliation。

## 12. Replica Generation 解决 Re-bootstrap 缺失语义

普通 Reconciliation：

```text
absence != delete
```

显式 Re-bootstrap：

```text
G1 active
  -> G2 staged
  -> bootstrap current authorized state into G2
  -> mandatory reconciliation
  -> validate complete
  -> atomic activate G2
  -> retire G1
```

G2 完成前 G1 仍可查询。

Generation 主要描述 **Remote Node Origin Replica 数据集**。Conditional Shared Group Membership 必须与对应 origin generation 一起 staged / activated，不能让新 generation 尚未完成时先改变正式 Shared Group 结果。

## 13. Absence 只有完整 Generation 激活时有权威语义

普通 scan：

```text
absence != delete
```

新完整 generation 激活时：

```text
old generation 有 origin X
new complete generation 无 origin X
```

可作为“新 Replica 集不再包含 X”的重建结果。

对应 Conditional Shared Membership / Assertion 也按新 generation 的完整 origin 集重新计算。

注意：这仍然只影响该 Node 的 origin / membership，不允许因一个 Node generation 缺失而删除其他 Node 或 Hub Local 的 Shared Group 成员。

## 14. Tombstone 保留

Node-side Tombstone 不可仅靠 Canonical Scan 重建。

至少满足以下条件前不得 GC：

- Hub 已 ACK；
- active Replica Generation 已包含删除结果；
- ACK 后至少完成一次成功 Reconciliation / consistency checkpoint；
- 无仍需旧 stream / generation 恢复的未决状态。

## 15. Control Plane Retention 分类

### 短期

```text
nonce replay cache
transient retry logs
temporary pairing offers
```

### Stream 级

```text
sequence receipt hash
ack cursor
batch diagnostic receipt
```

冻结 Stream 在仍可能收到合法旧重试时不能立刻清空 receipt。

### Node / Replica 长期

```text
Replica Entity Map
Shared Identity Assertion provenance
Shared Group Membership
Promotion provenance
Replica Generation metadata
Tombstone
```

Conditional Shared 不再依赖 `ReplicaKey -> SharedKey` 的永久主键 Alias 来维持 FK；origin ReplicaKey 长期保持自己的身份。

如果未来为旧 wire/provenance 建立辅助 alias，它只能是 Control Plane lookup，不得改变 Conditional Shared 的 origin-FK 模型。

### Diagnostics

Conflict / Security Event 可按期限清理，但不能改变 Canonical / Replica / Membership 状态。

## 16. Sequence Receipt 不要求永久保存完整 Batch Body

Hub 至少保留：

```text
nodeId
streamId
sequence
contentHash
committedAt
```

用于验证 same sequence + same content。

## 17. Conditional Shared Group 是唯一 Alpha 物理模型

`Project`、`AssetDefinition` 的跨 Node 汇聚固定使用：

```text
Origin Row
  -> Shared Identity Assertion
  -> Shared Group Membership
```

Alpha **不允许**一部分路径采用：

```text
origin row + membership
```

另一部分路径采用：

```text
rewrite origin FK -> shared primary key
```

否则会产生两种 Repository / Tombstone / Generation / IdentityService 语义。

固定要求：

- Conditional Shared Origin Row 永久保留自己的 Canonical / Replica ID，除非该 origin 本身被删除；
- 领域 FK 永远指 origin row；
- SharedKey 只标识 Shared Group；
- Promotion 只创建 / 更新 Membership，不批量改 FK；
- 同一 Node 的多个 origin row 可以在强证据下加入同一 Group；
- Group merged metadata 可由 active assertions 重建。

真正 `shared` 的 `AgentProduct` 不受此规则限制，可以使用一个 Shared Canonical Root。

## 18. Hub 本机参与 Shared Identity

Hub 默认可 `localCapture=true`。本机 Project / AssetDefinition 不走 HTTPS，但必须与 Remote 使用同一个 Shared Group Contract：

```text
originNodeId = Hub nodeId
originEntityId = local Canonical ID
```

当本机获得 Portable Identity：

```text
Hub Local Origin Row
  -> local Shared Assertion
  -> Shared Group Membership
```

要求：

- 不走自我 HTTPS；
- 本机 FK 不改写为 SharedKey；
- Remote FK 也不改写为 SharedKey；
- Shared Group Resolver 同时考虑 Hub Local / Remote memberships；
- 删除 Hub Local origin 只撤回自己的 membership，不影响 Remote members。

这使本机与远程在物理与产品语义上完全一致。

## 19. Shared Group 与 Replica Generation 的关系

Remote Node Re-bootstrap G2 时，其 membership 也属于 G2 staged state：

```text
G1 origin memberships active
G2 origin memberships staged
```

G2 未激活前：

- 正式 Projection 继续使用 G1 memberships；
- 不因 G2 尚未扫描到某 Project 就撤回 G1 membership；
- G2 complete + activate 后再原子切换该 Node 的 active membership set。

Hub Local membership 不属于 Remote Replica Generation；它随本机 Canonical / Identity 状态独立维护。

## 20. 跨机器时钟不是可信全序

Replication Security 使用 Timestamp 防重放，但业务事件保留：

```text
occurredAt
capturedAt
```

Hub 不使用 `replicatedAt` 覆盖业务时间。

Handshake / Status 提供 `serverTime` 仅用于 Clock Skew diagnostics / security。

## 21. Hub Projection 跨机排序

- 优先当前 Canonical Projection 业务时间；
- 跨 Node 只提供 best-effort 排序；
- 不从时间戳推断跨 Node 因果；
- 相同 / 不可靠时间使用稳定 tie-breaker，例如 `originNodeId + replicaKey`；
- Shared Group `createdAt=min()` / `lastSeenAt=max()` 只是聚合元数据，保留各 assertion 原始时间。

## 22. Hub 配置属于共享 AgentLens 数据根

npm / Desktop 共享：

```text
nodeId
Hub capability config
upstream relationship
Replication Policy / History Boundary
Hub Identity metadata
Node Registry / Stream metadata
Shared Group / Membership state
```

不能分别存在 npm / Desktop 两份。

卸载其中一种发行不能删除另一发行依赖的 Hub / Node / Replication State。

## 23. Headless Pure Hub 管理边界

Alpha 不开放 Remote Web。

Pure Hub 管理方式：

- 本机 CLI；
- SSH 后执行 CLI；
- 用户自己建立可信 loopback tunnel / OS 远程会话。

AgentLens 不因此把 `127.0.0.1:56789` 改成无认证网络监听。

## 24. 验收不变量

至少纳入测试：

- 非法 capability 组合被拒绝；
- `from-now` 不被 Reconciliation 绕过；
- 新事实允许旧依赖闭包；
- Policy 收紧不继续发送旧敏感 ambiguous Batch；
- Stream Rollover 不重复 Replica；
- Re-bootstrap staged Generation 未完成不影响 active 查询；
- G2 激活时只切换该 Node origin/membership set；
- Tombstone 未满足安全条件不能 GC；
- Project Promotion 不修改 Workspace / Session / Observation 的 origin FK；
- Hub Local 与 Remote 同 Portable Project 进入同一 Shared Group；
- 删除一个 member 不删除其他 members；
- Remote Re-bootstrap 不改变 Hub Local membership；
- clock skew 不把 replicatedAt 变成业务时间；
- npm / Desktop 切换 owner 不改变 nodeId / relationship。
