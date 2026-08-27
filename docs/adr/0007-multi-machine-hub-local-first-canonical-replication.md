# ADR-0007：多机 Hub、Local-first 与 Canonical Replication

状态：Accepted / Alpha 设计冻结  
日期：2026-08-27  
范围：AgentLens 1.0 Alpha 多机 Hub

## 背景

AgentLens 1.0 当前是本地优先的 AI 编码 Agent 可观测工具。每台机器独立完成 Source 采集、Canonical Pipeline、本地持久化、Projection 与 Web / Desktop 展示。

多机需求希望在一台 Hub 上统一查看多台 Windows / macOS / Linux 设备的数据，但不能因此破坏已经成立的 1.0 架构：

- Canonical Observation / Evidence 仍由本机形成；
- 本机在没有 Hub 时仍完整可用；
- Cordis 仍是唯一 Runtime Plugin System；
- Projection 仍是可重建读模型；
- npm / Desktop 仍共用单一 Runtime / 数据根；
- AgentLens 仍是观测工具，不演变成远程控制平台。

当前有效设计细节见 `docs/1.0/HUB-DESIGN.md`。Wire、安全和运维分别由对应专项文档维护；本 ADR 只记录关键选择及原因。

## 主要驱动因素

1. **Local-first**：Hub 故障不能阻断本机采集与查询。
2. **事实所有权清晰**：原生 Source 只在本机解释一次，Hub 不重新猜事实。
3. **多机 ID 安全**：现有本机 Canonical ID 不保证跨机器全局唯一。
4. **隐私边界**：允许本机保存的数据，不代表一定允许上传 Hub。
5. **现有架构复用**：Node / Hub 应继续使用同一个 AgentLens Runtime / Cordis 组合方式。
6. **Alpha 可实现性**：先解决单用户、多设备、单 Hub，不提前承担 Federation / HA / RBAC 等复杂度。

## 实际考虑过的方案

### 方案 A：Node / Hub 两套程序

优点：职责表面清晰。

问题：会复制 Runtime、发行、生命周期和数据模型，后续极易形成两套实现。

结论：拒绝。

### 方案 B：Hub 成为唯一事实库

Node 只采集并把原始数据送到 Hub，由 Hub 统一解析和存储。

问题：破坏 Local-first；Hub/网络故障会影响本机；Hub 需要了解全部 Source Parser；事实形成位置发生改变。

结论：拒绝。

### 方案 C：Hub 只做联邦查询，不保存副本

优点：Hub 存储简单。

问题：离线设备不可查，跨机聚合稳定性和性能差，查询路径依赖所有 Node 在线。

结论：拒绝。

### 方案 D：同步 SQLite 文件或表行

优点：实现看似直接。

问题：把本地 Schema 变成网络协议，迁移与兼容困难，也无法正确表达隐私裁剪、ID 命名空间和跨机冲突。

结论：拒绝。

### 方案 E：同一 Runtime + Local Canonical + Canonical-state Replication

Node 先在本机形成 Canonical Fact，再按独立 Replication Policy / History Scope 向 Hub 复制授权后的状态；Hub 保存 Replica 并统一聚合。

结论：采用。

## 决定

### 1. 每个 AgentLens 实例都是 Node

Node 是持久实例身份，不是与 Hub 互斥的另一套程序。

Alpha 通过能力组合得到四种产品形态：Standalone、连接 Hub、Hub、Pure Hub。Node / Hub 共用同一 AgentLensApplication、Cordis Runtime、发行物和默认数据根。

### 2. Hub 是 Replica + Aggregator

```text
Local Node = Primary
Hub        = Replica + Aggregator
```

Node 永远先完成本机 Canonical Pipeline。Hub 不重新解析 Claude / Codex / Pi / Hermes / OpenCode 原生数据，也不通过普通 `ObservationService.commit()` 重新推断远程事实。

Hub、TLS、Pairing、Protocol 或网络失败只影响 Replication，不影响本机 Source / Commit / SQLite / Web。

### 3. Alpha 固定单 Hub 星型拓扑

一个 Node 最多连接一个 upstream Hub。

Alpha 不支持多 Hub、级联 Hub、Federation、循环复制或 Hub 间同步。

### 4. 本机 Canonical Identity 与跨机 Replication Identity 分离

现有本机 ID 不直接提升为 Hub 全局主键。

