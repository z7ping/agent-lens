# AgentLens 1.0 Hub 运维与生命周期

更新日期：2026-08-27  
状态：Alpha 运维设计冻结，尚未实现  
相关入口：`docs/1.0/HUB-DESIGN-INDEX.md`

本文定义多机 Hub 的真实生命周期，不表示 CLI / Web 已经实现。

## 1. 使用模型

Alpha 单 Hub 星型拓扑，只允许：

| Profile | localCapture | replicationUpstream | hubAccept |
| --- | --- | --- | --- |
| Standalone | true | false | false |
| 普通接入节点 | true | true | false |
| Hub | true | false | true |
| Pure Hub | false | false | true |

拒绝 hubAccept+replicationUpstream、多个 upstream、级联/Federation、纯转发节点和 Hub 反向控制 Node。

## 2. 启用 Hub

仍是同一个 Runtime / 数据根。Local HTTP 继续 loopback，新增独立 Replication HTTPS Surface。Hub 默认采集本机；关闭 localCapture 形成 Pure Hub。

首次初始化 Hub Identity、TLS Material、Node Registry 和 Replication Control Plane。失败不得破坏 Standalone 本地采集。

## 3. 从“连接 Hub”切换为“作为 Hub”

先冻结 / 断开 upstream relationship，再关闭 replicationUpstream、打开 hubAccept、重启 Runtime。不能两个能力同时打开形成隐藏级联。

## 4. Hub 本机也是 Node origin

```text
Local Source -> Local Canonical Commit -> Hub Local Canonical Store
                                      -> Unified Read
```

不经过 HTTPS 自我上传。

Hub Local Project / AssetDefinition 与 Remote 一样保留自己的 origin；获得 Portable Identity 时加入 Shared Group Membership。跨机聚合通过 Group，不修改本机 FK。

## 5. 添加 Node

```text
Hub: Pairing Offer
Node: verify TLS / Hub Identity
 -> choose Replication Policy
 -> choose History Scope
 -> Pair + verify Receipt
 -> Handshake + serverProof
 -> Bootstrap or from-now baseline
 -> Reconcile
 -> Synced
```

必须明确 endpoint / Hub identity / Policy / History Scope / 是否补历史。Hub 必须拒绝把自己的 local nodeId 配对成 Remote Node。

## 6. Policy 与 History Scope

```text
Policy: metadata-only | redacted | full
History: from-now | include-existing
```

include-existing：当前授权历史进入 Bootstrap。

from-now：不普通补传 Boundary 前历史；以后新事实可携带必要 FK / Identity Dependency Closure。Boundary 持久化，Reconciliation 继续尊重；Dependency Closure 只发送 Minimum Shape。

## 7. Node Replication 状态

至少：未连接、配对中、首次同步、校准中、已同步、同步延迟、已暂停、需要处理、已撤销。本地采集始终单独表达，不把 Hub 故障显示成 AgentLens 全局故障。

## 8. Bootstrap 进度

报告 phase、history mode、policy/revision、scanned/acked entities、bytes、sequence、Hub ACK、backlog、last success。断线按 Hub ACK 恢复，完成后必须 Reconcile。

## 9. from-now 首次连接

建立持久 History Boundary / baseline。新事实可以补 Host / Installation / Project / Workspace / Session / Actor / Asset 等依赖，但不能因此补 Boundary 前全部 Prompt / Tool / Observation 或非必要 title/path/time。

## 10. Incremental Backlog 与本机磁盘压力

Hub 不可达时 backlog 只属于 Replication 运维状态：不丢 Local Canonical，不影响 Source 正确性。

Node 不应为所有未 ACK Entity 永久复制一份完整 Payload：

- 普通未发送 pending 优先保存 identity/hash/revision/scheduling metadata，可从 Local Canonical Reconciliation 重建；
- 已可能发网且提交结果不确定的 immutable Batch 必须保留 exact retry Body；
- Tombstone、History Boundary、Policy/History Revision、Stream/ACK 等关键状态不可因空间不足丢弃；
- Replication 本地状态达到容量阈值时，暂停/降级同步，Local Capture 继续；
- 可重建 pending cache 可以清理，空间恢复后再 Reconcile。

状态至少报告 endpoint、last connected/ACK、pending、oldest age、backlog storage、last reconcile/error、policy/history revision。

## 11. Hub / Node 离线

Hub 离线：Node Local Capture / Web 正常，Replication degraded + backoff。

Node 离线：Hub 已有历史仍可查，显示 lastSeen，不把 offline 当删除，不反向探测 Node。

