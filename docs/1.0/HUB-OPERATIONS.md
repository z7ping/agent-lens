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

本文定义多机 Hub 在真实使用中的生命周期：启用、配对、History Scope、Bootstrap、运行状态、断网恢复、Policy 变更、Stream Rollover、Re-bootstrap、撤销、删除、升级、换机和故障恢复。本文描述目标语义，不表示 CLI / Web 已经实现。

## 1. 使用模型

Alpha 只支持单 Hub 星型拓扑：

```text
                 Hub
           +------+------+ 
           |      |      |
         Node A Node B Node C
```

合法能力 Profile：

| Profile | localCapture | replicationUpstream | hubAccept |
| --- | --- | --- | --- |
| Standalone | true | false | false |
| 普通接入节点 | true | true | false |
| Hub | true | false | true |
| Pure Hub | false | false | true |

Alpha 不允许：

- `hubAccept=true && replicationUpstream=true`；
- 一个 Node 同时连接两个 Hub；
- Hub 级联 / Federation；
- `localCapture=false && replicationUpstream=true` 的纯转发节点；
- Hub 反向管理 Node。

## 2. 启用 Hub

Standalone 开启 `hubAccept` 后成为 Hub Capability 实例。

原则：

- 同一个 AgentLens Runtime / 数据根；
- 不安装第二套 Hub 程序；
- 不创建第二份本机 Canonical DB；
- 能力配置改变后允许重启 Daemon；
- 本机 `surface-http` 继续 loopback；
- 新增独立 Replication HTTPS Surface；
- Hub 默认 `localCapture=true`；
- 用户可关闭本机采集形成 Pure Hub。

首次启用 Hub 初始化：

```text
Hub Identity
TLS Material / user-provided TLS config
Node Registry
Replication Control Plane
```

初始化失败不得破坏已有 Standalone 本地采集；应报告“Hub Capability 启动失败”，不是全局 AgentLens 故障。

## 3. 从“连接 Hub”切换为“作为 Hub”

Alpha 不允许一个实例同时成为 upstream client 和 downstream Hub。

切换必须：

```text
freeze / disconnect current upstream relationship
 -> verify local replication state retained
 -> set replicationUpstream=false
 -> set hubAccept=true
 -> restart runtime
```

不得通过同时打开两个能力形成隐藏级联 Hub。

## 4. Hub 本机也是一个 Node

Hub 本机 Source：

```text
Local Source
 -> Local Canonical Commit
 -> Hub Unified Store
```

不通过 HTTPS 自我上传。

本机 `nodeId` 仍参与：

- provenance；
- Shared Project / Asset Identity assertion / membership；
- 跨设备 UI 的“本机”标识。

同一 Portable Project 在 Hub 本机与远程 Node 都存在时，应聚合为同一 Shared Project 视图，但保留各自 Workspace / origin provenance。

## 5. 添加一台 Node

目标流程：

```text
Hub: 添加设备
 -> Pairing Offer

Node:
 -> verify TLS / Hub identity
 -> choose Replication Policy
 -> choose History Scope
 -> Pair
 -> verify Pairing Receipt
 -> Handshake / serverProof
 -> Bootstrap or baseline
 -> Reconcile
 -> Synced
```

首次连接必须明确显示：

- Hub endpoint / identity；
- Replication Policy；
- History Scope；
- 是否补传已有历史。

## 6. Replication Policy 与 History Scope

两个设置必须分开：

```text
Policy
  metadata-only | redacted | full

History Scope
  from-now | include-existing
```

### include-existing

当前允许复制的既有历史进入 Bootstrap。

### from-now

不执行普通旧事实历史补传，但为了之后的新 Observation，允许发送合法 FK / Identity Dependency Closure。

`from-now` 是持久 Replication Boundary，不是简单的 UI 文案，也不只靠 `occurredAt >= pairingTime`。

Reconciliation 必须继续尊重它。

## 7. Node Replication 状态

用户至少看到：

