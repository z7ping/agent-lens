# AgentLens 1.0 Hub 运维与生命周期

更新日期：2026-08-27  
状态：Alpha 运维设计，尚未实现  
相关文档：
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-STATE-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-PROTOCOL.md`
- `docs/1.0/HUB-PAIRING-SECURITY.md`
- `docs/1.0/HUB-DATA-EXPOSURE-MATRIX.md`

本文定义多机 Hub 的真实生命周期，不表示 CLI / Web 已经实现。

## 1. 使用模型

Alpha：单 Hub 星型拓扑，只允许四个 Profile：

| Profile | localCapture | replicationUpstream | hubAccept |
| --- | --- | --- | --- |
| Standalone | true | false | false |
| 普通接入节点 | true | true | false |
| Hub | true | false | true |
| Pure Hub | false | false | true |

拒绝 hubAccept+replicationUpstream、多个 upstream、级联/Federation、纯转发节点和 Hub 反向控制 Node。

## 2. 启用 Hub

仍是同一个 Runtime / 数据根 / Canonical DB。本机 Local HTTP 继续 loopback，新增独立 Replication HTTPS Surface。Hub 默认采集本机；关闭 localCapture 形成 Pure Hub。

首次初始化 Hub Identity、TLS Material、Node Registry 和 Replication Control Plane。失败不得破坏 Standalone 本地采集。

## 3. 从“连接 Hub”切换为“作为 Hub”

先冻结 / 断开 upstream relationship，再关闭 replicationUpstream、打开 hubAccept、重启 Runtime。不能两个能力同时打开形成隐藏级联。

## 4. Hub 本机也是 Node origin

本机 Source：

```text
Local Source -> Local Canonical Commit -> Hub Unified Store
```

不经过 HTTPS 自我上传。

Hub Local Project / AssetDefinition 与 Remote 一样保留自己的 origin row；获得 Portable Identity 时加入 Shared Group Membership。跨机聚合通过 Group，不通过修改本机 FK。

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

必须明确 endpoint / Hub identity / Policy / History Scope / 是否补历史。

## 6. Policy 与 History Scope

```text
Policy: metadata-only | redacted | full
History: from-now | include-existing
```

include-existing：当前授权历史进入 Bootstrap。

from-now：不普通补传 Boundary 前历史；以后新事实可携带必要 FK / Identity Dependency Closure。Boundary 必须持久化，Reconciliation 继续尊重。

## 7. Node Replication 状态

至少：未连接、配对中、首次同步、校准中、已同步、同步延迟、已暂停、需要处理、已撤销。本地采集始终单独表达，不把 Hub 故障显示成 AgentLens 全局故障。

## 8. Bootstrap 进度

报告 phase、history mode、policy/revision、scanned/acked entities、bytes、sequence、Hub ACK、backlog、last success。断线按 Hub ACK 恢复，完成后必须 Reconcile。

## 9. from-now 首次连接

建立持久 History Boundary / baseline。新事实可以补 Host / Installation / Project / Workspace / Session / Actor / Asset 等依赖，但不能因此补 Boundary 前全部 Prompt / Tool / Observation。

Conditional Shared Project / Asset 依赖仍以 origin entity 复制，并可附 Shared Identity Assertion；不是直接创建 SharedKey FK。

## 10. Incremental Backlog

Hub 不可达时 backlog 只属于运维状态，不丢 Local Canonical，不影响 Source 正确性。状态建议显示 endpoint、last connected/ACK、pending、oldest age、last reconcile/error、policy/history revision。

## 11. Hub / Node 离线

Hub 离线：Node Local Capture / Web 正常，Replication degraded + backoff。

Node 离线：Hub 已有历史仍可查，显示 lastSeen，不把 offline 当删除，不反向探测 Node。

## 12. 重试与退避

Retryable Error 使用有上限指数退避+jitter，尊重 retryAfterMs；non-retryable 进入 blocked/paused。

## 13. Commit Ambiguity

Hub 可能已 COMMIT 但 ACK 丢失。Node 只能 exact retry immutable Batch 或查询 ACK；不能同 sequence 换 Body。只有明确 committed=false 才能修正 expected sequence。

## 14. Policy 收紧

例如 full -> metadata-only：立即停止新的旧 Policy 请求；未序列化 pending 按新 Policy 重算；已 ACK 历史不自动 Purge；明确未提交 Batch 可重建；ambiguous old-policy Batch 不继续发已禁止正文。

恢复：

```text
pause old stream -> authenticated rollover -> new stream -> reconcile new policy
```

## 15. Policy 放宽

metadata-only -> full 时用户分别选择“仅未来”或“补传已有历史”。前者只改 Policy Revision；后者同时扩大 History Revision并受控 Bootstrap/Reconcile。

## 16. Stream Rollover

不等于 Re-pair：nodeId/hubId/NodeKey 不变；旧 stream frozen；新 stream sequence=1；existing Generation 保留。用于 Policy 安全切换、sequence/receipt 恢复等。

## 17. 协议不兼容

只阻塞 Replication；Local Capture/DB/Web 正常。不允许丢字段降级假装成功。

## 18. 推荐升级顺序

先 Hub，验证旧 Protocol，再逐台 Node 升级，最后再退出旧 Protocol。

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

对于 Remote Conditional Shared，G2 同时 staged 该 Node 的 Membership 集；只有 G2 激活时才原子切换这个 Node 的 active origin/membership set。不能在 G2 尚未完成时改变正式 Shared Group 结果，也不能影响其他 Node / Hub Local membership。

## 21. Re-pair

安全关系重建：old stream freeze -> Pair -> new stream -> existing Generation 在安全时保留 -> reconcile/bootstrap。nodeId 未变时 ReplicaKey 不重复。

## 22. Node Identity Reset

生成新 nodeId + Node Key，清 upstream relationship / stream，保留 Local Canonical，不改现有 Canonical PK。重新连接必须 Pair。同步到原 Hub 会进入新 Replica Namespace，因此 UI 必须提示它会与旧 Node 历史并存，除非用户另行删除旧历史。

## 23. 撤销 Node

Revocation 冻结 active stream、拒绝未来上传，默认保留历史、Shared Assertions 与 Membership provenance。撤销凭据不自动改变历史聚合图。

## 24. 删除 Node 历史

```text
preview
 -> origin replica counts
 -> Shared Membership / Assertion impact
 -> confirm
 -> dependency-safe origin delete
 -> withdraw this Node memberships/assertions
 -> recompute Groups
 -> safe GC
