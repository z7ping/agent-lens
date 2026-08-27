# ADR-0007：多机 Hub、Local-first 与 Canonical Replication

状态：Accepted（2026-08-27 二次实现前复核）  
日期：2026-08-27  
范围：AgentLens 1.0 Alpha / Hub / Node Identity / Replication / Security / Protocol / Storage

## 背景

AgentLens 1.0 当前是本地优先的 AI 编码 Agent 可观测工具：每台机器独立完成 Source 采集、Canonical Pipeline、SQLite 持久化、Projection 与 Web / Desktop 展示。多机能力的目标，是让多台 Windows / macOS / Linux 机器的数据可以在一个 Hub 中统一查看与聚合分析，同时不破坏 Local-first、Canonical Observation、Evidence、Cordis Runtime、Projection 和双发行边界。

本 ADR 首次接受后进行了两轮实现前复核。主方向不变，但复核修正了容易导致返工或越权的边界：

1. `Node` 是 AgentLens 实例身份，不是与 `Hub` 互斥的底层 Runtime Role；
2. 当前本机 Canonical ID 并不保证跨机器全局唯一，因此不能直接把本机 ID 当 Hub 全局主键；
3. Shared Canonical Entity 需要字段级确定性 Merge，不能要求整实体字节级一致；
4. Durable Outbox 不能只依赖 Cordis Event，还必须通过 Canonical Reconciliation 查漏补缺；
5. Replication Policy 与 History Scope 必须分离，连接 Hub 不等于授权上传全部既有历史；
6. Stream / ACK 与 Replica Generation 是不同状态维度，显式 Re-bootstrap 不能把半成品副本直接变成用户可查询事实；
7. Hub Identity 必须真正参与 Pairing / Handshake 密码学证明，不能只依赖 endpoint 或 TLS 证书名称。

因此，本 ADR 定义 1.0 Alpha Hub 的长期架构边界。具体 Entity / Wire / Security / State 细节由 `docs/1.0/HUB-DESIGN-INDEX.md` 指向的下位 Contract 承载。

## 决策

### 1. 每个 AgentLens 实例都是 Node；Standalone / Hub 是能力组合，不是四套 Runtime

`Node` 表示一个持久的 AgentLens 实例身份。每个运行中的 AgentLens 都有 `nodeId`，无论它是否连接 Hub、是否接受其他 Node 的复制。

底层能力：

```text
AgentLens Node
  localCapture        true | false
  replicationUpstream true | false
  hubAccept           true | false
```

Alpha 只允许四个正式 Profile：

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

Alpha 明确不允许：

- `replicationUpstream=true && hubAccept=true`，避免形成隐藏级联 Hub / Federation；
- `localCapture=false && replicationUpstream=true` 的未定义“纯转发节点”；
- 三项全部关闭的无效空运行时。

产品 / CLI 可以继续用 `standalone`、`node`、`hub`、`pure-hub` 作为便捷 Profile，但 Core / Runtime 不维护四套程序或四套领域模型。

能力切换在 Alpha 阶段允许要求重启 Daemon，不要求运行时热切换 Cordis Plugin。

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

Hub 不在线、网络中断、配对失效、证书失败、身份验证失败或协议不兼容，都不得阻塞 Node 本地采集、查询和持久化。

Hub 不成为 AgentLens 的启动前置条件，也不成为唯一事实库。

### 3. Hub 是 Canonical Replica + Aggregator，不是第二个 Source Parser

Node 完成本机 Source 解释与 Canonical Commit 后，再把用户允许复制的规范实体状态同步给 Hub：

```text
Node Native Source
  -> Node Canonical Pipeline
  -> Node Canonical Store
  -> Replication Policy
  -> History Scope
  -> Replication
  -> Hub Canonical Replica
  -> Hub Projection
  -> Unified Web
```

Hub 不重新读取 Claude / Codex / Pi / Hermes / OpenCode 原生数据，也不重新运行各 Source Parser / Normalizer。

Hub Remote Ingest 不重新调用普通 `ObservationService.commit()` 来“猜”远程事实；它通过专门 Replication Import 边界校验和导入已经形成的 Canonical Entity State。

### 4. 同步正式 Wire DTO，不同步 SQLite 文件、SQLite Row 或 Projection

Replication 使用独立版本化 Wire DTO。至少需要覆盖形成完整可复制事实图所需的持久 Canonical Entity State，例如：