| 状态 | 含义 | 本机采集 |
| --- | --- | --- |
| 未连接 | 无 upstream | 正常 |
| 配对中 | 建立信任 | 正常 |
| 首次同步 | Bootstrap | 正常 |
| 校准中 | Reconciliation | 正常 |
| 已同步 | 无已知 backlog | 正常 |
| 同步延迟 | 网络 / backlog | 正常 |
| 已暂停 | 用户 / Policy 安全暂停 | 正常 |
| 需要处理 | 协议 / 身份 / 冲突 | 正常 |
| 已撤销 | Hub 拒绝后续上传 | 正常 |

Hub 状态不能让用户误以为本机 AgentLens 也挂了。

## 8. Bootstrap 进度

Bootstrap 是可恢复收敛扫描，不是数据库迁移。

状态至少报告：

```text
phase
history mode
policy / revision
entities scanned
entities acknowledged
bytes sent
current sequence
hub ACK
backlog estimate
last success
```

网络中断后：

```text
local capture continues
 -> reconnect
 -> handshake
 -> resume from Hub ACK
```

完成后必须 Reconcile。

## 9. `from-now` 的首次连接

选择“从现在开始”时不能简单跳过 Bootstrap 然后什么依赖都不建。

Node 需要建立持久 History Boundary / baseline，并允许之后按需发送：

```text
Host / Installation
Project / Workspace
Session / SourceSession
Actor
Asset identity / binding
```

以支撑 Boundary 之后新事实。

但不能因此补传 Boundary 之前的全部 Prompt / Tool / Observation。

## 10. Incremental Backlog

Hub 不可达时 backlog：

- 属于 Replication 运维状态；
- 不进入 Canonical Observation；
- 不丢 Local Canonical；
- 网络恢复自动继续；
- backlog 过大提示磁盘 / 同步风险；
- 不为追赶 Hub 降低本机 Source / Canonical 正确性。

状态建议：

```text
Hub endpoint
last connected
last ACK
pending batches / entities
oldest pending age
last reconciliation
last error code
policy / history revision
```

## 11. Hub 离线 / Node 离线

### Hub 离线

Node 本地采集 / Web 正常，Replication degraded，指数退避重连。

### Node 离线

Hub 已同步历史仍可查询；显示 lastSeen；不把 offline 当删除；不反向探测 Node 端口。

## 12. 重试与退避

Retryable Error 使用有上限指数退避 + jitter。

原则：

- 秒级开始，最长分钟级；
- `retryAfterMs` 优先；
- 成功后恢复正常节奏；
- non-retryable 进入 blocked / paused，不高频死循环。

## 13. Commit Ambiguity

最危险的网络场景：

```text
Hub transaction committed
 -> ACK response lost
```

Node 不知道是否提交时必须：

```text
resend exact same immutable batch
or query Hub ACK
```

不能拿同 sequence 重新组织另一批数据。

如果 Hub 明确返回 `committed=false`，才允许按 Protocol 修正 expected sequence 内容。

## 14. Policy 收紧

例如：

```text
full -> metadata-only
```

保存设置后：

- 立即停止生成新的旧 Policy 请求；
- 未序列化 pending state 按新 Policy 处理；
- 已 ACK 历史不会自动从 Hub 删除；
- 已明确未提交 Batch 可按新 Policy 重建；
- 对 ambiguous old-policy Batch，不能为了填 sequence gap 继续发送已经被用户禁止的正文。

最后一种情况：

```text
pause old stream
 -> authenticated stream rollover
 -> new stream
 -> reconcile under new policy
```

这是隐私边界，不允许等网络恢复后继续发旧 full 内容才生效。

## 15. Policy 放宽

例如：

```text
metadata-only -> full
```

用户选择：

```text
仅未来
或
补传已有历史
```

前者只改变 Policy Revision；后者同时扩大 History Revision，并触发受控 Bootstrap / Reconciliation。

## 16. Stream Rollover

Rollover 不等于 Re-pair：

```text
nodeId unchanged
hubId unchanged
Node Key unchanged
old stream frozen
new stream sequence=1
existing Replica Generation kept
```

适用：

