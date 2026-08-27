# AgentLens 1.0 Hub 运维与生命周期

更新日期：2026-08-27  
状态：Alpha 运维设计，尚未实现  
相关文档：
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-PROTOCOL.md`
- `docs/1.0/HUB-PAIRING-SECURITY.md`

本文定义多机 Hub 在真实使用中的生命周期：启用、配对、Bootstrap、运行状态、断网恢复、重配对、撤销、删除、策略变化、升级、换机和故障恢复。本文描述目标语义，不表示 CLI / Web 已经实现。

## 1. 使用模型

Alpha 只支持单 Hub 星型拓扑：

```text
                 Hub
           +------+------+ 
           |      |      |
         Node A Node B Node C
```

每个 AgentLens 实例都有 Node Identity。产品形态只是能力组合：

```text
Standalone
  localCapture=true
  replicationUpstream=false
  hubAccept=false

普通接入节点
  localCapture=true
  replicationUpstream=true
  hubAccept=false

Hub
  localCapture=true
  replicationUpstream=false
  hubAccept=true

Pure Hub
  localCapture=false
  replicationUpstream=false
  hubAccept=true
```

Alpha 不支持：

- 一个 Node 同时连接两个 Hub；
- Hub 级联另一个 Hub；
- Hub Federation；
- Hub 反向管理 Node。

## 2. 启用 Hub

普通 Standalone 开启 `hubAccept` 后成为 Hub Capability 实例。

原则：

- 使用同一个 AgentLens Runtime / 数据根；
- 不安装第二套 Hub 程序；
- 不创建第二份本机 Canonical DB；
- 启用后需要重启 Daemon 可以接受；
- 本机 `surface-http` 继续 loopback；
- 新增独立 Replication HTTPS Surface；
- Hub 默认 `localCapture=true`，继续观察本机；
- 用户可显式关闭本机采集形成 Pure Hub。

首次启用 Hub 需要初始化：

```text
Hub Identity
TLS Material / user-provided TLS config
Node Registry
Replication Control Plane tables
```

初始化失败不得破坏已有 Standalone 本地采集。

## 3. Hub 本机也是一个 Node

Hub 机器自己的 Source 数据走普通 Local Canonical Pipeline：

```text
Hub Local Source
 -> Local Canonical Commit
 -> Hub Unified Store
```

不需要把本机数据通过 Replication Client 再“上传给自己”。

因此 Hub 本机数据和 Remote Replica 在 Projection 中统一查看，但 provenance 不同：

- Hub Local：本机 Canonical 事实；
- Remote：由某 origin Node 复制而来的 Replica / Shared Assertion。

## 4. 添加一台 Node

目标 UX：

```text
Hub: 添加设备
 -> 生成 Pairing Offer

Node: 连接 Hub
 -> 验证 Hub
 -> Pair
 -> Handshake
 -> Bootstrap
 -> Reconcile
 -> Synced
```

首次连接必须明确显示：

- Hub endpoint；
- Hub Identity / fingerprint；
- 当前 Replication Policy；
- 是否会补传历史数据。

不能把“输入配对码”理解成“默认上传整个本机数据库”。

## 5. Node Replication 状态

面向用户至少区分：

| 状态 | 含义 | 本地采集 |
| --- | --- | --- |
| 未连接 | 没有 upstream Hub | 正常 |
| 配对中 | 建立长期信任 | 正常 |
| 首次同步 | Bootstrap 历史数据 | 正常 |
| 校准中 | Reconciliation | 正常 |
| 已同步 | 当前无已知 backlog | 正常 |
| 延迟 | 有 backlog / 网络暂不可达 | 正常 |
| 已阻塞 | 协议 / 身份 / 冲突需人工处理 | 正常 |
| 已撤销 | Hub 拒绝后续同步 | 正常 |

Local-first 的用户体验原则：

> Hub 状态不能让用户误以为 AgentLens 本机也“挂了”。

例如网络断开应显示“Hub 同步延迟”，而不是全局红色“AgentLens 异常”。

## 6. Bootstrap 进度

Bootstrap 是可恢复收敛扫描，不是阻塞式“迁移数据库”。

UI / CLI 至少应该能报告：

```text
phase
entities scanned
entities acknowledged
bytes sent
current batch sequence
hub ack sequence
backlog estimate
last success at
```

避免只显示一个无法解释的百分比。

网络中断：

```text
Bootstrap
 -> disconnect
 -> local capture continues
 -> reconnect
 -> Handshake
 -> resume from Hub ACK