Remote origin 使用 `nodeId + entityType + originEntityId` 的确定性 Replica Namespace；Hub 保留 origin provenance。

现有 Host / Project / Session 等本机 Canonical ID 不因 Hub 强制整库迁移。

### 5. Shared Identity 是显式例外

默认 Entity 都是 Node-scoped。

Alpha：

- `AgentProduct` 可形成 Shared Root；
- `Project`、`AssetDefinition` 只有存在可靠 Portable Identity 时进入 Shared Group；
- Conditional Shared 保留各自 Origin，不通过“统一主键 + FK Rewrite”合并。

这样优先保留 provenance 和 Local-first，而不是追求数据库里“只有一行”。

### 6. Capture Policy、Replication Policy、History Scope 分离

```text
Capture Policy
 -> 什么可以进入 Local Canonical

Replication Policy
 -> 哪些字段允许离开本机

History Scope
 -> 是否允许补 Boundary 前已有历史
```

连接 Hub 不等于默认 full 内容 + 全历史同步。

### 7. Durable Replication 使用 at-least-once + Reconciliation

不追求复杂的分布式 exactly-once。

采用：

```text
at-least-once
+ immutable in-flight batch
+ sequence / ACK
+ deterministic identity/hash
+ idempotent import
+ reconciliation
```

Cordis Event 只作为低延迟 fast path；删除使用持久 Tombstone。

### 8. Hub 使用统一 Storage Boundary，但 Local Canonical 与 Remote Replica 不强制同表

Hub Alpha 仍优先一个 SQLite / Storage Boundary，但逻辑上区分：

```text
Local Canonical Store
Remote Replica Store
Shared Identity State
Replication Control Plane
Unified Read Repository
```

这是因为 Remote Replication 合法存在 `redacted / omitted` 字段，不能为了复用本机 NOT NULL Schema 而伪造空值。

### 9. Local Surface 与 Replication Surface 分离

现有 Web / API 继续只监听 loopback。

Replication 使用独立 authenticated HTTPS Surface，Node 只主动向 Hub 建立连接。

Alpha 不开放 Remote Web Login，不提供 Remote Shell / Agent / Hook / Skill 控制。

### 10. 安全采用显式 Pairing + 长期非对称身份

Pairing Secret 只用于短期用户授权；Node / Hub 各自拥有长期 Key；TLS Identity 与 Hub 产品身份分离。

Alpha 是 trusted-node 模型，不声称提供 Remote Attestation 或 Repository Ownership Proof。

## 长期影响

- Daemon Composition Root 需要支持 Node / Hub capability-driven plugin composition，而不是增加第二个 Runtime。
- Replication Protocol、Product Version、Storage Migration、Shared Identity Algorithm 必须独立演进。
- Hub Projection 需要通过 Unified Read 同时读取 Local Canonical 与 Remote Replica，并理解字段 availability。
- Remote Replica / Replication Control Plane 不进入 Canonical Observation。
- npm / Desktop 必须共享 nodeId、Pairing、Policy、History Boundary 与 Hub 状态，切换运行时 owner 不产生第二套多机身份。
- 未来若引入多 Hub、双向同步、Remote Control、Team/RBAC、强远程证明等能力，需要新的 ADR / Contract Review，而不是在 Alpha 设计上顺手扩展。

## 被明确拒绝的方向

- Node / Hub 两套发行程序；
- Hub 唯一事实库；
- Hub 重新运行 Source Parser；
- SQLite 文件 / Row 复制；
- Projection 作为同步事实源；
- 当前本机 Canonical ID 直接当跨机主键；
- Conditional Shared 统一主键并批量 Rewrite FK；
- 通用 last-write-wins；
- Local `/api/v1/*` 直接暴露网络；
- Alpha 多 Hub / Federation；
- Remote Execution。

## 关联文档

- `docs/1.0/HUB-DESIGN.md`：当前有效 Hub 系统设计；
- `docs/1.0/HUB-REPLICATION-PROTOCOL.md`：R1 协议长期语义；
- `docs/1.0/HUB-PAIRING-SECURITY.md`：Hub 安全与数据出站边界；
- `docs/1.0/HUB-OPERATIONS.md`：用户与运维生命周期；
- `ARCHITECTURE.md`：AgentLens 总架构摘要；
- `docs/1.0/IMPLEMENTATION-STATUS.md`：当前真实实现状态。
