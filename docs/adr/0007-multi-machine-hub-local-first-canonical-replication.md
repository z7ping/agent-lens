# ADR-0007：多机 Hub、Local-first 与 Canonical Replication

状态：Accepted（2026-08-27 复核修订）  
日期：2026-08-27  
范围：AgentLens 1.0 Alpha / Hub / Node Identity / Replication / Security / Protocol / Storage

## 背景

AgentLens 1.0 当前是本地优先的 AI 编码 Agent 可观测工具：每台机器独立完成 Source 采集、Canonical Pipeline、SQLite 持久化、Projection 与 Web / Desktop 展示。多机能力的目标，是让多台 Windows / macOS / Linux 机器的数据可以在一个 Hub 中统一查看与聚合分析，同时不破坏 Local-first、Canonical Observation、Evidence、Cordis Runtime、Projection 和双发行边界。

本 ADR 首次接受后又进行了实现前复核。复核确认主方向不变，但修正了四个容易导致返工的点：

1. `Node` 是 AgentLens 实例身份，不是与 `Hub` 互斥的底层 Runtime Role；
2. 当前本机 Canonical ID 并不保证跨机器全局唯一，因此不能直接把本机 ID 当 Hub 全局主键；
3. Shared Canonical Entity 需要字段级确定性 Merge，不能要求整实体字节级一致；
4. Durable Outbox 不能只依赖 Cordis Event，还必须能通过 Canonical Reconciliation 查漏补缺。

因此，本 ADR 定义 1.0 Alpha Hub 的长期架构边界。Alpha 可以分阶段实现，但实现不得绕开这些边界。

## 决策

### 1. 每个 AgentLens 实例都是 Node；Standalone / Hub 是能力组合，不是四套 Runtime

`Node` 表示一个持久的 AgentLens 实例身份。每个运行中的 AgentLens 都有 `nodeId`，无论它是否连接 Hub、是否接受其他 Node 的复制。

底层通过能力组合形成不同产品形态：

```text
AgentLens Node
  localCapture        true | false
  replicationUpstream true | false
  hubAccept           true | false
```

常见组合：

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

产品 / CLI 可以继续使用 `standalone`、`node`、`hub`、`pure-hub` 作为便捷 Profile，但 Core / Runtime 不把它们实现成互斥的四套程序或四套领域模型。

Alpha 允许修改能力配置后重启 Daemon，不要求运行中热切换 Cordis Plugin。

### 2. Hub 是可选的 Local-first 聚合层

每个启用本机采集的 Node 必须始终能够独立完成：

```text
Native Source
  -> Normalize
  -> Identity
  -> Canonical Observation / Evidence
  -> Local Storage
  -> Local Projection / Web
```

Hub 不在线、网络中断、配对失效、证书失败或协议不兼容，都不得阻塞 Node 本地采集、查询和持久化。

Hub 不成为 AgentLens 的启动前置条件，也不成为唯一事实库。

### 3. Hub 是 Canonical Replica + Aggregator，不是第二个 Source Parser

Node 完成本机 Source 解释与 Canonical Commit 后，再把允许复制的规范实体状态同步给 Hub：

```text
Node Native Source
  -> Node Canonical Pipeline
  -> Node Canonical Store
  -> Replication Policy
  -> Replication
  -> Hub Canonical Replica
  -> Hub Projection
  -> Unified Web
```

Hub 不重新读取 Claude / Codex / Pi / Hermes / OpenCode 原生数据，也不重新运行各 Source Parser / Normalizer。

Hub Remote Ingest 也不重新调用普通 `ObservationService.commit()` 来“猜”远程事实；它通过专门的 Replication Import 边界校验并导入已经形成的 Canonical Entity State。

### 4. 同步正式 Wire DTO，不同步 SQLite 文件、SQLite Row 或 Projection

Replication 使用独立版本化 Wire DTO。至少需要覆盖形成完整事实图所需的 Canonical Entity State，例如：