```

不得从零重新上传全部历史。

## 7. Incremental Backlog

Node 本地持续产生事实，Hub 暂不可达时形成 backlog。

要求：

- backlog 属于 Replication 运维状态，不进入 Canonical Observation；
- 不丢失本地 Canonical 数据；
- 网络恢复后自动继续；
- backlog 过大时提示磁盘 / 同步风险；
- 不为追赶 Hub 降低本机 Source / Canonical 正确性；
- Outbox / Reconciliation 数据可重建的部分不得成为第二事实源。

状态页建议至少显示：

```text
Hub endpoint
last connected
last ACK
pending batches / entities
oldest pending age
last reconciliation
last error code
```

## 8. Hub 离线 / Node 离线

### Hub 离线

Node：

- 本地采集继续；
- 本地 Web 继续；
- Replication 进入 degraded；
- 自动退避重连；
- 不弹无限重试噪音。

### Node 离线

Hub：

- 已同步历史仍可查询；
- Node 状态显示 lastSeen；
- 不把离线误解释为数据删除；
- 不从 Hub 反向探测 Node 端口。

## 9. 重试与退避

网络 / `SERVER_BUSY` 等 Retryable Error 使用有上限的指数退避 + jitter。

Alpha 原则：

- 秒级开始；
- 最长退避到分钟级；
- 成功一次后恢复正常节奏；
- `retryAfterMs` 存在时优先尊重 Hub 建议；
- 不可重试错误直接进入 blocked，不做高频死循环。

具体常数可以实现时调优，不写入架构事实。

## 10. 协议不兼容

例：

```text
Node supports R2
Hub only supports R1
```

行为：

```text
Replication -> blocked
Local Capture -> normal
Local DB -> normal
Local Web -> normal
```

用户提示应包含：

- Node AgentLens Version；
- Hub AgentLens Version；
- Node / Hub Protocol Range；
- 推荐操作（通常升级 Hub）。

不能自动丢字段降级来“假装成功”。

## 11. 推荐升级顺序

多机环境默认：

```text
1. upgrade Hub
2. verify Hub healthy / supports old protocol
3. upgrade Nodes gradually
4. observe backlog convergence
5. later retire obsolete protocol
```

Hub 升级后仍应在支持窗口兼容旧 Node，从而允许滚动升级，不要求所有机器同时停机。

AgentLens SemVer 与 Replication Protocol 不是一一绑定。

## 12. Replication Policy 变更

### 收紧

例如：

```text
full -> redacted
full -> metadata-only
```

只影响后续出站内容。

默认不自动删除 Hub 已存在的更完整历史，因为这属于数据清理 / Purge，不应由设置变化静默触发。

UI 必须明确说明：

> 收紧复制策略不会自动清除 Hub 既有历史。

### 放宽

例如：

```text
metadata-only -> redacted
redacted -> full
```

不允许无提示地把过去未授权上传的历史正文全部补传。

需要用户显式选择：

```text
仅从现在开始
或
补传符合新策略的历史数据
```

选择补传后执行受控 Bootstrap / Reconciliation。

## 13. Reconcile / Repair

必须提供明确的“校准同步状态”运维概念，但它不是“删库重来”。

目标：

```text
read Local Canonical State
 -> apply Replication Policy
 -> recompute entity hashes
 -> compare acknowledged replication state
 -> enqueue missing / changed entities
```

Repair 不允许：

- 修改原生 Agent 数据；
- 重跑 Source Parser 作为 Hub 修复手段；
- 根据 Hub 内容覆盖 Node Canonical；
- 通过缺失扫描推断删除。

如果需要彻底重新建立 Hub Replica，使用显式 Re-bootstrap，而不是把普通 Reconcile 做成破坏性操作。

## 14. Re-bootstrap

适用场景：

- Hub 端该 Node Replica 被显式清空；
- Control Plane 元数据损坏并完成恢复；
- 协议迁移明确要求重建 Replica；
- 用户显式要求重建。

Re-bootstrap：

- 不改变 nodeId；
- 不必重新 Pair，除非安全关系也失效；
- 创建明确的 Bootstrap Job / Epoch；
- 继续沿 active replication stream 或按协议要求新 stream；
- 目标是重建 Hub Replica，不修改 Node Canonical。

Alpha 实现时应避免把“重新配对”“重新同步”“重置 Node Identity”混成一个按钮。

## 15. Re-pair

重新 Pair 表示安全关系重建，不等于数据删除。

典型原因：

- Node 私钥丢失；
- Hub 撤销后用户重新授权；
- upstream Hub 被用户明确更换；
- Hub Identity 发生需要人工确认的变化。

默认行为：

```text
old stream -> freeze
new pairing -> new replicationStreamId
existing Hub replica -> keep
new stream -> handshake / reconcile / bootstrap as required
```

Hub 必须避免新 stream 与旧 stream 对同一 Node 数据产生两套重复 Replica Identity；Replica Key 仍由稳定 nodeId + originEntityId 决定。

如果 nodeId 也 Reset，则视为新 Node，是否关联旧历史需要独立显式管理，不自动猜。

## 16. Node Identity Reset

用于：

- 克隆数据目录后让副本成为新 Node；
- 用户明确把当前实例视为新设备；
- 身份冲突修复。

Reset 必须：

- 生成新 nodeId；
- 生成新 Node Key；
- 清除 upstream pairing / stream；
- 保留本机 Canonical 数据；
- 不修改现有 Canonical 主键；
- 要连接 Hub 必须重新 Pair。

重要：旧本机 Canonical 数据随后作为“新 Node 的历史”同步时，会产生新的 Replica Namespace。这是显式 Reset 的预期结果，不能静默发生。

## 17. 撤销 Node

Hub 撤销：

```text
active Node
 -> revoked
 -> stream frozen
 -> future replication rejected
