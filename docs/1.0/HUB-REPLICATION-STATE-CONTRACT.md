# AgentLens 1.0 Hub Replication State Contract

更新日期：2026-08-27  
状态：Alpha 架构 Contract 冻结，尚未实现  
相关入口：`docs/1.0/HUB-DESIGN-INDEX.md`

本文定义 Hub 长期状态语义：Capability、Identity、History Boundary、Policy Revision、Stream / ACK、Replica Generation、Retention、Conditional Shared Membership、Replica Storage availability 与跨机时间。

## 1. Capability Profile

底层：

```text
localCapture
replicationUpstream
hubAccept
```

Alpha 只允许：

| Profile | localCapture | replicationUpstream | hubAccept |
| --- | --- | --- | --- |
| Standalone | true | false | false |
| Node | true | true | false |
| Hub | true | false | true |
| Pure Hub | false | false | true |

拒绝级联 Hub、纯转发节点和全 false。

## 2. 四个独立状态键

```text
nodeId
hubId
replicationStreamId
replicaGenerationId
```

- nodeId：数据根 / AgentLens 实例身份；
- hubId：长期 Hub 信任身份；
- streamId：Sequence / ACK namespace；
- generationId：某 Remote Node Replica 数据集的一代状态。

换 Stream 不等于换 Node；换 TLS 证书不等于换 Hub；Re-bootstrap 可以换 Generation；Node Identity Reset 创建新 Replica Namespace。

## 3. History Scope 与 Policy 分离

```text
Policy: metadata-only | redacted | full
History: from-now | include-existing
```

Policy 决定字段；History Scope 决定 Boundary 前已有历史是否授权补传。

## 4. from-now Boundary

`from-now` 不能只靠：

```text
occurredAt >= pairingTime
```

正式语义：不普通补传建立 Boundary 时已经存在的历史事实集合；Boundary 后新事实可以带必要 Dependency Closure。

Boundary 必须持久化，并由 Reconciliation 持续遵守。

## 5. Dependency Closure 是最小字段闭包

Boundary 后新 Observation 可引用 Boundary 前已有的：

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

但只允许发送建立引用图需要的 Minimum Dependency Shape。

不因为 dependency 自动授权：旧 title、非必要 startedAt/endedAt、full path、Prompt/Tool body、SourceRecord payload 等。

这些字段进入 Remote Replica 时使用：

```text
omitted(history-boundary)
omitted(dependency-minimized)
```

Minimum Dependency Shape 必须按 Entity Type 注册、版本化测试，不能由 Serializer 临时拍脑袋。

## 6. Policy / History Revision

本地 Control Plane 至少保存：

```text
relationship / hubId
historyMode
historyRevision
replicationPolicy
policyRevision
boundary baseline state
```

Batch / Status 关联对应 Revision。Hub 只能验证 / 审计，不能远程改 Node Policy。

## 7. Batch Immutable Boundary

一旦分配并可能发送：

```text
batchSequence
batchId
contentHash
body
```

就必须 immutable，直到得到明确提交结果。

ACK 丢失只能 exact retry 或查询 Hub ACK。

## 8. 明确未提交与提交不确定

### committed=false

Node 可按 Protocol 重切当前 expected sequence。

### timeout / reset / Hub response lost

必须当作可能已提交，只能 exact retry。

## 9. Policy 收紧

`full -> metadata-only` 后：

1. 立即停止新的旧 Policy 请求；
2. 未序列化 pending state 按新 Policy 重算；
3. 已 ACK old full 不自动 Purge；
4. 明确未提交 Batch 可以新 Policy 重建；
5. ambiguous old-policy Batch 禁止为填 sequence gap 重发敏感正文。

第 5 类通过 Stream Rollover 恢复。

## 10. Stream Rollover

```text
old stream frozen
new stream sequence=1
nodeId / hubId / Node Key unchanged
active Replica Generation unchanged
```

新 stream 通过 Reconciliation 与现有 Remote Replica 收敛。

## 11. Policy 收紧后的 retained prior value

Remote Replica 可能同时存在：

```text
current availability = omitted(policy)
retained prior value = older authorized revision
```

状态层必须保留足够 provenance，不能把 retained prior value 宣称为当前 Policy 最新确认。

Policy Setting Change 不等于 Purge。

## 12. Policy 放宽

`metadata-only -> full` 时用户选择：

```text
only future
或
include existing history
```

前者只增加 Policy Revision；后者还增加 History Revision，并触发受控 Bootstrap / Reconcile。

## 13. Replica Generation

普通 Reconcile：

```text
absence != delete
```

显式 Re-bootstrap：

```text
G1 active
 -> G2 staged
 -> bootstrap authorized current state
 -> mandatory reconcile
 -> validate complete
 -> atomic activate G2
 -> retire G1
```

G2 完成前 Unified Read 继续只读 G1。

## 14. Generation 与 Shared Membership

Remote Node 的 Conditional Shared Membership 属于该 Node Generation：

```text
G1 memberships active
G2 memberships staged
```

G2 激活时只切换该 Node 的 origin / memberships，不影响其他 Node 或 Hub Local。