- Host；
- AgentProduct / AgentInstallation；
- RuntimeProfile；
- Project / Workspace；
- LogicalSession / SourceSession / SessionRelationship；
- AgentActor；
- SourceRecord；
- CanonicalObservation；
- Evidence / ObservationEvidence；
- Coverage / Capability；
- AssetDefinition / AssetBinding / AssetStateObservation；
- ToolDefinition。

禁止：

- rsync / 复制 `agent-lens.db`；
- 直接把 SQLite Row 定义成网络协议；
- 同步 Session Summary / Usage / Overview 等 Projection 作为事实源；
- 让 Hub 因远程同步重新依赖具体 Source Parser。

### 5. 本机 Canonical ID 与跨机 Replica Key 分离

当前 1.0 `Host.id` 由 `hostname + platform + arch` 稳定哈希生成，Installation / Workspace 等多个 ID 又继续依赖 Host ID。该算法适合单机稳定识别，但不能证明跨机器全局唯一。

因此，本 ADR **不再要求 Node 本机 Canonical ID 直接成为 Hub 全局主键**，也不为了 Hub 立即强制迁移整套本机 Canonical ID。

Replication 为机器作用域实体定义确定性的跨机 Replica Key：

```text
ReplicaKey = stable(nodeId, entityType, localEntityId)
```

Wire DTO 同时保留：

```text
originNodeId
originEntityId
replicaKey
```

Hub 使用 `replicaKey` 作为机器作用域实体的全局复制身份，并保存 `originEntityId` 供诊断、追溯和本机 / Hub 对账。

这不是 Hub 重新运行 IdentityService，也不是按内容重新推断事实；它只是 Replication Namespace 的确定性映射。同一 `nodeId + entityType + originEntityId` 永远得到同一个 Replica Key。

Project、AgentProduct、AssetDefinition 等跨 Node 共享实体不机械套 Node Namespace，而由各自稳定的 Shared Identity / Merge Contract 汇聚。

如果未来要把本机 Host / Canonical Identity 本身迁移为真正全局身份，必须单独进行 Contract Review / Migration，不由 Hub 功能顺手改写既有数据库。

### 6. `nodeId` 使用持久 UUID；Host Identity 暂不与 Node Identity 合并

每个 AgentLens 数据根首次初始化生成持久 `nodeId`，使用随机 UUID，并长期保留：

```text
~/.agent-lens/1.0/node.json
```

`nodeId` 表示 AgentLens 实例 / 数据根身份；hostname、platform、arch 只是可变元数据。

`Host` 继续表示 Canonical Domain 中被观察机器的身份。当前 Host ID 算法暂不因 Hub 强制改成 UUID，避免未经迁移设计就重写既有 Installation / Workspace / Session / Observation 引用链。

一个 `nodeId` 不得被两台同时活跃的机器共享。复制整个数据根导致两个实例携带同一 Node Identity 时，Hub 必须将并发身份冲突视为安全 / 运维异常并拒绝静默合并。后续应提供显式 Node Identity Reset / Re-pair 能力。

### 7. Alpha 固定单 Hub 星型拓扑

1.0 Alpha 的 Replication 拓扑明确限定为：

```text
              Hub
        +------+------+ 
        |      |      |
      Node A Node B Node C
```

约束：

- 一个 Node 最多配置一个 upstream Hub；
- Hub 不向另一个 Hub 复制 Hub 中的远程副本；
- 不支持 Hub Federation；
- 不支持一个 Node 同时向多个 Hub 同步；
- 不支持级联 Hub 或循环 Replication。

未来若需要 Hub Federation，必须作为独立架构决策设计 ownership、loop prevention、delete propagation 与冲突语义。

### 8. Hub 使用统一 Canonical Store，不按 Node 分数据库

Hub 的多个 Node 数据进入同一个 Repository / Storage：

```text
Hub Store
  hosts / installations / sessions / observations / evidence / assets / ...
  replication metadata
```

