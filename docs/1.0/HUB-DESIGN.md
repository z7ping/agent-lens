# AgentLens 1.0 Hub 设计

更新日期：2026-08-27  
状态：**Alpha 设计冻结，功能尚未实现**  
长期决策：`docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`

本文是 AgentLens Hub 的**长期系统设计主文档**。它只记录后续实现必须保持的长期语义与边界，不保存当前开发进度、逐阶段任务清单或逐条测试用例。

精确 Wire 语义见 `HUB-REPLICATION-PROTOCOL.md`；信任与配对见 `HUB-PAIRING-SECURITY.md`；真实生命周期与运维见 `HUB-OPERATIONS.md`。实现进度以 `agent-swe/work-state.yaml` 与实际代码、测试为准。

## 1. 目标与非目标

Alpha 目标：

```text
1 Hub
N trusted Nodes
single user
Local-first
Node -> Hub 单向复制
Hub 统一只读聚合
```

不包含：

- 多 Hub、HA、Federation、级联 Hub；
- Team / RBAC / 云账号；
- Hub -> Node Canonical Sync / Restore；
- Remote Agent / Shell / Hook / Skill 控制；
- 内建 Remote Web Login；
- PostgreSQL / Redis / Kafka 前置基础设施；
- 自动跨 Node Session 合并；
- 通过模糊名称 / 路径强行合并项目或资产。

## 2. Node 与运行形态

每个 AgentLens 数据根 / Runtime 实例都是一个持久 `Node` 身份。Node 不是与 Hub 互斥的领域角色，产品形态由能力组合得到：

| 形态 | localCapture | replicationUpstream | hubAccept |
| --- | --- | --- | --- |
| Standalone | true | false | false |
| 接入 Hub | true | true | false |
| Hub | true | false | true |
| Pure Hub | false | false | true |

Alpha 拒绝 `replicationUpstream && hubAccept`、纯转发节点和全 false 空 Runtime。

Node / Hub 共用同一个 AgentLensApplication、Cordis Runtime、发行物和默认数据根，不拆成 `agent-lens-node` / `agent-lens-hub` 两套程序。

## 3. Local-first 与事实归属

启用本机采集的每个 Node 始终独立执行：

```text
Native Source
 -> Capture Policy
 -> Normalize / Identity
 -> CanonicalObservation + Evidence
 -> Local Canonical Store
 -> Local Projection / Web
```

Hub、网络、TLS、Pairing、Protocol 失败不得阻塞这条本地链路。

事实归属：

```text
Local Node = Primary
Hub        = Replica + Aggregator
```

Hub 不重新运行 Claude / Codex / Pi / Hermes / OpenCode Parser，也不重新调用普通 `ObservationService.commit()` 猜远程事实。

## 4. Node Identity 与 Canonical Identity 分离

每个数据根初始化持久随机 `nodeId`，Node Key 与它共同形成 Replication 身份。hostname、platform、arch 只是可变元数据。

现有本机 `Host.id`、Project / Session 等 Canonical ID 规则不因 Hub 强制迁移。当前本机 ID 只保证单机语义，不直接作为跨机全局主键。

Node-scoped / Conditional Shared 的远程 origin 通过独立命名域形成 ReplicaKey：

```text
ReplicaKey = stable(
  'agentlens-replica-r1',
  nodeId,
  entityType,
  originEntityId
)
```

Hub 保留：

```text
originNodeId
entityType
originEntityId
ReplicaKey
```

ReplicaKey 与本机 `host-* / project-* / session-* / observation-*` 命名域必须显式隔离。

## 5. Entity Scope

Alpha 固定四类：

### Shared

天然有稳定跨机身份。Alpha 只有：

```text
AgentProduct
```

它形成一个逻辑 Shared Root，同时保留各 Node assertion provenance。

### Conditional Shared

Origin 仍属于具体 Node，但存在可靠 Portable Identity 时可进入 Shared Group：

```text
Project
AssetDefinition
```

### Node-scoped

默认类型。包括：

```text
Host
AgentInstallation
RuntimeProfile
Workspace
LogicalSession
SourceSession
SessionRelationship
AgentActor
SourceRecord
Evidence
CanonicalObservation
Coverage
AssetBinding
AssetStateObservation
ToolDefinition
```

`ToolDefinition` Alpha 不按名称跨机合并。

### Not Replicated

```text
Interaction
SessionRelationshipCandidate
SourceCheckpoint
SourceRuntimeStatus
Projection / Summary / Usage / Overview
Replication 自身 Control Plane 状态
```