- Host；
- AgentProduct / AgentInstallation；
- RuntimeProfile；
- Project / Workspace；
- LogicalSession / SourceSession / SessionRelationship；
- AgentActor；
- SourceRecord；
- CanonicalObservation；
- Evidence / ObservationEvidence；
- Coverage；
- AssetDefinition / AssetBinding / AssetStateObservation；
- ToolDefinition。

运行时 Capability、Source Runtime Status、Checkpoint、Candidate、Projection / Summary / Usage / Overview 等不作为 Canonical Replication Entity；Hub 若需展示运行能力，通过 Replication Control Plane / Protocol Capability Negotiation 获取。

禁止：

- rsync / 复制 `agent-lens.db`；
- 直接把 SQLite Row 定义成网络协议；
- 同步 Projection 作为事实源；
- 让 Hub 因远程同步重新依赖具体 Source Parser。

### 5. 本机 Canonical ID 与跨机 Replica Key 分离

当前 1.0 `Host.id` 由 `hostname + platform + arch` 稳定哈希生成，Installation / Workspace 等多个 ID 又继续依赖 Host ID。该算法适合单机稳定识别，但不能证明跨机器全局唯一。

因此，本 ADR **不要求 Node 本机 Canonical ID 直接成为 Hub 全局主键**，也不为了 Hub 强制迁移整套本机 Canonical ID。

机器作用域实体使用确定性的 Replication Namespace：

```text
ReplicaKey = stable(nodeId, entityType, originEntityId)
```

Wire 保留：

```text
originNodeId
originEntityId
```

发送端可以携带 Replica Key 供诊断，但 Hub 必须能够自行按协议算法重新计算并校验。

这不是 Hub 重新运行 IdentityService，也不是按内容重新推断事实；它只是跨机器命名空间映射。

Project、AgentProduct、AssetDefinition 等只有满足正式 Shared Identity Contract 时才跨 Node 汇聚。Shared 是显式例外，新 Entity 默认 Node-scoped。

未来若要迁移本机 Host / Canonical Identity 为真正全局身份，必须单独 Contract Review / Migration，不由 Hub 顺手改写既有数据库。

### 6. `nodeId` 使用持久 UUID；Host Identity 暂不与 Node Identity 合并

每个 AgentLens 数据根首次初始化生成随机、持久 `nodeId`：

```text
~/.agent-lens/1.0/node.json
```

`nodeId` 表示 AgentLens 实例 / 数据根身份；hostname、platform、arch 是可变元数据。

`Host` 继续表示 Canonical Domain 中被观察机器的身份。当前 Host ID 算法暂不因 Hub 强制改 UUID，避免未经迁移设计就重写既有 Installation / Workspace / Session / Observation 引用链。

一个 `nodeId` 不得被两个真实并发实例共同使用。Clone Detection 必须区分强冲突与弱元数据变化：IP、hostname、sleep / wake 等只能作为 Diagnostics；真正的并发 runtime / stream sequence 分叉等强证据才可冻结复制关系。

### 7. Alpha 固定单 Hub 星型拓扑

```text
              Hub
        +------+------+ 
        |      |      |
      Node A Node B Node C
```

约束：

- 一个 Node 最多一个 upstream Hub；
- Hub 不向另一个 Hub 复制远程副本；
- 不支持 Hub Federation；
- 不支持一个 Node 同时向多个 Hub 同步；
- 不支持级联 Hub 或循环 Replication。

未来若需要 Federation，必须独立设计 ownership、loop prevention、delete propagation 与冲突语义。

### 8. Hub 使用统一 Canonical Store，不按 Node 分数据库

多个 Node 数据进入同一个 Hub Repository / Storage：

```text
Hub Store
  hosts / installations / sessions / observations / evidence / assets / ...
  replication control plane
```

不采用 `node-a.db / node-b.db / node-c.db`，避免 Projection、排序、分页和聚合退化为 Storage 层联邦查询。

Alpha 继续使用 SQLite；未来是否增加 `storage-postgres` 由真实规模和性能基线决定。

### 9. Canonical Layer 与 Replication Control Plane 分离

不在所有 Canonical 表上机械增加 `node_id`。

Replication 自己维护控制面，例如：

```text
nodes
pairing relationships
replication streams / cursors / receipts
replica generations
replica entity maps / aliases
shared assertions
replication conflicts
replication tombstones
policy / history state
```

这些信息描述“谁复制了什么、按什么授权边界同步、当前是否冲突”，不属于被观察 Agent 的行为事实，不进入 Canonical Observation。

### 10. Shared Canonical 使用显式身份与字段级确定性 Merge

