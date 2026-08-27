# ADR-0007：多机 Hub、Local-first 与 Canonical Replication

状态：Accepted  
日期：2026-08-27  
范围：AgentLens 1.0 Alpha / Hub / Node Identity / Replication / Security / Protocol / Storage

## 背景

AgentLens 1.0 当前是本地优先的 AI 编码 Agent 可观测工具：每台机器独立完成 Source 采集、Canonical Pipeline、SQLite 持久化、Projection 与 Web / Desktop 展示。随着真实狗粮范围扩大，需要支持多台 Windows / macOS / Linux 机器的数据统一查看与聚合分析，同时不能破坏现有 Local-first、Canonical Observation、Evidence、Cordis Runtime、Projection 与双发行边界。

多机能力如果直接采用数据库文件同步、Hub 远程查询各 Node、把 Hub 变成唯一事实库，或把现有 loopback HTTP 直接暴露到网络，会分别造成 Schema 耦合、离线不可用、Local-first 退化和严重安全边界变化。

因此，本 ADR 定义 AgentLens 1.0 Hub 的长期架构边界。Alpha 实现可以分阶段落地，但不得偏离这些原则。

## 决策

### 1. Node / Hub 是同一 AgentLens Runtime 的运行角色，不是两套程序

AgentLens 继续只有一套 Core、Cordis Runtime、Storage、Protocol、Projection 和 Web。不同角色只通过 Composition Root 注册不同插件组合：

```text
Standalone
  = common runtime + local sources

Node
  = common runtime + local sources + replication-client

Hub
  = common runtime + local sources + replication-server + node-registry

Pure Hub
  = common runtime + replication-server + node-registry
```

Hub 默认同时采集本机数据；通过 `localCapture=false` 可以成为纯 Hub。

角色切换在 Alpha 阶段允许要求重启 Daemon，不要求运行时热切换插件。

### 2. Hub 是可选的 Local-first 聚合层

每个 Node 必须始终能够独立完成：

```text
Native Source
  -> Normalize
  -> Identity
  -> Canonical Observation / Evidence
  -> Local Storage
  -> Local Projection / Web
```

Hub 不在线、网络中断、配对失效或协议不兼容，都不得阻塞 Node 本地采集、查询和存储。

Hub 不成为 AgentLens 的启动前置条件，也不成为唯一事实库。

### 3. Node 是本地产生事实的权威来源，Hub 是 Canonical Replica + Aggregator

Node 完成本机 Source 解释与 Canonical Commit 后，再把规范实体同步到 Hub：

```text
Node Native Source
  -> Node Canonical Pipeline
  -> Node Canonical Store
  -> Replication
  -> Hub Canonical Replica
  -> Hub Projection
  -> Unified Web
```

Hub 不重新解释 Claude / Codex / Pi / Hermes / OpenCode 原生数据，不重新执行 `ObservationService.commit()` 来制造第二套 Canonical Identity。

### 4. 同步 Canonical Entity State，不同步 SQLite 文件、数据库行或 Projection

Replication 使用正式 Wire DTO 表达 Canonical Entity State。至少覆盖形成完整事实图所需的实体，例如：

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
- 传输 SQLite Row 作为网络协议；
- 同步 Session Summary / Usage / Overview 等 Projection 作为事实源；
- 让 Hub 因远程同步重新依赖具体 Source Parser。

### 5. Canonical ID 在 Node 生成，并在 Hub 保持不变

Node 生成的 Canonical Entity ID 在 Replication 后保持原值。Hub 不为同一事实重新生成另一套 ID。

这保证 Observation、Evidence、Relationship、Asset Binding 等引用在 Node 与 Hub 之间稳定一致，也避免长期维护 `originEntityId -> hubEntityId` 映射。

### 6. Host / Node 使用持久身份，不再把 hostname 当作全局身份

多机模式下新增独立 Node Identity。概念关系为：

```text
Host
  -> Node
     -> AgentLens Runtime
```

通常一个 Host 对应一个 Node，但两个概念不合并：

- Host 表示被观察机器；
- Node 表示这台机器上的 AgentLens 同步实例。

`nodeId` 和 `hostId` 使用首次初始化生成并持久化的 UUID；hostname、platform、arch 是可变元数据，不再参与全局机器身份的唯一性判断。

Node Identity 保存在 1.0 数据根内，保留数据目录时升级、改 hostname 不改变 Node Identity。

### 7. Hub 使用统一 Canonical Store，不按 Node 分库