不采用 `node-a.db / node-b.db / node-c.db`。否则 Projection、统一排序、分页和聚合会重新退化为 Storage 层联邦查询。

Alpha 继续使用 SQLite；是否未来增加 `storage-postgres` 由真实规模与性能基线决定。

### 9. Canonical Layer 与 Replication Control Plane 分离

不在所有 Canonical 表上机械增加 `node_id`。

Replication 自己维护控制面，例如：

```text
nodes
replication_cursors
replication_entity_sources
replication_conflicts
replication_tombstones
```

这些信息描述“谁复制了什么、同步到哪里、是否冲突”，不属于被观察 Agent 的行为事实，不进入 Canonical Observation。

机器作用域实体通过 Replica Key / origin metadata 确定来源；Shared Entity 则通过各自 Shared Identity Contract 汇聚。

### 10. Shared Canonical 使用字段级确定性 Merge，不采用整实体相等或 last-write-wins

共享实体不能简单规定“同 ID 内容必须完全一致”。例如同一个 Project 在不同 Node 上可能拥有不同 `lastSeenAt`，这属于合法并发观察，不是冲突。

每一种 Shared Entity 必须定义稳定的 Merge Contract，把字段分为：

1. **Identity Fields**：决定“是不是同一个实体”，不允许互相矛盾；
2. **Mergeable Metadata**：允许使用明确的确定性规则合并；
3. **Node-local Metadata**：不应写入 Shared Entity，保留在来源 / Control Plane；
4. **Conflict Fields**：无法安全合并时进入 Replication Conflict。

允许的确定性规则示例：

```text
createdAt   -> min()
lastSeenAt  -> max()
集合字段     -> stable union
可空展示名   -> 一致优先；冲突则 diagnostics，不按到达顺序覆盖
```

禁止通用 `last-write-wins`。Merge 结果必须与 Batch 到达顺序无关。

### 11. Replication Batch 必须事务性、幂等

Node 使用 Bootstrap / Durable Outbox / Cursor 按 Batch 上传。Hub 对单个 Batch 执行完整校验和事务写入：

```text
BEGIN
  validate node
  validate protocol
  validate signature
  validate ownership / references
  map replica keys
  merge / upsert canonical entities
  update replication metadata
COMMIT
ACK sequence
```

任何一步失败都回滚整个 Batch，不推进 ACK。重复发送同一 Batch 不得制造重复事实。

Alpha 同步 Entity State / Tombstone，不把 AgentLens 改造成 Event Sourcing 系统。

### 12. Durable Outbox 不以 Cordis Event 作为唯一事实来源

`observation/committed`、Asset 变化等 Cordis Event 可以用于低延迟触发 Replication，但 Event 不是 Durable Replication Fact。

必须允许以下失败窗口：

```text
Canonical COMMIT 成功
  -> 进程在写 Outbox 前崩溃
```

因此 Replication 采用：

```text
Cordis Event
  -> fast path enqueue

Canonical Store
  -> reconciliation / content hash scan
  -> repair missing outbox entries
```

目标语义是：

```text
at-least-once delivery
+ idempotent import
+ reconciliation
```

而不是为 Hub 引入复杂的分布式 Exactly-once / Event Sourcing。

Upsert Outbox 可以由 Canonical State + Cursor / Entity Hash 重新校准；删除则必须依赖持久 Tombstone，不能靠“扫描不到了”推断删除。

### 13. 第一次接入必须有 Bootstrap Sync

已有 AgentLens 使用者在启用 Hub 时，不能只同步启用之后的新事件。

Replication 生命周期明确分为：

```text
Pair
  -> Bootstrap Sync
  -> Bootstrap Complete
  -> Incremental Sync
```

Bootstrap 从本地 Canonical Store 读取当前允许复制的 Entity State，分批上传，并具备 Cursor / Resume 能力；网络中断后不得从零开始。

Bootstrap 与 Incremental 使用同一 Wire Contract、同一幂等导入和同一 Replication Policy，不维护两套事实语义。