Shared 不能简单规定“同 ID 全对象必须一致”，也不能用 last-write-wins。

每一种 Shared Entity 必须定义：

1. **Identity Fields**：决定是不是同一实体；
2. **Mergeable Metadata**：有明确 deterministic merge；
3. **Node-local Metadata**：保留在 origin / Control Plane；
4. **Conflict Fields**：无法安全合并时进入 Replication Conflict。

示例：

```text
createdAt   -> min()
lastSeenAt  -> max()
集合字段     -> stable union
展示字段     -> deterministic value + diagnostics
```

Merge 结果必须与 Batch 到达顺序无关。

Hub 本机也是一个合法 Node origin；本机 Conditional Shared Entity 不通过 HTTPS 自我复制，但必须能与 Remote Assertion 参与同一 Shared Project / Asset 聚合。

### 11. Replication Batch 必须事务性、幂等，并处理提交不确定性

Hub 对单个 Batch：

```text
BEGIN
  validate node / hub / stream
  validate protocol / signature / policy
  validate ownership / references
  map replica / shared refs
  merge / upsert entities
  update replication control state
COMMIT
ACK sequence
```

失败回滚整个 Batch，不部分 ACK。

一旦 Batch 第一次可能发网，其 sequence / body / content hash 必须冻结；如果 Hub 已提交但 ACK Response 丢失，Node 只能重试同一 immutable Batch 或查询 Hub ACK，不能给同 sequence 换内容。

Alpha 使用 Entity State / Tombstone，不把 AgentLens 改造成 Event Sourcing。

### 12. Durable Outbox 不以 Cordis Event 作为唯一事实来源

`observation/committed`、Asset 变化等 Event 可以快速触发同步，但不是 Durable Replication Fact。

必须覆盖：

```text
Canonical COMMIT 成功
 -> 进程在 fast-path enqueue 前崩溃
```

因此：

```text
Cordis Event
  -> fast path

Canonical Store
  -> History Boundary
  -> Replication Policy
  -> reconciliation / content hash
  -> repair pending state
```

正式语义：

```text
at-least-once delivery
+ deterministic identity / hash
+ idempotent import
+ reconciliation
```

删除必须依赖持久 Tombstone，普通扫描缺失不能推断删除。

### 13. 首次接入必须明确 History Scope；是否 Bootstrap 由用户授权决定

连接 Hub 不等于授权上传全部既有历史。

Alpha 至少区分：

```text
from-now
include-existing
```

流程：

```text
Pair + choose Replication Policy / History Scope
  |
  +-- include-existing
  |     -> resumable Bootstrap
  |     -> Bootstrap Complete
  |     -> mandatory Reconciliation
  |
  +-- from-now
        -> persist History Boundary
        -> no ordinary historical backfill
        -> later facts may include required dependency closure
        -> Reconciliation still respects boundary

then -> Incremental
```

`from-now` 不能只实现成 `occurredAt >= pairTime`，因为来源时间质量、晚发现历史和旧身份依赖都可能导致错误授权。具体 Boundary Contract 由 `HUB-REPLICATION-STATE-CONTRACT.md` 定义。

Bootstrap 与 Incremental 使用同一 Wire Contract、幂等导入和 Policy，不维护两套事实语义。

### 14. Capture Policy、Replication Policy 与 History Scope 分离

三者分别回答：

```text
Capture Policy
  -> 什么能进入 Local Canonical Store

Replication Policy
  -> Local Canonical 中哪些字段允许离开本机

History Scope
  -> 是否允许补传 Boundary 建立前已有历史
```

Replication Policy 永远不能比 Capture 已经保存的内容更“完整”。Alpha 至少：

```text
metadata-only
redacted
full
```

- `metadata-only`：不发送 Prompt / Tool 正文，并默认不发送完整本机路径；但仍可包含项目 / 仓库身份、Agent / Tool、时间和结构元数据，因此不是匿名模式；
- `redacted`：出站再次脱敏与限长；
- `full`：允许复制本机已经持久化的普通业务正文，但明确凭据保护不能关闭。

Wire 必须显式区分 `value / omitted / not-captured / redacted / real null`。

Policy 放宽不自动扩大历史授权；Policy 收紧必须立即停止新的旧 Policy 出站请求，不能为了修复 sequence gap 继续发送用户刚刚禁止的正文。

### 15. Node-scoped ownership 与 Shared Merge 分离

Node-scoped Replica ownership 由 `originNodeId` 决定，其他 Node 不得修改。

