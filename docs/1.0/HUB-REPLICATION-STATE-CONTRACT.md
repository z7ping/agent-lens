# AgentLens 1.0 Hub Replication State Contract

更新日期：2026-08-27  
状态：Alpha 架构 Contract 冻结，尚未实现  
相关入口：`docs/1.0/HUB-DESIGN-INDEX.md`

本文定义 Hub 长期状态语义：Capability、Identity、History Boundary、Policy Revision、Stream / ACK、Replica Generation、Node Backlog、Retention、Shared Identity State、Replica Storage availability 与跨机时间。

## 1. Capability Profile

底层：`localCapture / replicationUpstream / hubAccept`。

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

换 Stream 不等于换 Node；换 TLS Certificate 不等于换 Hub；Re-bootstrap 可以换 Generation；Node Identity Reset 创建新 Replica Namespace。

## 3. History Scope 与 Policy 分离

```text
Policy: metadata-only | redacted | full
History: from-now | include-existing
```

Policy 决定字段；History Scope 决定 Boundary 前已有历史是否授权补传。

## 4. from-now Boundary

`from-now` 不能只靠 `occurredAt >= pairingTime`。

正式语义：不普通补传建立 Boundary 时已经存在的历史事实集合；Boundary 后新事实可以带必要 Dependency Closure。Boundary 必须持久化，并由 Reconciliation 持续遵守。

## 5. Dependency Closure 是最小字段闭包

Boundary 后新 Observation 可引用 Boundary 前已有 Host / Installation / Project / Workspace / Session / Actor / Asset 等，但只允许发送建立引用图需要的 Minimum Dependency Shape。

旧 title、非必要 startedAt/endedAt、full path、Prompt/Tool body、SourceRecord payload 等不因为 dependency 自动获得授权，使用：

```text
omitted(history-boundary)
omitted(dependency-minimized)
```

Minimum Dependency Shape 必须按 Entity Type 注册并版本化测试。

## 6. Policy / History Revision

本地 Control Plane 至少保存 relationship/hubId、historyMode/historyRevision、replicationPolicy/policyRevision、boundary baseline state。Batch / Status 关联对应 Revision；Hub 只能验证 / 审计，不能远程改变 Node Policy。

## 7. Batch Immutable Boundary

一旦分配并可能发送 `batchSequence / batchId / contentHash / body`，就必须 immutable。ACK 丢失只能 exact retry 或查询 Hub ACK。

## 8. 明确未提交与提交不确定

- `committed=false`：Node 可按 Protocol 重切当前 expected sequence；
- timeout / reset / response lost：视为可能已提交，只能 exact retry。

## 9. Policy 收紧

`full -> metadata-only`：立即停止新的旧 Policy 请求；未序列化 pending state 按新 Policy 重算；已 ACK old full 不自动 Purge；明确未提交 Batch 可重建；ambiguous old-policy Batch 禁止为填 Sequence gap 重发敏感正文。

最后一种情况通过 Stream Rollover 恢复。

## 10. Stream Rollover

```text
old stream frozen
new stream sequence=1
nodeId / hubId / Node Key unchanged
active Replica Generation unchanged
```

新 stream 通过 Reconciliation 与现有 Replica 收敛。

## 11. Policy 收紧后的 retained prior value

Remote Replica 可能同时存在：

```text
current availability = omitted(policy)
retained prior value = older authorized revision
```

状态层必须保留 provenance，不能把旧值宣称为当前 Policy 最新确认。Policy Setting Change 不等于 Purge。

## 12. Policy 放宽

`metadata-only -> full` 时用户选择 only-future 或 include-existing。前者只增加 Policy Revision；后者还增加 History Revision，并触发受控 Bootstrap / Reconcile。

## 13. Replica Generation

普通 Reconcile：`absence != delete`。

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

G2 完成前 Unified Read 只读 G1。

## 14. Generation 覆盖全部 Remote Shared Identity State

所有由该 Remote Node origin 派生的 Shared Identity State 都属于同一 Generation：

```text
Conditional Shared Membership
Remote AgentProduct Shared Root Assertion
未来其他 Remote Shared Root Assertion
```

因此：

```text
G1 assertions/memberships active
G2 assertions/memberships staged
```

G2 激活时只切换该 Node 的 Remote Replica + Shared assertions/memberships，不影响其他 Node 或 Hub Local。Hub Local assertion 不属于 Remote Generation。

## 15. Absence 的有限权威语义

普通扫描 absence 不表示 delete。只有完整 G2 激活后，G1 有而 G2 complete 无的 origin 才能被视为新完整 Replica 集不再包含，并按 Retention / dependency 规则清理。

## 16. Tombstone Retention

Node-side Tombstone 不可仅靠 Canonical Scan 重建。至少在 Hub ACK、active Generation 已反映删除、ACK 后成功 Reconcile/consistency checkpoint、无旧 stream/generation 恢复依赖前不得 GC。

## 17. Node Backlog 不是第二份 Canonical 数据库

Node 在 Hub 离线时需要 Durable Backlog，但不能无限复制完整 Canonical payload 形成第二事实库。

固定原则：

- Local Canonical Store 仍是未 ACK Upsert 的可重建事实来源；
- 尚未冻结为 in-flight Batch 的普通 pending state 优先保存 entity identity / hash / revision / scheduling metadata，可由 Reconciliation 重新序列化；
- **已经可能发网、提交结果不确定的 immutable Batch** 必须保留 exact retry 所需 Body / Hash，直到状态被 ACK / Rollover 安全解决；
- Tombstone、History Boundary、Policy/History Revision、Stream/ACK 等关键 Control State 不得因磁盘压力丢弃；
- backlog 达到配置/安全上限时暂停或降级 Replication，不能删除 Local Canonical Fact 来腾空间；
- 非 in-flight 可重建 pending cache 可以清理，并在空间恢复后从 Local Canonical Reconcile 重建。