- Policy 收紧遇到 ambiguous old-policy Batch；
- sequence / receipt 恢复需要新的顺序命名空间；
- 明确协议恢复操作。

新 stream 通过 Reconciliation 与 existing Replica 收敛。

## 17. 协议不兼容

只阻塞 Replication：

```text
Local Capture -> normal
Local DB -> normal
Local Web -> normal
Replication -> blocked
```

提示 Node / Hub AgentLens Version、Protocol Range 与推荐升级动作。

不允许丢字段降级假装成功。

## 18. 推荐升级顺序

```text
1. upgrade Hub
2. verify old protocol support
3. upgrade Nodes gradually
4. observe backlog convergence
5. later retire obsolete protocol
```

## 19. Reconcile / Repair

Reconcile：

```text
Local Canonical
 -> History Boundary
 -> Replication Policy
 -> entity hash
 -> acknowledged state
 -> repair missing / changed pending
```

不允许：

- 修改原生 Agent 数据；
- 重跑 Source Parser 作为 Hub 修复；
- Hub 覆盖 Node Canonical；
- 普通 absence 推断删除。

## 20. Re-bootstrap 与 Replica Generation

需要彻底重建 Hub Replica 时使用 staged Generation：

```text
G1 active
 -> build G2 staged
 -> G2 bootstrap
 -> G2 mandatory reconcile
 -> validate complete
 -> atomically activate G2
 -> retire G1
```

要求：

- 不改变 nodeId；
- 不必 Re-pair，除非安全关系也失效；
- G2 未完成时 G1 继续可查；
- G2 失败不污染 G1；
- Local Capture 持续；
- 只有完整 Generation 激活时，absence 才能用于清理旧 Generation stale replica；
- Shared Assertion 集也按新 Generation 重算。

不要把 Re-bootstrap、Re-pair、Reset Identity 混成一个按钮。

## 21. Re-pair

Re-pair 表示安全关系重建。

```text
old stream freeze
 -> explicit pairing
 -> new stream
 -> existing Replica Generation keep when safe
 -> reconcile / bootstrap as Hub requests
```

如果 nodeId 未变，ReplicaKey 仍稳定，不应重复创建同一 Node 数据。

## 22. Node Identity Reset

Reset：

- 新 nodeId；
- 新 Node Key；
- 清 upstream pairing / stream；
- 保留 Local Canonical；
- 不改现有 Canonical Primary Key；
- 重新连接必须 Pair。

同步到同一 Hub 时会进入新 Replica Namespace；UI 必须提示可能与旧 Node 历史同时存在，避免用户把 Reset 当普通“修复同步”。

## 23. 撤销 Node

```text
active Node
 -> revoked
 -> active stream frozen
 -> future replication rejected
```

默认保留历史与 Shared Assertion provenance。

Alpha：撤销凭据不自动撤回历史 Shared Assertion；只有显式 Delete / Purge Node History 才改变历史聚合图。

## 24. 删除 Node 历史

高风险显式操作：

```text
preview
 -> node-scoped counts
 -> shared assertion impact
 -> confirm
 -> dependency-safe delete
 -> withdraw assertions
 -> recompute shared groups
 -> GC only safe unreferenced state
```

不能与 Revocation 合并。

## 25. Tombstone / Alias / Receipt 保留

关键 Durable State 不能“发过就删”：

- Tombstone 至少等 Hub ACK + 后续一致性校准后再 GC；
- Permanent Alias 不因旧 row 删除立即清理；
- active / frozen Stream 的 Sequence Receipt 需保留到明确 retired；
- Nonce / Pair Offer 等短期状态可以按窗口 GC。

完整规则见 State Contract。

## 26. Hub 数据丢失

Hub Replica 理论上可以从 Nodes 重建，但 Security / Control Plane 不能假装全部可重建。

需要区分：

```text
Canonical Replica
Hub Identity / TLS Key
Node Registry / Public Keys
Pairing Receipts / relationships
Stream / Cursor / Generation metadata
Shared Assertions provenance
```

如果只恢复 Hub SQLite 但 Hub Identity Key 丢失，不能声称仍是原可信 Hub。