Hub Local Membership 不属于 Remote Generation。

## 15. Absence 的有限权威语义

普通扫描 absence 不表示 delete。

完整 G2 激活后：

```text
G1 有 X
G2 complete 无 X
```

才可以把 X 视为新完整 Replica 集不再包含的 stale origin，并按 Retention / dependency 规则清理。

## 16. Tombstone Retention

Node-side Tombstone 不可仅靠 Canonical Scan 重建。

至少在以下条件满足前不 GC：

- Hub ACK；
- active Generation 已反映删除；
- ACK 后至少一次成功 Reconcile / consistency checkpoint；
- 无仍依赖旧 stream / generation 的恢复状态。

## 17. Control Plane Retention

### 短期

```text
nonce cache
retry log
temporary pairing offer
```

### Stream 级

```text
sequence receipt hash
ack cursor
batch diagnostic receipt
```

### Node / Replica 长期

```text
Replica Entity Map
Shared Assertion / Membership provenance
Promotion provenance
Replica Generation
Tombstone
Policy / History state
```

Conditional Shared 不依赖永久“主键 Alias”维持 FK。

## 18. Conditional Shared 唯一模型

Project / AssetDefinition 固定：

```text
Origin Local Row / Remote Replica
 -> Shared Identity Assertion
 -> Shared Group Membership
```

领域 FK 永远指 origin。Promotion 只增加 / 更新 Membership。

同一 Node 的多个 origin 在强证据下可以 Membership 到同 Group。

## 19. Hub Local 参与 Shared Identity

Hub Local Origin：

```text
originNodeId = hub nodeId
originEntityId = local Canonical ID
```

不走 HTTPS，但使用同一 Shared Identity / Membership Contract。

删除 Hub Local origin 只撤回自己的 Membership。

## 20. Local Canonical / Remote Replica 状态分层

Hub 状态模型必须接受：

```text
Local Canonical Store
Remote Replica Store
Shared Identity State
Replication Control Plane
Unified Read Repository
```

Remote Replica 的 `value / redacted / omitted` 属于持久 Replica Data Plane 状态，不进入 Local Core Domain，也不是 Projection。

Staged Generation 的 Replica / Membership 不能进入正式 Unified Read。

## 21. Unified ID 状态语义

- Hub Local Entity：现有 Local Canonical ID；
- Remote Entity：保留 namespace 的 ReplicaKey；
- Shared Group：SharedGroupKey；
- Web 只把这些 ID 当 opaque string；
- Node / scope / origin 走正式 DTO，不通过字符串解析。

Node Identity Reset 后，旧 Hub Replica ID 不自动重映射到新 Node。

## 22. Node Identity Reset

Reset：

- 新 nodeId；
- 新 Node Key；
- 清 upstream pairing / stream；
- Local Canonical 保留；
- 本机 Canonical PK 不改；
- 重新连接必须 Pair。

同步到原 Hub 时形成新的 Replica Namespace。若再次 include-existing，old/new Node history 可以同时存在；Alpha 不自动跨 nodeId dedup。

## 23. Re-pair / Revoke / Delete 分离

### Re-pair

重建安全关系，通常新 Stream；nodeId 未变时 ReplicaKey 不变。

### Revoke

停止未来 Replication，默认保留历史 / Membership provenance。

### Delete Node History

显式高风险操作，删除该 Node Remote Replica Data Plane，并撤回其 memberships / 重算 Groups。

三者不能混成一个按钮。

## 24. Cross-node Clock

Request Timestamp 用于重放防护，不证明跨机业务先后。

Hub 保留 origin `occurredAt / capturedAt`，不以 `replicatedAt` 覆盖。

统一排序只提供 deterministic best-effort；同时间使用稳定 originNodeId / ReplicaKey tie-break。

## 25. npm / Desktop 共用状态

默认数据根共享：

```text
nodeId
Hub capability config
Pairing relationship
Policy / History Boundary
Hub / Node identity metadata
Stream / Generation
Shared Membership state
```

切换 Daemon owner 不改变这些状态。

## 26. Headless Pure Hub

Alpha 不开放 Remote Web Login。

Pure Hub 管理通过本机 CLI、SSH CLI、OS Remote Session 或用户自行建立可信 loopback tunnel。

Local `127.0.0.1:56789` 不因此暴露网络。

## 27. 验收不变量

- 非法 Capability 被拒绝；
- from-now 不被 Reconcile 绕过；
- dependency 只发送 Minimum Shape；
- history-boundary / dependency-minimized 可区分；
- Policy 收紧不重发 ambiguous 敏感 Batch；
- retained prior value 不冒充当前 fresh value；
- Stream Rollover 不重复 Replica；
- G2 staged 不影响 G1 Query；
- G2 activation 只切换该 Node memberships；
- Tombstone 满足安全条件前不 GC；
- Promotion 不改 origin FK；
- Hub Local + Remote 同 Portable Project 进入同 Group；
- Remote Replica omission 不污染 Local Canonical；
- Hub Local ID / Remote ReplicaKey 在统一查询中不歧义；
- Node Reset 形成新 Replica Namespace；
- Clock Skew 不被当成业务全序。