这保证“Hub 离线很久”不会把 Replication Outbox 演变成另一套完整事实数据库。

## 18. Backlog / 磁盘压力状态

Node 至少可区分：

```text
normal
backlog-growing
replication-storage-pressure
paused-for-local-disk
```

出现 Replication 本地磁盘压力：

- Local Capture / Canonical Commit 优先；
- Replication 可以暂停；
- UI/CLI 明确显示 backlog / 本地同步状态存储压力；
- 恢复空间后通过 Reconciliation 继续；
- 不把同步暂停显示成 AgentLens 本机采集失败。

## 19. Control Plane Retention

短期：nonce cache / retry log / pairing offer。

Stream 级：sequence receipt hash / ack cursor / batch diagnostic receipt。

Node / Replica 长期：Replica Entity Map、Shared Assertion / Membership provenance、Promotion provenance、Replica Generation、Tombstone、Policy / History state。

Conditional Shared 不依赖永久主键 Alias 维持 FK。

## 20. Conditional Shared 唯一模型

Project / AssetDefinition 固定：

```text
Origin Local Row / Remote Replica
 -> Shared Identity Assertion
 -> Shared Group Membership
```

领域 FK 永远指 origin；Promotion 只更新 Membership。同 Node 多个 origin 在强证据下可进入同 Group。

## 21. Hub Local 参与 Shared Identity

Hub Local origin 不走 HTTPS，但使用同一 Shared Identity / Membership Contract。删除 Hub Local origin 只撤回自己的 Membership。

## 22. Local Canonical / Remote Replica 状态分层

Hub 状态模型接受 Local Canonical Store、Remote Replica Store、Shared Identity State、Replication Control Plane、Unified Read Repository。

Remote `value / redacted / omitted` 是 Replica Data Plane，不进入 Local Core Domain，也不是 Projection。Staged Generation 的 Replica / assertion / membership 不进入正式 Unified Read。

## 23. Unified ID 状态语义

- Hub Local Entity：Local Canonical ID；
- Remote Entity：保留 namespace 的 ReplicaKey；
- Shared Group：SharedGroupKey；
- Web 只视为 opaque string；scope/origin 走 DTO。

Node Identity Reset 后旧 Replica ID 不自动重映射到新 Node。

## 24. Node Identity Reset

Reset 生成新 nodeId / Node Key、清 upstream relationship / stream、保留 Local Canonical、不改本机 Canonical PK。重新连接形成新的 Replica Namespace。再次 include-existing 时 old/new Node history 可同时存在；Alpha 不自动跨 nodeId dedup。

## 25. Re-pair / Revoke / Delete 分离

- Re-pair：重建安全关系，通常新 Stream；nodeId 未变时 ReplicaKey 不变；
- Revoke：停止未来 Replication，默认保留历史 / Shared provenance；
- Delete Node History：显式删除该 Node Remote Replica Data Plane 并撤回 Membership / Assertion。

## 26. Capability 关闭不等于删除数据

### Hub -> Pure Hub

关闭 `localCapture` 只停止新的本机 Source / Capture，不删除、不隐藏已经存在的 Hub Local Canonical 历史；已有本机数据继续参加 Unified Read / Shared Group，直到显式删除。

### Disable Hub Capability

关闭 `hubAccept`：

- 停止/关闭 Replication Surface；
- downstream active Stream 进入明确 paused/frozen operational state；
- 默认保留 Remote Replica、Shared Identity、Pairing/Security 与 Control Plane 状态；
- Local Web / Local Canonical 继续；
- 重新启用 Hub 后可以在身份 /协议仍有效时恢复；
- 删除 Remote 历史、重置 Hub Identity、撤销 Node 都是独立显式操作。

Capability Toggle 不能成为隐式数据销毁按钮。

## 27. Cross-node Clock

Request Timestamp 用于重放防护，不证明跨机业务先后。Hub 保留 origin `occurredAt / capturedAt`，不以 `replicatedAt` 覆盖；统一排序只做 deterministic best-effort。

## 28. npm / Desktop 共用状态

默认数据根共享 nodeId、Hub capability config、Pairing relationship、Policy/History Boundary、Hub/Node identity metadata、Stream/Generation、Shared Identity state。切换 Daemon owner 不改变这些状态。

## 29. Headless Pure Hub

Alpha 不开放 Remote Web Login。Pure Hub 管理通过本机 CLI、SSH CLI、OS Remote Session 或用户自行建立可信 loopback tunnel；Local `127.0.0.1:56789` 不暴露网络。

## 30. 验收不变量

- 非法 Capability 被拒绝；
- from-now 不被 Reconcile 绕过；
- dependency 只发送 Minimum Shape；
- Policy 收紧不重发 ambiguous 敏感 Batch；
- retained prior value 不冒充 current fresh value；
- Stream Rollover 不重复 Replica；
- G2 staged Replica / Shared Root assertion / Membership 不影响 G1 Query/Merge；
- Tombstone 满足条件前不 GC；
- 可重建 pending state 不演变成第二 Canonical DB；
- immutable ambiguous Batch 保留 exact retry Body；
- replication local disk pressure 只暂停同步，不损害 Local Canonical；
- Promotion 不改 origin FK；
- Hub Local + Remote 同 Portable Project 进入同 Group；
- Remote omission 不污染 Local Canonical；
- Hub Local ID / Remote ReplicaKey 不歧义；
- Node Reset 形成新 Replica Namespace；
- Hub -> Pure Hub 不删除既有本机历史；
- Disable Hub 不隐式删除 Remote Replica / Trust State；
- Clock Skew 不被当成业务全序。