默认原则：**任何新 Entity 未显式定义 Shared Identity Contract 时，一律 Node-scoped。**

## 6. Conditional Shared：保留 Origin，逻辑聚合

Project / AssetDefinition 不使用“改主键 + 批量重写 FK”的模型。

固定模型：

```text
Node A Origin ----\
Node B Origin -----+-> Shared Identity Group
Hub Local Origin --/
```

要求：

- 每个 origin 保留自己的 Local Canonical Row 或 Remote Replica；
- Workspace / Session / AssetBinding 等领域引用继续指 origin；
- SharedGroupKey 只标识聚合 Group，不成为 Conditional Shared 的领域 FK target；
- Promotion 只是建立 / 更新 Membership；
- Hub Local 与 Remote 使用同一 Membership 语义；
- 删除一个 origin 只撤回自己的 Membership，不影响其他成员。

这保证 Local-first、provenance 与现有 IdentityService 不被 Hub 反向污染。

## 7. Shared Identity

Shared Identity 必须显式定义：

```text
Identity Algorithm
Identity Fields
Merge Contract
Conflict Rules
```

Alpha：

```text
project-repository-v1
asset-upstream-v1
```

Project 只有可靠 Repository Identity 时加入 Shared Group；本机绝对路径 / repositoryRoot 不可作为跨机 Shared Identity。

Git Remote 规范化至少：

- 支持标准 URI 与常见 SCP-like Git Remote；
- 移除 userinfo / credential / query / fragment；
- hostname 小写；
- 去除尾部 `/` 与 `.git`；
- repository path 大小写仅在 Provider 语义允许时进一步规范。

Node 发送的 SharedKey 只是 assertion。Hub 必须按已协商算法自行 Normalize / 重算并验证，不能直接相信客户端提供值。

Shared Identity 算法变化可能改变 Group 结果，必须显式版本化并评估 Protocol 兼容性。

## 8. Capture Policy、Replication Policy 与 History Scope

三个边界分离：

```text
Capture Policy
  -> 什么最多可以进入 Local Canonical

Replication Policy
  -> 在 Local 已允许的范围内，哪些字段可以离开本机

History Scope
  -> Boundary 前已经存在的历史是否允许补传
```

Alpha Replication Policy：

| Policy | 主要语义 |
| --- | --- |
| metadata-only | 不发 Prompt / Tool 正文、SourceRecord payload；默认不发完整本机路径；仍会发送项目/仓库、Agent/Tool、时间和结构元数据 |
| redacted | 允许必要正文 / 路径，但强制凭据遮蔽、路径脱敏、限长 |
| full | 允许 Capture Policy 已保存的普通业务正文和必要路径；凭据仍强制遮蔽 |

`metadata-only` 不是匿名模式。

History Scope：

```text
from-now
include-existing
```

首次连接与后续扩大同步范围时必须让用户明确选择，连接 Hub 不等于授权全部历史。

## 9. from-now 与最小 Dependency Closure

`from-now` 不是简单：

```text
occurredAt >= pairingTime
```

而是建立持久 History Boundary：Boundary 前已经存在的普通历史事实不执行补传；Boundary 后新事实仍可带上建立引用图所需的旧依赖。

例如允许补：

```text
Host / Installation / Project / Workspace / Session / Actor / Asset identity 与必要 refs
```

但不能因此自动补：

```text
旧 Session title
非必要 startedAt / endedAt
完整 Workspace path
Prompt / Tool body
SourceRecord payload
```

远程表示需要区分：

```text
value
real null
redacted
omitted(policy)
omitted(not-captured)
omitted(history-boundary)
omitted(dependency-minimized)
```

Minimum Dependency Shape 按 Entity Type 注册并版本化测试，不由 Serializer 临时猜。

## 10. Durable Replication

正式可靠性语义：

```text
at-least-once
+ deterministic identity/hash
+ immutable in-flight Batch
+ contiguous Sequence / ACK
+ idempotent Import
+ Reconciliation
```

Cordis Event 只作为低延迟 fast path，不能成为唯一 Durable 事实源。

典型恢复：

```text
Local Canonical COMMIT
 -> 进程在 fast enqueue 前崩溃
 -> restart
 -> Reconciliation 扫描 Canonical State
 -> 修复待同步状态
```

普通可重建 pending state 不应复制成第二份完整本地数据库；只有已经可能发网、提交结果不确定的 immutable Batch 必须保留 exact retry Body。