Hub 的多个 Node 数据进入同一个 Canonical Repository / Storage：

```text
Hub Store
  hosts
    - Host A
    - Host B
    - Hub Host
  observations
    - A observations
    - B observations
    - Hub observations
```

不采用 `node-a.db / node-b.db / node-c.db`。否则 Projection、排序、分页与聚合又会退化为数据库层联邦查询。

Alpha 继续使用 SQLite；是否未来增加 `storage-postgres` 由实际规模和性能基线决定，不因为引入 Hub 提前更换数据库。

### 8. Canonical Layer 与 Replication Control Plane 分离

不在所有 Canonical 表上机械增加 `node_id`。

机器作用域实体可沿 Host / Installation / Workspace / Session 关系确定来源；Project、AgentProduct、AssetDefinition 等允许成为跨 Node 的共享 Canonical Entity。

Node 注册、配对、在线状态、同步游标、来源追踪和冲突属于 Replication Control Plane，例如：

```text
nodes
replication_cursors
replication_entity_sources
```

这些表不属于被观测 Agent 的 Canonical Observation。

### 9. Replication Batch 必须事务性、幂等

Node 使用 Durable Outbox / Cursor 按 Batch 上传。Hub 对一个 Batch 执行完整校验和事务写入：

```text
BEGIN
  validate node
  validate protocol
  validate references
  upsert canonical entities
  update replication metadata
COMMIT
ACK sequence
```

失败时回滚整个 Batch，不推进 ACK。Node 重试同一 Batch 不得制造重复事实。

Alpha 优先同步 Entity State / Upsert，不把 AgentLens 改造成 Event Sourcing 系统。

### 10. Canonical 冲突拒绝，不采用 last-write-wins

Node-scoped Entity 只有其绑定 Node 有权同步修改。其他 Node 试图修改时拒绝。

共享 Canonical Entity 如果内容一致可幂等汇聚；同一 Canonical ID 出现不兼容内容时记录 Replication Conflict 并拒绝覆盖，不能使用“最后到达者获胜”。

冲突属于 Diagnostics / Operations，不进入 Agent 行为 Observation。

### 11. 删除语义与连接撤销分离

Hub 是副本而不是隐式备份系统。长期目标为支持 Tombstone / Delete Replication，使明确的 Canonical 删除可以传播到 Hub。

Alpha 第一阶段可以只实现增量 Upsert，但必须明确“暂未实现删除同步”而不是把 Hub 数据永久定义为归档。

撤销 Node 连接只阻止后续 Replication，默认不删除该 Node 已同步的历史数据；删除历史数据必须是独立显式操作。

### 12. Node 永远主动连接 Hub，Hub 不反向访问 Node

网络拓扑固定为：

```text
Node
  -> outbound HTTPS
  -> Hub Replication Surface
```

Node 不为 Hub 开放监听端口，不要求固定 IP、端口转发或公网地址。Hub 不通过该架构获得远程执行 Node 命令的能力。

### 13. Local HTTP Surface 与 Replication Surface 完全分离

现有 Web / `/api/v1/*` 继续保持 loopback 安全边界：

```text
surface-http
  -> 127.0.0.1:56789
```

Hub 新增独立网络入口：

```text
surface-replication
  -> HTTPS
  -> pairing / handshake / batch ingest / ACK
```

禁止为了 Hub 直接把现有无认证 HTTP Surface 从 `127.0.0.1` 改为 `0.0.0.0`。

Alpha Hub Web 默认仍只在 Hub 本机访问。远程 Web 登录、账号、Cookie、CSRF、RBAC 等属于独立能力，不由 Replication Surface 顺带承担。

### 14. Pairing 与长期认证分离

首次配对使用短期、一次性 Pairing Secret，仅用于授权一个 Node Identity。成功后 Pairing Secret 立即失效。

长期身份使用 Node 非对称密钥对，优先使用 Ed25519：

- Node Private Key 只保留在 Node；
- Hub 保存 Node Public Key；
- Hub 可单独撤销某个 Node；
- Hub 不保存可以直接冒充 Node 的长期明文密码。

### 15. Hub 使用 TLS，并支持自托管身份绑定

Hub Replication Surface 必须使用 TLS。

没有域名和公共 CA 的自托管场景允许 AgentLens 自动生成 Hub Identity / TLS Material。首次配对时 Node 显式绑定 Hub Public Key / SPKI Fingerprint，而不是盲目信任自签证书。