```

与 Revocation 完全分开。删除一个 Node 不能删除其他 Remote / Hub Local members。

## 25. Tombstone / Membership / Receipt 保留

关键 Durable State 不能“发过就删”：

- Tombstone 至少等 Hub ACK + consistency checkpoint；
- Shared Membership / Promotion provenance 按 State Contract 长期保留；
- active/frozen Stream Sequence Receipt 保留到可安全 retire；
- Nonce / Pair Offer 等短期状态按窗口 GC；
- Conditional Shared Alpha 不依赖永久 `ReplicaKey -> SharedKey` 主键 Alias。

Shared Group 无 active memberships 后可以 GC；Group Key 是确定性身份，因此以后若合法 assertion 再出现可以按同 Identity Algorithm 重建 Group，但不能借此恢复已删除的 origin row。

## 26. Hub 数据丢失

Canonical Replica 可从 Nodes 重建，但 Hub Identity/TLS Key、Node Registry/Public Keys、Pairing relationship、Stream/Cursor/Generation、Shared Membership provenance 等 Control Plane 需要独立恢复策略。

Hub Identity Key 丢失时不能因为 SQLite/endpoint 还在就假装是原 Hub。

## 27. Node 本地数据丢失

Hub 不是默认灾备工具。Alpha 不做 Hub -> Node Canonical restore；Hub 可能保留历史，新本机采集形成新的本地事实链。

## 28. Hub 地址 / TLS 变化

IP/hostname 变化不等于 Hub Identity 变化。公共 CA 仍需 hostname 验证；自管理 TLS 仍需 SPKI/Hub Identity。endpoint 相同但 Hub Proof 失败必须 blocked。

## 29. Pure / Headless Hub

Pure Hub 不启动 Source。Alpha 不内建 Remote Web Login；Headless 通过 SSH CLI、OS 远程会话或用户自建可信 loopback tunnel 管理，不把 Local Web 直接暴露网络。

## 30. Clock Skew 与跨机时间

serverTime/skew 是安全/diagnostic 状态，不进入 Canonical Observation。Hub 保留 origin occurredAt/capturedAt，不用 replicatedAt 改写，也不声称跨 Node 毫秒级因果全序。

## 31. Hub 资源压力

诊断 batch/entity too large、server busy、storage pressure。压力只影响同步，不影响 Node Local Capture；避免无限重试放大故障。

## 32. 双发行共存

nodeId、Hub Identity、Policy、History Boundary、Pairing Relationship、Stream/Generation、Shared Group/Membership 都属于共享默认数据根。npm/Desktop 切换 Daemon owner 不重新 Pair/Identity，也不生成第二套状态。

## 33. Alpha 运维验收

至少覆盖：

1. Standalone 开 Hub 后本机历史/Web 不变化；
2. 非法 Capability 拒绝；
3. Pure Hub 不启动 Source；
4. include-existing Bootstrap 可恢复；
5. from-now + dependency closure 正确；
6. Hub 离线 backlog 收敛；
7. Protocol 不兼容只阻塞同步；
8. Policy 放宽不无确认补旧正文；
9. Policy 收紧 ambiguous Batch 可安全 Rollover；
10. Reconcile 补 Fast Path 漏项；
11. staged Re-bootstrap 失败不影响 active；
12. G2 只切换该 Node memberships；
13. Re-pair 不重复 Replica；
14. Reset Identity 是新 Node；
15. Revocation 不删历史；
16. Delete History 只删除该 Node origin / memberships；
17. Hub endpoint 变化身份不变可恢复；
18. Hub Identity 丢失不会被 endpoint 掩盖；
19. Hub Local / Remote 同 Portable Project 进同 Group；
20. npm/Desktop 切 owner 不改变 relationship；
21. Replication Status / Clock / Error 不进入 Canonical Observation。

## 34. 当前非目标

HA/Federation、云账号、Remote Execution、Hub->Node restore、模糊跨 Node Identity、自动 Repository Rebind 历史迁移、内建 Remote Web 用户认证。