Shared Entity 由 Shared Identity + Merge Contract + origin assertions / membership 汇聚，不属于某一个 Node 独占。

ownership、identity 或 invariant 冲突都记录为 Replication Conflict，不进入 Agent 行为 Observation。

### 16. 删除语义与连接撤销分离

Hub 是副本，不是隐式备份系统。

Node-scoped 删除使用持久 Tombstone；Shared 删除是来源 Assertion Withdrawal。普通 Reconciliation 不能根据 absence 推断删除。

撤销 Node 只阻止未来 Replication，默认保留已有 Hub 历史。删除某设备历史必须是另一个显式、可预演操作。

显式 Re-bootstrap 可以使用 staged Replica Generation 重建完整副本；新 Generation 完成 Bootstrap + Reconciliation + 校验并原子激活前，旧 active Generation 继续服务查询。

### 17. Node 永远主动连接 Hub，Hub 不反向访问 Node

```text
Node
  -> outbound HTTPS
  -> Hub Replication Surface
```

Node 不为 Hub 开放监听端口，不要求固定 IP / 公网地址。Hub 不通过该架构获得 Remote Execution 能力。

### 18. Local HTTP Surface 与 Replication Surface 完全分离

现有：

```text
surface-http
  -> 127.0.0.1:56789
```

Hub 新增：

```text
surface-replication
  -> HTTPS
  -> pairing / handshake / stream / batch / status
```

禁止把现有无认证 Local HTTP 改成 `0.0.0.0` 来实现 Hub。

Alpha Hub Web 默认仍只在 Hub 本机访问。Remote Web Login / Account / Cookie / CSRF / RBAC 是独立能力，不由 Replication Surface 顺带承担。

### 19. Pairing 与长期认证分离；Hub 与 Node 都要证明密钥持有

首次配对使用短期、一次性 Pairing Secret，只用于用户授权建立信任，成功后立即失效。

Node 长期使用非对称密钥，优先 Ed25519：

- Node Private Key 只在 Node；
- Hub 保存 Node Public Key；
- Pairing Request 必须证明 Node 持有该 Public Key 对应 Private Key；
- Hub 可以单独撤销 Node。

Hub 也有独立长期 Hub Identity Key。Hub Identity 必须实际签名 Pairing Receipt 和 Handshake Proof，使 Node 能证明 endpoint 背后的服务器仍持有原 Hub Identity Private Key。

长期 Node Request Signature 必须绑定至少：

```text
hubId
nodeId
replicationStreamId
keyId
method
path
timestamp
nonce
raw body hash
```

以防止合法 Body 被替换身份 Header 后重用。

### 20. Hub 使用 TLS，并把 Hub Identity 与 TLS Identity 分离

Hub Replication Surface 必须 TLS。

没有公共 CA 的自托管场景允许生成 Hub Identity 与自管理 TLS Material。首次配对时：

- TLS / SPKI 负责确认传输端点；
- Hub Identity Public Key / Fingerprint 负责长期产品信任身份；
- Pairing Receipt / Handshake Proof 把长期信任关系变成可验证密码学事实。

正常证书续期不等于 Hub Identity 变化；TLS SPKI Key 变化或 Hub Identity Key 变化都不能静默接受。

用户也可以提供公共 CA / 自有 PKI 证书。

### 21. mDNS 只负责发现，不负责建立信任

mDNS 等机制以后可以回答“Hub 在哪里”，但 discovery 数据不可信。

建立信任仍依赖：

```text
TLS / SPKI
Hub Identity
Pairing Secret
Pairing Receipt / Hub Proof
```

Alpha 可以完全不实现自动发现。

### 22. Control Plane 不提供远程 Agent / 系统执行

Hub Control Plane 只管理：

- Pair / Register / Revoke；
- Node / Stream / Generation Status；
- Protocol Negotiation；
- Policy / History / Replication Diagnostics；
- Hub Identity；
- Cursor / Receipt / Conflict / Tombstone 等同步状态。

1.0 Hub 不提供远程启动 Agent、执行 Shell、安装 Skill、修改 Hook、修改 Agent 配置等能力。

### 23. 产品版本、Replication Protocol、Storage Schema 三者独立

```text
AgentLens Version       1.0.0-alpha.x
Replication Protocol    R1.x
Storage Schema          migration N
```

网络兼容性由 Replication Protocol 决定，不通过比较 SQLite migration 或 AgentLens SemVer 得出。

### 24. Replication 使用正式版本化 Wire Protocol