Node-side Replication backlog 必须有独立磁盘上限和 backpressure。达到上限时暂停 Replication，不允许删除 Local Canonical Fact 腾空间。

## 11. Stream、ACK 与提交不确定性

Sequence / ACK 绑定：

```text
nodeId + replicationStreamId
```

同一 sequence 第一次可能发送后，Batch Body / contentHash 必须 immutable。

ACK 丢失或连接中断造成提交不确定时，只能 exact retry 或查询 Hub ACK；不能同 sequence 换 Body。

Policy 收紧遇到旧策略 ambiguous Batch 时：

```text
freeze old stream
 -> authenticated stream rollover
 -> new stream sequence=1
 -> reconcile under new policy
```

Stream Rollover 不等于 Node Identity Reset，也不必重新创建 Node。

## 12. Bootstrap、Reconciliation 与 Replica Generation

首次连接：

```text
Pair + Policy + History Scope
  |
  +-- include-existing
  |    -> resumable Bootstrap
  |    -> mandatory Reconciliation
  |
  +-- from-now
       -> persist History Boundary
       -> Reconciliation under boundary

then -> Incremental
```

Bootstrap 不是要求冻结数据库的瞬时快照；期间本地采集继续运行，完成后通过 Reconciliation 收敛。

普通 Reconciliation：

```text
absence != delete
```

显式 Re-bootstrap 使用 Replica Generation：

```text
G1 active
 -> G2 staged
 -> Bootstrap
 -> Reconcile
 -> Validate
 -> atomic activate G2
 -> retire G1
```

G2 未完成前 Unified Read 继续只读 G1。

所有来自该 Remote Node 的 Shared Identity State 都跟随 Generation staged / activate，包括 Conditional Shared Membership 与 Remote Shared Root assertion。Hub Local assertion 不属于 Remote Generation。

## 13. 删除、撤销与身份重置

三个动作不能混淆：

### Revoke

停止未来 Replication，默认保留历史与 Shared provenance。

### Delete Node History

显式高风险操作：按 originNodeId 删除该 Node Remote Replica，撤回它的 assertions / memberships，重算 Shared Groups；不能影响其他 Node / Hub Local origin。

### Node Identity Reset

生成新 nodeId + Node Key，清 upstream relationship / stream，但保留 Local Canonical 与现有 Canonical PK。重新接入原 Hub 会形成新的 Replica Namespace；Alpha 不自动跨 nodeId dedup。

删除事实使用持久 Tombstone。普通 scan absence 不表示删除。

## 14. Hub Storage Boundary

“一个 Hub Store”的正式含义：

```text
one Hub Storage Boundary / one default SQLite
│
├─ Local Canonical Store
├─ Remote Replica Store
├─ Shared Identity State
├─ Replication Control Plane
└─ Unified Read Repository
```

它不表示 Local 与 Remote 必须使用完全相同 SQL Row，也不允许按 Node 分 `node-a.db / node-b.db`。

原因是现有 Local Canonical Schema 存在真实必填字段，例如 Workspace path / SourceRecord payload；Replication Policy 又允许这些字段 omitted。Hub 不能用 `'' / [hidden] / {}` 之类假值塞进 Local Canonical 表。

所有 metadata-only / redacted / full 远程数据走同一个 Remote Replica Storage Contract，字段 availability 必须原生持久化。

Hub Local Canonical Schema 不因为可选 Hub 功能被全局 nullable 化。

## 15. Unified Read 与公开 ID

Hub Projection 不直接查询 Replica 私表，也不能把 Remote Replica 强制 cast 成完整 Local Core Entity。

正式读边界负责：

- 合并 Local Canonical + 当前 active Remote Generation；
- 解析 ReplicaKey / originNodeId / Shared Group；
- 保留字段 availability；
- 排除 staged / retired Generation；
- 支持 Node / Host / Shared Project filter；
- 为 Projection 提供稳定 opaque public ID。

公开 ID：

- Hub Local Entity：保持现有 Local Canonical ID；
- Remote Entity：使用 ReplicaKey；
- Shared Group：使用 SharedGroupKey，仅用于 Group / Filter / Aggregation；
- Web 不通过字符串前缀判断 scope，scope/origin 走 DTO。

两个 Remote Node 即使本机都存在 `session-abc`，在 Hub `/review/:logicalSessionId` 仍必须唯一定位。

## 16. Projection 与实时更新

Projection 必须 availability-aware：