用户也可以配置由公共 CA 或自有 PKI 签发的正式证书。

证书续期不得无理由改变 Hub Identity；真正更换 Hub Identity Key 时必须明确执行轮换或重新配对流程。

### 16. mDNS 只负责发现，不负责建立信任

局域网自动发现可以在后续阶段通过 mDNS 等方式实现，但只回答“Hub 在哪里”。

Node 是否信任某个 Hub 仍由 Hub Identity Fingerprint + Pairing Secret 决定。Alpha 第一版可以完全不实现自动发现，使用显式 Hub 地址和配对信息。

### 17. Control Plane 不提供远程 Agent / 系统执行

Hub Control Plane 只管理：

- Pair / Register / Revoke；
- Node Status / Last Seen；
- Protocol Negotiation；
- Replication Diagnostics；
- Hub Identity。

1.0 Hub 不提供远程启动 Agent、执行 Shell、安装 Skill、修改 Hook、修改 Agent 配置等控制能力。

AgentLens 的产品定位继续是可观测与聚合，不转变为 Agent Orchestrator / Remote Management Platform。

### 18. 产品版本、Replication Protocol、Storage Schema 三者独立

分别维护：

```text
AgentLens Version       1.0.0-alpha.x
Replication Protocol   R1.x
Storage Schema          migration N
```

Node / Hub 网络兼容性由 Replication Protocol 决定，不通过比较 SQLite migration 或 AgentLens SemVer 得出。

Storage Migration 继续只处理本地数据库内部演进。

### 19. Replication 使用正式版本化 Wire Protocol

新增专用 Replication Protocol 边界。Wire DTO 不绑定 SQLite Schema。

Protocol 采用 Major / Minor：

- Minor 只允许向后兼容扩展；
- 破坏 ID、必填字段、Entity 语义、删除语义、签名语义等兼容性的变化必须升 Major。

Capability 只用于语义兼容的可选能力，不能用大量 feature flag 掩盖实际 Protocol Major 变化。

### 20. 连接前必须执行 Protocol Handshake

Node 与 Hub 先交换：

- Node / Hub AgentLens Version；
- 支持的 Replication Protocol Major / Minor 范围；
- 支持的可选 Capabilities。

双方选择共同支持的最高兼容版本后，当前连接固定使用该版本。

不兼容时明确暂停 Replication，不进行隐式有损降级。

### 21. 协议不兼容不得影响 Local-first

如果 Node 与 Hub 没有共同 Replication Protocol：

- Node 本地 Source 继续运行；
- Canonical Commit 继续运行；
- Local SQLite / Web 继续可用；
- 未同步数据保留在 Durable Outbox；
- UI / Diagnostics 明确提示需要升级 Node 或 Hub。

只有明确证明无损的版本转换才允许降级发送；不能通过丢弃新字段来假装同步成功。

### 22. 推荐先升级 Hub，再滚动升级 Node

Hub 在支持窗口内兼容当前和仍受支持的旧 Replication Protocol，使升级流程可以：

```text
upgrade Hub
  -> old Nodes continue with old protocol
  -> upgrade Nodes one by one
  -> remove obsolete protocol in a later release
```

不要求所有机器同时停机升级。

## 架构图

```text
                          AgentLens Hub
                 +---------------------------+
                 | Local Sources (optional)  |
                 |        |                  |
                 |        v                  |
                 | Canonical Store <---------+------ Remote Ingest
                 |        |                  |          ^
                 |   Projections             |          |
                 |        |                  |     HTTPS + Signature
                 | Local Web                 |          |
                 | 127.0.0.1:56789           |          |
                 +---------------------------+          |
                           ^                            |
                           |                            |
              +------------+------------+               |
              |                         |               |
           Node A                    Node B ------------+
        Local Sources             Local Sources
             |                         |
        Canonical DB               Canonical DB
             |                         |
        Durable Outbox             Durable Outbox
```

## Cordis 组合边界

目标 Composition Root：

```text
common
  storage-sqlite
  core-services
  projections
  capture-policy
  surface-http
  web

standalone
  common + sources/*

node
  common + sources/* + replication-client

hub
  common + sources/* + node-identity + replication-server

pure-hub
  common + node-identity + replication-server
```

Replication Client / Server、Node Identity、Replication Surface 必须作为 Cordis-native Runtime Extension 组合，不在 Cordis 外增加第二套 DI、生命周期或 Plugin Loader。

## Alpha 最小实现顺序