Wire DTO 不绑定 SQLite Schema。

Protocol 使用 Major / Minor：

- Minor 只允许向后兼容扩展；
- 破坏 Replica Key、Identity、History / Delete、签名、必填字段或 Entity 语义的变化必须升 Major。

Capability 只用于兼容可选能力，不能用大量 Feature Flag 掩盖实际 Major 变化。

### 25. 连接前必须执行 Protocol Handshake

Node / Hub 至少协商 / 验证：

- AgentLens Version；
- Replication Protocol Major / Minor；
- 可选 Capability；
- Node / Hub Identity；
- active Stream / ACK；
- Policy / History Revision；
- active Replica Generation；
- Hub Identity Proof；
- server time / clock skew diagnostics。

没有共同协议时只暂停 Replication，不做隐式有损降级。

### 26. 协议不兼容不得影响 Local-first

如果没有共同 Protocol：

- 本地 Source / Canonical Commit / SQLite / Web 继续正常；
- 未同步 Upsert 仍可由 Outbox / Reconciliation 保留；
- 未同步删除由 Tombstone 保留；
- UI 明确提示升级。

只有明确证明无损的转换才允许降级发送。

### 27. 推荐先升级 Hub，再滚动升级 Node

Hub 在支持窗口内兼容当前和仍受支持的旧 Replication Protocol：

```text
upgrade Hub
 -> old Nodes continue
 -> upgrade Nodes one by one
 -> later retire obsolete protocol
```

不要求所有机器同时停机。

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
          +------------------+             +------------------+
          | Local Sources    |             | Local Sources    |
          | Canonical DB     |             | Canonical DB     |
          | Policy / History |             | Policy / History |
          | Bootstrap/Bound. |             | Bootstrap/Bound. |
          | Outbox / Recon   |             | Outbox / Recon   |
          +------------------+             +------------------+
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

## Alpha 实施顺序

ADR 只锁长期边界，阶段退出条件以 `docs/1.0/HUB-ALPHA-IMPLEMENTATION-PLAN.md` 为准。当前顺序：

```text
H1 Node Identity / Composition
 -> H2 Replication Core
 -> H3 R1 Protocol / Identity Proof
 -> H4 Policy / History / Outbox / Reconcile
 -> H5 Hub Import / Replica Generation
 -> H6 Security / Surface
 -> H7 E2E Sync
 -> H8 Web / CLI
 -> H9 Delete / Identity / Recovery Ops
 -> H10 Performance / Hardening
```

## 被拒绝的方案

### Node / Hub 拆成两套程序和两套 Runtime

拒绝。会重复 Core、Storage、Protocol、升级和发行边界，也违背 Cordis 组合式架构。

### 把 Node / Hub 实现成互斥领域角色

拒绝。Hub 本身仍是一个 AgentLens Node；变化的是 local capture、upstream replication、hub accept 能力组合。

### Hub 作为唯一事实库，Node 退化为 Collector

拒绝。会破坏 Local-first。

### Hub 只做联邦查询，不保存 Replica

拒绝。Node 离线后历史不可见，跨机排序、分页、聚合持续复杂化。

### 直接同步 SQLite 数据库文件或数据库行

拒绝。锁、Migration、错峰版本、文件损坏和协议耦合无法形成稳定边界。

### 直接把当前本机 Canonical ID 当跨机全局主键

拒绝。当前 Host Identity 算法并不保证跨机器全局唯一。

### 为 Hub 强制重写现有整库 Canonical ID

拒绝作为 Hub 前置条件。Identity Migration 应独立 Review。

### Hub 重新解析 Source 或重新 Commit Remote Candidate

拒绝。会让 Hub 重新依赖具体 Source，并制造第二次事实解释。

### 同步 Projection DTO

拒绝。Projection 可重建，不得成为第二事实源。

### 按 Node 分数据库

拒绝。会重新制造 Storage 联邦查询。

### 只依赖 `observation/committed` 事件写 Outbox

拒绝。Canonical COMMIT 后崩溃可能永久漏同步，必须有 Reconciliation。

### 用普通扫描缺失推断删除

拒绝。删除依赖 Tombstone；完整 Re-bootstrap Generation 的 absence 语义是受严格限定的重建例外。

### 使用通用 last-write-wins 合并 Shared Entity

拒绝。结果依赖网络到达顺序，不可稳定重放。

### 一个 Node 同时连多个 Hub / Hub Federation

Alpha 拒绝。会引入循环复制、ownership、删除传播、多中心冲突。