```

默认保留：

- 已同步 Observation；
- Evidence；
- Session；
- Shared Assertions / provenance（状态按撤销语义处理）；
- 历史查询能力。

撤销后是否把该 Node 的 Shared Assertion 视为 active，需要产品语义明确。Alpha 建议：

> 撤销连接不自动撤回历史 Shared Assertion；只有显式删除 / Purge Node 历史时才撤回。

这样“撤销凭据”不会改变历史事实图。

## 18. 删除 Node 历史

这是高风险显式操作，与 Revocation 分开。

概念步骤：

```text
preview impact
 -> show node-scoped entity counts
 -> show shared assertions affected
 -> confirm
 -> delete node-scoped replica in dependency-safe order
 -> withdraw this Node shared assertions
 -> recompute shared merges
 -> GC only unreferenced shared entities
```

必须支持预演 / 影响摘要，不能一键把 Shared Project 误删。

## 19. Hub 数据丢失

如果 Hub DB 丢失但各 Node 正常：

```text
Hub rebuild
 -> restore Hub Identity if available
 -> restore pairing control plane if available
 -> Nodes reconnect
 -> Re-bootstrap / Reconcile
```

Canonical 事实仍在各 Node，因此 Hub Replica 理论上可重建。

但以下信息可能需要单独恢复：

- Hub Identity / TLS Key；
- Node Registry / Pairing trust；
- Shared Assertions provenance；
- Replication Cursor / stream metadata。

因此 Hub 运维备份应把“Canonical Replica 可重建”与“安全 / Control Plane 状态需要备份”区分开。

如果 Hub Identity 丢失，即使数据库恢复，也不能假装仍是原 Hub；按安全文档要求重新确认 / Pair。

## 20. Node 本地数据丢失

Hub 是 Replica + Aggregator，不应默认宣传成 Node 灾备恢复工具。

如果 Node 本地 Canonical DB 丢失：

- Hub 仍可能保留历史 Replica；
- Alpha 不提供 Hub -> Node 反向恢复 Canonical DB；
- 新本机采集会形成新的本地事实链；
- 是否支持从 Hub 导出历史属于独立 Backup / Export 能力，不属于 Replication Protocol。

避免让用户误以为“有 Hub 就等于完成备份”。

## 21. Hub 地址变化

Hub IP / hostname 变化不等于 Hub Identity 变化。

只要：

- Hub Identity 不变；
- TLS 验证 / Pinning 仍满足安全规则；
- 用户更新 endpoint；

Node 可以继续使用原 pairing relationship / stream。

Endpoint 是连接信息，不是身份。

## 22. Pure Hub

Pure Hub：

```text
localCapture=false
hubAccept=true
```

仍然拥有：

- Hub Identity；
- Replication Surface；
- Unified Canonical Store；
- Projection；
- Local Web；
- Node Registry。

不启动本机 Source Detection / History / Runtime / Asset Discovery。

切回 `localCapture=true` 后，本机正常作为一个 Node Source 加入同一个 Unified Store，不创建第二份 Hub 数据库。

## 23. 状态与诊断不进入 Canonical Observation

以下事实属于运维控制面：

```text
Hub online/offline
last ack
backlog
pairing state
stream state
protocol version
retry count
last network error
clock skew
TLS status
```

这些不能生成“Agent 行为 Observation”。

Web 可以展示，但必须通过独立 Runtime / Replication Status DTO。

## 24. Alpha 运维验收场景

至少覆盖：

1. Standalone 开启 Hub 后，本机历史 / Web 不变化；
2. Pure Hub 不启动任何 Source；
3. 已用三个月的 Node 首次 Pair 后能 Bootstrap 历史；
4. Bootstrap 中断后可恢复；
5. Hub 离线一小时，Node 继续采集，恢复后追平；
6. Node 离线时 Hub 仍能查看历史；
7. 协议不兼容只显示同步阻塞，本机正常；
8. `metadata-only -> full` 不会无确认自动补传旧正文；
9. `full -> metadata-only` 不会静默宣称已删除 Hub 旧正文；
10. Reconcile 能补上 Fast Path 漏掉的实体；
11. Re-pair 不重复创建 Replica；
12. Node Identity Reset 后必须作为新 Node 重新配对；
13. Revocation 不删除历史；
14. 删除 Node 历史会正确撤回该 Node Shared Assertions，但不误删其他 Node 仍使用的 Shared Entity；
15. Hub endpoint 改变但 Hub Identity 未变时可继续连接；
16. Hub Canonical Replica 丢失后可从 Nodes 重建；
17. Hub Identity 丢失不会被 endpoint 相同掩盖；
18. 所有 Replication Status / Errors 都不进入 Canonical Observation。

## 25. 当前非目标

Alpha 运维不包含：

- Hub 自动选主 / HA；
- 多 Hub 故障切换；
- 云端账号；
- Node 远程执行；
- Hub -> Node Canonical 恢复；
- 自动跨 Node 身份推断；
- 自动 Repository Rebind 历史迁移。