## 12. 重试与退避

Retryable Error 使用有上限指数退避+jitter，尊重 retryAfterMs；non-retryable 进入 blocked/paused。

## 13. Commit Ambiguity

Hub 可能已 COMMIT 但 ACK 丢失。Node 只能 exact retry immutable Batch 或查询 ACK；不能同 sequence 换 Body。只有明确 committed=false 才能修正 expected sequence。

## 14. Policy 收紧

full -> metadata-only：立即停止新的旧 Policy 请求；未序列化 pending 按新 Policy 重算；已 ACK 历史不自动 Purge；明确未提交 Batch 可重建；ambiguous old-policy Batch 不继续发已禁止正文。

```text
pause old stream -> authenticated rollover -> new stream -> reconcile new policy
```

## 15. Policy 放宽

metadata-only -> full 时分别选择“仅未来”或“补传已有历史”。前者只改 Policy Revision；后者同时扩大 History Revision并受控 Bootstrap/Reconcile。

## 16. Stream Rollover

不等于 Re-pair：nodeId/hubId/NodeKey 不变；旧 stream frozen；新 stream sequence=1；existing Generation 保留。

## 17. 协议 / Entity Version 不兼容

只阻塞 Replication；Local Capture/DB/Web 正常。不允许不认识 entityType/entityVersion 时静默丢字段后假装成功。

## 18. 推荐升级顺序

先 Hub，验证旧 Protocol / Entity Version support，再逐台 Node 升级，最后退出旧协议。

## 19. Reconcile / Repair

```text
Local Canonical
 -> History Boundary
 -> Replication Policy
 -> entity hash
 -> acknowledged state
 -> repair
```

不修改原生 Agent、不重跑 Source Parser 作为 Hub 修复、不用 Hub 覆盖 Node Canonical、不从普通 absence 推断删除。

## 20. Re-bootstrap 与 Replica Generation

```text
G1 active
 -> G2 staged
 -> bootstrap
 -> reconcile
 -> validate
 -> atomic activate G2
 -> retire G1
```

G2 未完成时 G1 继续可查，失败不污染 G1。

G2 必须 staged 该 Remote Node 的**全部 Shared Identity State**：Conditional Shared Membership、AgentProduct Shared Root assertion 及未来其他 Remote Shared Root assertion。只有 G2 激活时才原子切换该 Node 的 active Replica/assertion/membership set；不影响其他 Node / Hub Local assertion。

## 21. Re-pair

安全关系重建：old stream freeze -> Pair -> new stream -> existing Generation 在安全时保留 -> reconcile/bootstrap。nodeId 未变时 ReplicaKey 不重复。

## 22. Node Identity Reset

新 nodeId + Node Key，清 upstream relationship / stream，保留 Local Canonical，不改 Canonical PK。重新连接必须 Pair。同步到原 Hub 会进入新 Replica Namespace，可能与旧 Node 历史并存。

## 23. 撤销 Node

Revocation 冻结 active stream、拒绝未来上传，默认保留历史、Shared Assertions 与 Membership provenance。撤销凭据不自动改变历史聚合图。

## 24. 删除 Node 历史

```text
preview
 -> origin replica counts
 -> Shared Membership / Assertion impact
 -> confirm
 -> dependency-safe origin delete
 -> withdraw this Node assertions/memberships
 -> recompute Groups
 -> safe GC
```

与 Revocation 完全分开。

## 25. Tombstone / Membership / Receipt 保留

Tombstone 至少等 Hub ACK + consistency checkpoint；Shared Membership / Promotion provenance 按 State Contract 长期保留；active/frozen Stream Sequence Receipt 保留到可安全 retire；Nonce / Pair Offer 等按窗口 GC。

## 26. Hub 数据丢失

Remote Replica 可从 Nodes 重建，但 Hub Identity/TLS Key、Node Registry/Public Keys、Pairing relationship、Stream/Cursor/Generation、Shared assertion provenance 等需要独立恢复策略。Hub Identity Key 丢失时不能因 SQLite/endpoint 仍在就假装原 Hub。

## 27. Node 本地数据丢失

Hub 不是默认灾备工具。Alpha 不做 Hub -> Node Canonical restore；Hub 可能保留历史，新本机采集形成新的本地事实链。

## 28. Hub 地址 / TLS 变化

IP/hostname 变化不等于 Hub Identity 变化。公共 CA 仍需 hostname 验证；自管理 TLS 仍需 SPKI/Hub Identity。endpoint 相同但 Hub Proof 失败必须 blocked。