本 ADR 只锁架构，不表示以下能力已经实现。建议按顺序落地：

1. Role-driven Composition Root；
2. Persistent Node / Host Identity；
3. Replication Wire DTO + Handshake；
4. Durable Outbox / Cursor；
5. Hub Node Registry + Unified Canonical Store；
6. Transactional Remote Ingest；
7. Pairing / Node Key / Hub Identity / TLS；
8. Node 状态与同步诊断；
9. Projection / Protocol 增加 Host / Node Scope；
10. Web 多机筛选与设备视图；
11. Tombstone / 删除同步；
12. mDNS、远程 Web 等后续独立能力。

## 被拒绝的方案

### Node / Hub 拆成两套程序和两套 Runtime

拒绝。会重复 Core、Storage、Protocol、升级和发行边界，也违背当前 Cordis 组合式架构。

### Hub 作为唯一事实库，Node 退化为 Collector

拒绝。会破坏 Local-first，Hub / 网络故障将直接影响本机使用。

### Hub 只做联邦查询，不保存 Replica

拒绝。Node 离线后历史不可见，跨机排序、分页、Usage / Overview 聚合和 SSE 会持续复杂化。

### 直接同步 SQLite 数据库文件

拒绝。数据库锁、Schema Migration、版本错峰、文件损坏和冲突语义都无法形成稳定协议边界。

### Hub 重新 Commit Remote Canonical

拒绝。会形成 Node ID 与 Hub ID 两个世界，需要长期维护实体映射，并弱化 Node 作为事实产生者的语义。

### 同步 Projection DTO

拒绝。Projection 可重建，不得因为 Hub 成为第二事实源。

### 按 Node 分数据库

拒绝。会在 Storage 层重新制造联邦查询，破坏统一 Projection 的价值。

### 把现有 `/api/v1/*` 直接暴露给网络

拒绝。当前 Local Surface 依赖 loopback 且没有网络认证层；Replication 必须使用独立 Surface 与独立安全边界。

### Hub 反向连接 / 控制 Node

拒绝。会扩大网络攻击面并把产品带向远程管理 / Orchestration。

### 为 Alpha 先引入 PostgreSQL / Redis / Kafka

拒绝。当前目标是个人多机聚合，先用现有 Storage Contract + SQLite 验证真实规模；未来有基线证据再增加其他 Storage Plugin。

## 后果

正向后果：

- 保持 AgentLens Local-first 与离线可用；
- Node / Hub 共用一套 Core / Cordis / Storage / Projection / Web；
- Hub 可在远程 Node 离线时继续查询历史；
- Canonical Identity 在本机与 Hub 间稳定；
- Projection 不需要理解数据库分片或具体 Source；
- 网络认证、Web 登录和本机 API 安全边界彼此独立；
- 未来可扩展到 LAN、VPN / Tailscale、自建服务器而不改变事实模型。

代价：

- Hub 会保存远程 Canonical 数据副本；
- 需要 Durable Outbox、Node Registry、Replication Metadata 与冲突诊断；
- Pairing、TLS、密钥撤销和协议协商成为新的安全关键路径；
- 需要明确的数据删除 / Tombstone 与版本兼容策略；
- 多机能力的测试面明显大于普通本机功能。

## 验证标准

- Standalone 在没有 Hub 配置时行为与当前 1.0 一致；
- Node 在 Hub 完全不可达时仍可持续本地采集和查询；
- Hub 可以同时包含本机 Host 与多个 Remote Host；
- Remote Entity ID 在 Hub 中保持 Node 生成的 Canonical ID；
- 重复 Batch 不制造重复事实；
- Batch 引用或签名失败时事务回滚且 ACK 不推进；
- Node B 不能覆盖 Node A 的机器作用域实体；
- Shared Entity 冲突不会使用 last-write-wins 静默覆盖；
- Local HTTP 继续固定 loopback，Hub 网络入口独立；
- 未配对 / 已撤销 Node 不能上传数据；
- Protocol 不兼容只暂停 Replication，不阻断本机 Pipeline；
- Projection / Web 不把 Replication Metadata 当作 Canonical Agent 行为事实。

## 相关决策

- ADR-0001：AgentLens 1.0 Clean Rebuild 与 Cordis Runtime；
- ADR-0004：双发行、单运行时与生命周期；
- ADR-0005：Runtime Profile、Session Relationship 与 Asset Topology；
- ADR-0006：性能治理与架构护栏。