- omitted 只能解释为“未同步 / 已隐藏”，不能解释为空字符串或来源没有数据；
- retained prior value 不能冒充当前 Policy Revision 刚确认的新值；
- `replicatedAt` 不覆盖 origin `occurredAt / capturedAt`；
- 跨 Node 时间只提供 deterministic best-effort 排序，不声称毫秒级因果全序。

Remote Import Commit 后需要独立的 Runtime invalidation，用于 Unified Read / Projection / SSE 刷新。它不是 Agent 行为事实，不进入 Canonical Observation，也不伪造成 Local `observation/committed`。概念上可使用 `replication/committed`。

## 17. Hub 本机与 Remote 的资源隔离

Hub 默认可以同时本机采集与接收 Remote Replica。

Remote Bootstrap / Reconcile / catch-up 必须有：

- 有界队列；
- 限制批次与事务大小；
- 并发 / 速率限制；
- backpressure；
- SQLite busy / storage pressure diagnostics。

Remote Import 不能长期占用 SQLite writer，导致 Hub 本机 Canonical Commit 饥饿。

Pure Hub 只表示停止未来本机 Source 采集，不删除既有 Hub Local Canonical 历史。

关闭 `hubAccept` 只停止 Replication Surface / 新上传，不默认删除 Remote Replica、Pairing relationship 或 Shared Identity State。

## 18. Remote Asset 与本机文件系统边界

Hub 可以展示 Remote Asset / AssetBinding，但这不代表 Hub 可以访问远程文件。

现有资产备份能力只能处理 Hub 本机实际可访问的 Local Asset。Remote `AssetBinding.path` 不得被传给本机 `readFile/copy/hash` 等文件操作，也不能把“同步到了资产元数据”宣传成“Hub 已备份远程资产文件”。

## 19. 用户可见语义

普通用户界面优先使用：设备、Hub、本机、远程设备、同步策略、历史范围、首次同步、同步校准、同步暂停、撤销连接、删除历史。

不要求用户理解 ReplicaKey、Stream、Generation、SharedGroupKey。

产品语义：

```text
项目   = 可靠 Portable Identity 汇聚出的跨设备逻辑 Group
工作区 = 某台设备的具体环境
```

Policy 隐藏路径时显示“工作区路径已隐藏”，不能显示假路径。

危险操作必须分开：

- 撤销连接；
- 删除设备历史；
- 重置本机设备身份；
- 同步校准；
- 重新构建 Hub 数据。

Hub 同步失败 / backlog / storage pressure 必须明确“本机采集仍正常”。

## 20. 安全与网络边界

高层边界：

- Local HTTP 继续只监听 `127.0.0.1:56789`；
- Replication 使用独立 authenticated HTTPS Surface；
- Node 只主动连接 Hub；
- Hub 不反向访问 Node；
- Pairing Secret 与长期 Key 分离；
- Node Identity、Hub Identity、TLS Identity 分离；
- Alpha 是 trusted-node 模型，不是远程证明系统；
- 不提供 Remote Execution。

详细密码学与密钥生命周期以 `HUB-PAIRING-SECURITY.md` 为唯一 Hub 安全权威文档。

## 21. 版本边界

以下版本独立：

```text
AgentLens Product Version
Replication Protocol R1.x
Storage Schema Migration
Shared Identity Algorithm Version
Replication Entity Version
```

没有共同 Protocol / 必需 Identity Algorithm / Entity Version 时只暂停 Replication，不阻塞本机 Source / Commit / SQLite / Web。

推荐升级顺序：先 Hub，再逐台 Node。

## 22. Alpha 冻结不变量

实现至少必须保持：

- 无 Hub 配置时 Standalone 行为不变；
- Hub 故障不阻塞本机 Canonical Pipeline；
- 两 Node 相同本机 ID 不发生 Hub 主键碰撞；
- Project / AssetDefinition Promotion 不改 origin FK；
- `from-now` 不被 Bootstrap / Reconciliation 绕过；
- Remote omitted 字段不被伪造成 Local Canonical 值；
- staged Generation 不进入正式查询；
- Remote Shared assertions 与 Membership 随 Generation 激活；
- Remote Import commit 后只产生 Replication invalidation；
- backlog / Hub 写入压力不破坏 Local Canonical；
- Remote Asset 不触发 Hub 本机文件备份；
- Revoke / Delete / Reset Identity 语义分离；
- Local Surface 不暴露网络；
- 不引入 Remote Control。

如果实现过程中出现问题，但不改变以上长期边界，优先在现有 Contract 内采用最简单实现。只有需要改变这些不变量时，才重新发起 ADR / Contract Review。