### 14. Capture Policy 与 Replication Policy 分离

`CapturePolicy` 回答：

> 哪些来源 / 内容允许进入本机 Canonical Store？

`ReplicationPolicy` 回答：

> 已经存在于本机 Canonical Store 的哪些内容允许离开本机并进入 Hub？

两者必须分离：

```text
Native Source
  -> Capture Policy
  -> Local Canonical Store
  -> Replication Policy
  -> Hub
```

Replication Policy 永远不能比本机已经采集到的数据更“完整”。如果本机 Capture 为 `off` / `redacted`，Replication 无法也不得恢复被丢弃 / 脱敏的内容。

Alpha 至少定义三档复制范围：

```text
metadata-only
redacted
full
```

其中：

- `metadata-only` 只复制形成 Session / Tool / Agent / Usage / Identity / Evidence 结构所需的最小元数据，不发送 Prompt / Tool 正文；
- `redacted` 在出站 Wire DTO 上再次执行 Hub 复制脱敏；
- `full` 允许复制本机已经持久化的普通业务正文，但明确凭据保护仍不可关闭。

如果 Replication Policy 删除了某些字段，Wire DTO 必须显式表达 `omitted / redacted`，不能让 Hub 把“未复制”误解释成“原始事实为空”。

Hub 功能启用不能默认突破本机数据边界；首次配对必须明确展示当前 Replication Policy。

### 15. Node-scoped ownership 与 Shared Merge 分离

机器作用域 Replica Entity 的 ownership 由 `originNodeId` 决定。另一个 Node 不得修改该 Replica Key。

Shared Entity 由 Shared Identity + Merge Contract 汇聚，不属于某一个 Node 独占。

任何 ownership、identity 或不可合并字段冲突都记录为 Replication Conflict 并拒绝静默覆盖。冲突属于 Diagnostics / Operations，不进入 Agent 行为 Observation。

### 16. 删除语义与连接撤销分离

Hub 是副本，不是隐式备份系统。长期目标支持显式 Tombstone / Delete Replication。

删除必须由 Node 产生持久 Tombstone，并通过同一协议传播；Hub 不能仅根据一次 Bootstrap / Scan 中“没看到某实体”就推断删除。

撤销 Node 连接只阻止后续 Replication，默认保留 Hub 中已同步历史；删除历史数据是独立显式操作。

### 17. Node 永远主动连接 Hub，Hub 不反向访问 Node

网络拓扑固定为：

```text
Node
  -> outbound HTTPS
  -> Hub Replication Surface
```

Node 不为 Hub 开放监听端口，不要求固定 IP、端口转发或公网地址。Hub 不通过该架构获得远程执行 Node 命令的能力。

### 18. Local HTTP Surface 与 Replication Surface 完全分离

现有 Web / `/api/v1/*` 继续保持 loopback：

```text
surface-http
  -> 127.0.0.1:56789
```

Hub 新增独立网络入口：

```text
surface-replication
  -> HTTPS
  -> pairing / handshake / bootstrap / batch ingest / ACK
```

禁止为了 Hub 直接把现有无认证 HTTP Surface改为 `0.0.0.0`。

Alpha Hub Web 默认仍只在 Hub 本机访问。远程 Web 登录、账号、Cookie、CSRF、RBAC 等属于独立能力，不由 Replication Surface 顺带承担。

### 19. Pairing 与长期认证分离

首次配对使用短期、一次性 Pairing Secret，仅用于授权一个 Node Identity。成功后立即失效。

长期身份使用 Node 非对称密钥对，优先 Ed25519：

- Node Private Key 只保留在 Node；
- Hub 保存 Node Public Key；
- Hub 可以单独撤销一个 Node；
- Hub 不保存可直接冒充 Node 的长期明文密码。

Replication Batch 应绑定 `nodeId + sequence + timestamp + payload hash` 进行签名 / 验证，配合 Cursor / Idempotency 防止伪造和无界重放。