### 把现有 `/api/v1/*` 直接暴露给网络

拒绝。Local Surface 依赖 loopback 且没有网络认证层。

### Hub 反向连接 / 控制 Node

拒绝。会扩大攻击面并改变产品定位。

### 为 Alpha 先引入 PostgreSQL / Redis / Kafka

拒绝。先用现有 Storage Contract + SQLite 验证真实规模。

## 后果

正向后果：

- 保持 Local-first 与离线可用；
- Node / Hub 共用 Core / Cordis / Storage / Projection / Web；
- 不需要为了 Hub 立即迁移现有 Canonical ID；
- Replica Namespace 解决本机 ID 不是全局唯一的问题；
- 用户可以选择补传既有历史，或建立 `from-now` 持久边界；
- Reconciliation 修复 Event / Outbox 失败窗口；
- Replication Policy 不会把“允许本机保存”自动提升为“允许发到网络”；
- Hub 可在 Remote Node 离线时继续查询历史；
- staged Re-bootstrap 不会在重建途中把半成品副本暴露为 active；
- Pairing / Handshake 对 Hub 与 Node 都有实际密码学身份证明；
- 单 Hub 星型拓扑保持 Alpha 实现和故障语义可控。

代价：

- Hub 会保存远程 Canonical 数据副本；
- Node-local ID 与 Hub Replica Namespace 需要映射和 provenance；
- Shared Entity 必须逐类定义 Identity / Merge Contract；
- 需要 History Boundary、Policy Revision、Bootstrap、Outbox、Reconciliation、Stream / Receipt、Replica Generation、Tombstone 与冲突诊断；
- Pairing、TLS、Hub / Node Key、撤销和 Protocol 协商成为安全关键路径；
- Hub 汇聚数据的本地安全半径高于单 Node；
- 多机测试面显著扩大。

## 验证标准

- 没有 Hub 配置时 Standalone 与当前 1.0 行为一致；
- 每个 AgentLens 数据根有稳定 nodeId；
- 只允许 Alpha 正式 Capability Profile，不形成隐藏级联 Hub；
- Node 在 Hub 完全不可达时仍持续本地采集 / 查询；
- 同名同平台两个 Node 不因本机 Host ID 在 Hub 相互覆盖；
- 同一 `nodeId + entityType + originEntityId` 重复同步得到同一 Replica Key；
- Shared Merge 与到达顺序无关；
- `include-existing` 可以可恢复 Bootstrap 既有历史；
- `from-now` 不被后续 Reconciliation 绕过，并能为新事实补齐必要 dependency closure；
- Canonical COMMIT 后 fast-path Event 丢失仍能由 Reconciliation 补齐；
- Replication Policy 不恢复 Capture 已关闭 / 脱敏内容；
- metadata-only 不上传 Prompt / Tool 正文，也默认不上传完整 Workspace 本机路径；
- Policy 收紧后不继续生成新的旧 Policy 请求；
- ambiguous Batch 不允许同 sequence 换 Body，必要时可安全 Stream Rollover；
- Re-bootstrap 半途失败时旧 active Generation 仍可查询；
- 重复 Batch 不制造重复事实；
- Batch 引用、ownership、signature 失败时事务回滚且 ACK 不推进；
- Node B 不能修改 Node A 的机器作用域 Replica；
- 普通删除依赖 Tombstone，不通过普通 scan absence 推断；
- Local HTTP 固定 loopback，Hub 网络入口独立；
- Pairing Secret / Node Proof / Pairing Receipt / Hub Proof / Request Signature 构成闭环；
- 未配对 / 已撤销 Node 不能上传；
- IP / hostname 变化不能单独触发 Clone Freeze；
- Protocol 不兼容只暂停 Replication，不阻断本机 Pipeline；
- Hub 本机与 Remote Node 的同一 Portable Project 能统一聚合；
- Projection / Web 不把 Replication Metadata 当 Agent 行为事实；
- 跨机器时间不使用 `replicatedAt` 覆盖 origin 业务时间。

## 相关决策与下位 Contract

- ADR-0001：AgentLens 1.0 Clean Rebuild 与 Cordis Runtime；
- ADR-0004：双发行、单运行时与生命周期；
- ADR-0005：Runtime Profile、Session Relationship 与 Asset Topology；
- ADR-0006：性能治理与架构护栏；
- `docs/1.0/HUB-DESIGN-INDEX.md`：Hub 下位 Contract / Protocol / Security / Operations / UX / Test 入口。