## 29. Hub -> Pure Hub

关闭“采集本机数据”只停止后续 Local Source / Capture：

- 已经存在的 Hub Local Canonical 历史继续可查；
- 已有 Hub Local Shared Project / Asset Membership 继续参与聚合；
- 不自动删除或隐藏旧本机数据；
- 删除本机历史必须是另一个显式操作。

Pure Hub 不启动新的 Source，但不是“清空本机历史模式”。

## 30. Disable Hub Capability

关闭 Hub 接收能力不是删除 Hub 数据：

```text
stop Replication Surface
 -> freeze/pause downstream streams operationally
 -> preserve Remote Replica / Shared Identity / Trust / Control Plane
 -> Local Web / Local Canonical continue
```

重新启用后，在 Hub Identity、Pairing、Protocol 仍有效时可以恢复。撤销 Node、删除远程历史、重置 Hub Identity分别是独立操作。

## 31. Remote Asset 与资产备份边界

Hub 中 Remote AssetDefinition / AssetBinding 是**远程观测副本**，不代表对应文件存在于 Hub 本机文件系统。

现有“资产备份”能力只能对 Hub 本机真正可访问、并由本机 Source / Asset Inventory 发现的文件执行文件级 Snapshot。

禁止：

- 把 Remote `AssetBinding.path` 当成 Hub Local Path 去 `readFile/copy`；
- 因远程路径与 Hub 本机恰好同字符串就自动认为可访问；
- 在 Backup UI 把“看得到 Remote Asset metadata”展示成“可以备份远程文件”。

Alpha：Remote Asset 可以查看、过滤和聚合；Remote File Backup / Pull / Export 是独立未来能力。

## 32. Pure / Headless Hub

Alpha 不内建 Remote Web Login；Headless 通过 SSH CLI、OS 远程会话或用户自建可信 loopback tunnel 管理，不把 Local Web 直接暴露网络。

## 33. Clock Skew 与跨机时间

serverTime/skew 是安全/diagnostic 状态，不进入 Canonical Observation。Hub 保留 origin occurredAt/capturedAt，不用 replicatedAt 改写，也不声称跨 Node 毫秒级因果全序。

## 34. Hub 写入压力

Remote Bootstrap / Reconcile / backlog catch-up 不能饿死 Hub 本机 Canonical Commit。Hub 对 Remote Import 使用有界队列/并发、小事务与 backpressure；压力时可以 `SERVER_BUSY` / 降速，而 Local-first 本机采集保持优先可用。

## 35. 双发行共存

nodeId、Hub Identity、Policy、History Boundary、Pairing Relationship、Stream/Generation、Shared Group/Membership 都属于共享默认数据根。npm/Desktop 切换 Daemon owner 不重新 Pair/Identity，也不生成第二套状态。

## 36. Alpha 运维验收

至少覆盖：

1. Standalone 开 Hub 后本机历史/Web 不变化；
2. Hub 拒绝 self-pair；
3. Pure Hub 不启动 Source，但已有 Hub Local 历史仍可查；
4. Disable Hub 不删除 Remote Replica / Pairing State；
5. include-existing Bootstrap 可恢复；
6. from-now + Minimum Dependency Closure 正确；
7. Hub 离线 backlog 收敛，backlog storage pressure 不伤 Local Canonical；
8. Protocol / Entity Version 不兼容只阻塞同步；
9. Policy 放宽不无确认补旧正文；
10. Policy 收紧 ambiguous Batch 可安全 Rollover；
11. Reconcile 补 Fast Path 漏项；
12. staged Re-bootstrap 失败不影响 active；
13. G2 同时 staged Replica + 所有 Remote Shared assertions；
14. Re-pair 不重复 Replica；
15. Reset Identity 是新 Node；
16. Revocation 不删历史；
17. Delete History 只删除该 Node origin / assertions；
18. Hub endpoint 变化身份不变可恢复；
19. Hub Identity 丢失不会被 endpoint 掩盖；
20. Hub Local / Remote 同 Portable Project 进同 Group；
21. Remote Asset 不被本机资产备份错误读取；
22. Remote Import 压力不饿死本机 Canonical Commit；
23. npm/Desktop 切 owner 不改变 relationship；
24. Replication Status / Clock / Error / invalidation 不进入 Canonical Observation。

## 37. 当前非目标

HA/Federation、云账号、Remote Execution、Hub->Node restore、Remote File Backup、模糊跨 Node Identity、自动 Repository Rebind 历史迁移、内建 Remote Web 用户认证。