### 20. Hub 使用 TLS，并支持自托管身份绑定

Hub Replication Surface 必须使用 TLS。

没有域名 / 公共 CA 的自托管场景允许 AgentLens 自动生成 Hub Identity / TLS Material。首次配对时 Node 显式绑定 Hub Public Key / SPKI Fingerprint，而不是盲目信任自签证书。

用户也可以配置公共 CA 或自有 PKI 证书。证书续期不得无理由改变 Hub Identity；真正更换 Hub Identity Key 时必须显式轮换或重新配对。

### 21. mDNS 只负责发现，不负责建立信任

后续可用 mDNS 等机制发现 Hub，但只回答“Hub 在哪里”。

Node 是否信任某个 Hub仍由 Hub Identity Fingerprint + Pairing Secret 决定。Alpha 第一版可以完全不实现自动发现，使用显式 Hub 地址和配对信息。

### 22. Control Plane 不提供远程 Agent / 系统执行

Hub Control Plane 只管理：

- Pair / Register / Revoke；
- Node Status / Last Seen；
- Protocol Negotiation；
- Replication Diagnostics；
- Hub Identity；
- Bootstrap / Cursor / Conflict 状态。

1.0 Hub 不提供远程启动 Agent、执行 Shell、安装 Skill、修改 Hook、修改 Agent 配置等控制能力。

AgentLens 的产品定位继续是可观测与聚合，不转变为 Agent Orchestrator / Remote Management Platform。

### 23. 产品版本、Replication Protocol、Storage Schema 三者独立

分别维护：

```text
AgentLens Version       1.0.0-alpha.x
Replication Protocol    R1.x
Storage Schema          migration N
```

Node / Hub 网络兼容性由 Replication Protocol 决定，不通过比较 SQLite migration 或 AgentLens SemVer 得出。

Storage Migration 只处理本地数据库内部演进。

### 24. Replication 使用正式版本化 Wire Protocol

Wire DTO 不绑定 SQLite Schema。

Protocol 使用 Major / Minor：

- Minor 只允许向后兼容扩展；
- 破坏 Replica Key、Identity、必填字段、Entity 语义、删除语义、签名语义等兼容性的变化必须升 Major。

Capability 只用于语义兼容的可选能力，不能用大量 feature flag 掩盖实际 Protocol Major 变化。

### 25. 连接前必须执行 Protocol Handshake

Node 与 Hub 先交换：

- Node / Hub AgentLens Version；
- 支持的 Replication Protocol Major / Minor 范围；
- 支持的可选 Capability；
- Node Identity / Hub Identity；
- 当前 Bootstrap / Incremental 状态。

双方选择共同支持的最高兼容版本后，当前连接固定使用该版本。

没有兼容协议时明确暂停 Replication，不进行隐式有损降级。

### 26. 协议不兼容不得影响 Local-first

如果 Node 与 Hub 没有共同 Replication Protocol：

- Node 本地 Source 继续运行；
- Canonical Commit 继续运行；
- Local SQLite / Web 继续可用；
- 未同步 Upsert 由 Reconciliation / Outbox 保留；
- 未同步删除由持久 Tombstone 保留；
- UI / Diagnostics 明确提示升级 Node 或 Hub。

只有明确证明无损的协议转换才允许降级发送；不能通过丢弃新事实字段来假装同步成功。

### 27. 推荐先升级 Hub，再滚动升级 Node

Hub 在支持窗口内兼容当前与仍受支持的旧 Replication Protocol：

```text
upgrade Hub
  -> old Nodes continue with old protocol
  -> upgrade Nodes one by one
  -> remove obsolete protocol in a later release
```

不要求所有机器同时停机升级。

## 架构图