Control Plane 状态不一致时优先 freeze + Reconcile / Re-bootstrap，不得盲目降低 ACK 导致 sequence 复用。

## 27. Node 本地数据丢失

Hub 不是默认灾备恢复工具。

Node DB 丢失后：

- Hub 可能仍有历史；
- Alpha 不做 Hub -> Node Canonical restore；
- 新采集形成新的本地事实链；
- 从 Hub 导出历史属于独立 Backup / Export 能力。

## 28. Hub 地址 / TLS 变化

IP / hostname 变化不等于 Hub Identity 变化。

自管理 TLS：验证 Hub Identity + pinned SPKI。

公共 CA：还必须满足新 hostname 的证书验证。

Endpoint 相同但 Hub Identity Proof 失败，必须 blocked。

## 29. Pure Hub / Headless Hub

Pure Hub：

```text
localCapture=false
hubAccept=true
```

拥有 Replication Surface、Unified Store、Projection、Local Web、Node Registry。

不启动 Source。

Alpha 没有内建 Remote Web 登录。Headless Linux / NAS 管理方式：

- SSH 后使用本机 CLI；
- OS 远程会话；
- 用户自己建立可信 tunnel 访问 loopback Web。

AgentLens 不因此把无认证 Local Web 监听到网络。

## 30. Clock Skew 与跨机时间

状态 / Diagnostics 可以记录：

```text
clock skew estimate
server time
last security timestamp error
```

这些不进入 Canonical Observation。

跨 Node UI 保留 origin `occurredAt / capturedAt`，不使用 `replicatedAt` 改写事件时间，也不声称毫秒级精确跨机因果顺序。

## 31. Hub 资源压力

Hub 至少诊断：

```text
batch too large
entity too large
server busy
disk / storage pressure
```

出现资源压力：

- Node Replication degraded / paused；
- Node Local Capture 正常；
- 不无限重试导致更大压力；
- 用户得到明确释放磁盘 / 调整容量提示。

## 32. 双发行共存

Node / Hub Identity、Policy、History Boundary、Pairing Relationship、Stream / Generation State 都属于共享默认数据根。

npm / Desktop 切换当次 Daemon owner：

- 不改变 nodeId；
- 不重新 Pair；
- 不生成第二套 Hub Identity；
- 不重置 Stream / History Boundary。

卸载其中一种发行方式也不能删除另一方仍需要的这些共享状态。

## 33. Alpha 运维验收

至少覆盖：

1. Standalone 开 Hub 后本机历史 / Web 不变化；
2. 非法 Capability 组合被拒绝；
3. Pure Hub 不启动 Source；
4. include-existing Bootstrap 可恢复；
5. from-now 不被 Reconcile 绕过，且新事实 dependency closure 合法；
6. Hub 离线一小时后 backlog 收敛；
7. 协议不兼容只阻塞同步；
8. metadata-only -> full 不会无确认补旧正文；
9. full -> metadata-only 对 ambiguous Batch 安全暂停并可 Rollover；
10. Reconcile 能补 Fast Path 漏项；
11. staged Re-bootstrap 失败不影响 active Replica；
12. Re-pair 不重复 Replica；
13. Reset Identity 作为新 Node；
14. Revocation 不删除历史；
15. Delete History 正确处理 Shared Assertions；
16. Hub endpoint 变化且 Hub Identity 不变可恢复；
17. Hub Identity 丢失不会被 endpoint 相同掩盖；
18. Hub 本机 / Remote 同 Portable Project 可聚合；
19. npm / Desktop 切换 owner 不改变 Hub relationship；
20. 所有 Replication Status / Clock / Errors 都不进入 Canonical Observation。

## 34. 当前非目标

Alpha 运维不包含：

- Hub 自动选主 / HA；
- 多 Hub 故障切换；
- 云端账号；
- Node Remote Execution；
- Hub -> Node Canonical restore；
- 自动跨 Node 模糊身份推断；
- 自动 Repository Rebind 历史迁移；
- 内建 Remote Web 用户认证。