```text
                           AgentLens Hub Node
                 +--------------------------------+
                 | localCapture optional          |
                 | hubAccept=true                 |
                 |                                |
                 | Replication Surface (HTTPS)    |
                 | Node Registry / Control Plane  |
                 | Unified Canonical Store        |
                 | Projections                    |
                 | Local Web 127.0.0.1:56789      |
                 +---------------^----------------+
                                 |
                         Replication R1.x
                                 |
                 +---------------+----------------+
                 |                                |
          AgentLens Node A                 AgentLens Node B
          +----------------+               +----------------+
          | Local Sources  |               | Local Sources  |
          | Canonical DB   |               | Canonical DB   |
          | Replication    |               | Replication    |
          | Policy         |               | Policy         |
          | Bootstrap      |               | Bootstrap      |
          | Outbox/Recon   |               | Outbox/Recon   |
          +----------------+               +----------------+
```

## Cordis 组合边界

目标 Composition Root 按能力装配，而不是维护四套 Application：

```text
common
  storage-sqlite
  core-services
  projections
  capture-policy
  surface-http
  web
  node-identity

localCapture=true
  + sources/*

replicationUpstream=true
  + replication-client

hubAccept=true
  + replication-server
  + replication-surface
  + node-registry
```

Replication Client / Server、Node Identity 与 Replication Surface 都是 Cordis-native Runtime Extension，不在 Cordis 外增加第二套 DI、生命周期或 Plugin Loader。

## Alpha 最小实现顺序

本 ADR 只锁架构，不表示以下能力已经实现。建议按顺序落地：

1. Node Identity + capability-driven Composition Root；
2. Replication Global Key / Shared Merge Contract；
3. Replication Wire DTO + Handshake；
4. Replication Policy；
5. Bootstrap Sync；
6. Durable Outbox + Canonical Reconciliation；
7. Hub Node Registry + Unified Canonical Store；
8. Transactional Remote Ingest；
9. Pairing / Node Key / Hub Identity / TLS；
10. Node 状态、同步诊断与 Conflict；
11. Projection / Protocol 增加 Host / Node Scope；
12. Web 多机筛选与设备视图；
13. Tombstone / 删除同步；
14. mDNS、远程 Web、Hub Federation 等后续独立能力。

## 被拒绝的方案

### Node / Hub 拆成两套程序和两套 Runtime

拒绝。会重复 Core、Storage、Protocol、升级和发行边界，也违背当前 Cordis 组合式架构。

### 把 Node / Hub 实现成互斥领域角色

拒绝。Hub 本身仍是一个 AgentLens Node；真正变化的是 local capture、upstream replication、hub accept 三类能力组合。

### Hub 作为唯一事实库，Node 退化为 Collector

拒绝。会破坏 Local-first，Hub / 网络故障将直接影响本机使用。

### Hub 只做联邦查询，不保存 Replica

拒绝。Node 离线后历史不可见，跨机排序、分页、Usage / Overview 聚合会持续复杂化。

### 直接同步 SQLite 数据库文件或数据库行

拒绝。数据库锁、Schema Migration、版本错峰、文件损坏和协议耦合都无法形成稳定边界。

### 直接把当前本机 Canonical ID 当跨机全局主键

拒绝。当前 Host Identity 算法并不保证跨机器全局唯一，会把本机实现细节错误提升为网络身份契约。

### 为 Hub 强制重写现有整库 Canonical ID

拒绝作为 Hub 前置条件。现有 Identity Migration 影响范围大，应作为独立 Contract Review；Hub 先使用确定性的 Replication Namespace / Replica Key 解决跨机唯一性。

### Hub 重新解析 Source 或重新 Commit Remote Candidate

拒绝。会让 Hub重新依赖具体 Source，并重新制造一套事实解释过程。Replica Key 映射只是网络命名空间，不是重新推断事实。

### 同步 Projection DTO

拒绝。Projection 可重建，不得因为 Hub 成为第二事实源。

### 按 Node 分数据库

拒绝。会在 Storage 层重新制造联邦查询。

### 只依赖 `observation/committed` 事件写 Outbox

拒绝。Canonical COMMIT 后进程崩溃可能形成永久漏同步窗口；必须有 Reconciliation。

### 使用通用 last-write-wins 合并 Shared Entity

拒绝。结果会依赖网络到达顺序，无法解释也无法稳定重放。

### 一个 Node 同时连多个 Hub / Hub Federation

Alpha 拒绝。会立即引入循环复制、ownership、删除传播和多中心冲突问题。

### 把现有 `/api/v1/*` 直接暴露给网络

拒绝。当前 Local Surface 依赖 loopback 且没有网络认证层；Replication 使用独立 Surface 与独立安全边界。

### Hub 反向连接 / 控制 Node

拒绝。会扩大攻击面并把产品带向远程管理 / Orchestration。

### 为 Alpha 先引入 PostgreSQL / Redis / Kafka

拒绝。当前目标是个人多机聚合，先用现有 Storage Contract + SQLite 验证真实规模。

## 后果

正向后果：

- 保持 Local-first 与离线可用；
- Node / Hub 共用一套 Core / Cordis / Storage / Projection / Web；
- 不需要为了 Hub 立即迁移现有 Canonical ID；
- Replica Key 明确解决本机 ID 不是全局唯一的问题；
- Bootstrap 能覆盖启用 Hub 前的历史数据；
- Reconciliation 能修复 Event / Outbox 失败窗口；
- Replication Policy 不会把“允许本机保存”自动提升为“允许发到网络”；
- Hub 可在 Remote Node 离线时继续查询历史；
- Projection 不需要理解数据库分片或具体 Source；
- 单 Hub 星型拓扑保持 Alpha 实现和故障语义可控。

代价：

- Hub 会保存远程 Canonical 数据副本；
- Node-local ID 与 Hub Replica Key 需要明确映射和诊断展示；
- Shared Entity 必须逐类定义 Merge Contract；
- 需要 Bootstrap、Durable Outbox、Reconciliation、Node Registry、Tombstone 与冲突诊断；
- Pairing、TLS、密钥撤销和协议协商成为新的安全关键路径；
- 多机测试面明显大于普通本机功能。

## 验证标准

- 没有 Hub 配置时，Standalone 行为与当前 1.0 一致；
- 每个 AgentLens 数据根有稳定 `nodeId`；
- Hub / Node 是能力组合而不是两套程序；
- Node 在 Hub 完全不可达时仍持续本地采集和查询；
- 同名同平台的两个 Node 不会因当前 Host ID 算法在 Hub 中互相覆盖；
- 同一 `nodeId + entityType + originEntityId` 重复同步始终映射到同一 Replica Key；
- Shared Entity Merge 与 Batch 到达顺序无关；
- 首次 Pair 后可以 Bootstrap 既有历史，再平滑进入 Incremental；
- Canonical COMMIT 后即使 fast-path Event 丢失，Reconciliation 仍能补齐同步；
- Replication Policy 不得比 Capture Policy 恢复更多正文；
- `metadata-only` 不上传 Prompt / Tool 正文；
- 一个 Node 最多一个 upstream Hub，Hub 不级联复制远程副本；
- 重复 Batch 不制造重复事实；
- Batch 引用、ownership 或签名失败时事务回滚且 ACK 不推进；
- Node B 不能修改 Node A 的机器作用域 Replica Entity；
- 删除依赖显式 Tombstone，不通过“本次没看到”推断；
- Local HTTP 继续固定 loopback，Hub 网络入口独立；
- 未配对 / 已撤销 Node 不能上传数据；
- Protocol 不兼容只暂停 Replication，不阻断本机 Pipeline；
- Projection / Web 不把 Replication Metadata 当作 Agent 行为事实。

## 相关决策

- ADR-0001：AgentLens 1.0 Clean Rebuild 与 Cordis Runtime；
- ADR-0004：双发行、单运行时与生命周期；
- ADR-0005：Runtime Profile、Session Relationship 与 Asset Topology；
- ADR-0006：性能治理与架构护栏。
