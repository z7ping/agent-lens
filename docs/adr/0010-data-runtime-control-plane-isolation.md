# ADR-0010：Data Runtime 与 Daemon 控制面隔离

状态：Accepted / Implemented
日期：2026-09-06
范围：AgentLens 1.0.0-alpha.3 稳定化 / 大库运行时
实施跟踪：GitHub Issue #68

## 背景

AgentLens 曾把 HTTP / SSE、Pi Live 生命周期、Canonical Pipeline、Projection、History / Replay、Maintenance 与同步 `better-sqlite3` 放在同一个 Daemon Node 事件循环中。

即使 Parser Replay 已经分页、限制单事务时长并在前台活跃时让路，只要一次同步 SQL、`CREATE INDEX`、Projection rebuild 或大范围聚合持续时间过长，仍会阻塞 Daemon 主事件循环，使 Pi availability、Task Center 与 `/health` 一起变慢。

Issue #67 的查询优化、轻量 health、启动期零 Replay、Checkpoint CAS 和 Maintenance Job 是必要止血；本 ADR 负责把同步 SQLite 从控制面彻底隔离出去。

## 决定

### 1. Daemon 是 Control Plane

Daemon 主线程保留必须低延迟、必须在数据面故障时仍可工作的能力：

```text
AgentLens Daemon / Control Plane
  -> loopback HTTP / SSE
  -> Pi Live Runtime / Pi Worker 生命周期
  -> Data Runtime IPC Client
  -> /ready
  -> Data Runtime health / metrics 快照
  -> 降级状态与自动恢复调度
```

Daemon 主事件循环不再直接持有 SQLite 连接，也不直接执行 Replay、Projection rebuild、SourceRecord 压缩、清理或索引构建。

### 2. Data Runtime 是 Data Plane

正式实现使用两个 Node Worker Thread：

```text
Daemon / Control Plane
       │
       ├── Reader Data Runtime
       │     └── readonly SQLite connection
       │
       └── Writer Data Runtime
             └── 唯一 writable SQLite connection
```

Writer Data Runtime 负责：

- Schema migration；
- Canonical / Repository 写入；
- History persistence；
- Projection rebuild；
- Parser Replay；
- Maintenance Job；
- Deferred Index；
- SourceRecord Compression；
- 其他显式写维护。

Reader Data Runtime 负责稳定只读查询，包括 Task Center / Unified Read / Usage 聚合等读路径。

SQLite `:memory:` 是连接私有数据库，因此测试 / 开发使用 `:memory:` 时 Reader 复用 Writer Client，避免产生两个互不可见的内存库；正式文件数据库始终使用独立 readonly Reader。

### 3. 单 Writer 是硬约束

同一 AgentLens 数据库只允许 Writer Data Runtime 打开 writable SQLite。

- Daemon 不打开 writable SQLite；
- Reader 使用 `readonly`；
- Schema migration 只由 Writer 执行；
- Repository mutation、事务和 Projection rebuild 强制进入 Writer；
- 不存在“Daemon 写一部分、Worker 写一部分”的长期双写模式。

Cordis Service / Repository Contract 保持原有业务边界，IPC 只负责执行位置迁移。

### 4. IPC Contract

Data Runtime IPC 使用版本化 request / response / error Contract，包含：

- protocolVersion；
- requestId；
- Worker role：writer / reader；
- 单消息大小上限；
- Pending request 上限；
- 前台读、普通写和 Maintenance 分级 timeout；
- Worker unavailable / timeout / protocol error；
- health / metrics；
- 显式 begin / commit / rollback 事务消息。

IPC 不复制第二套 Canonical Schema，也不把 Transport Event 变成新的事实源。

跨 Worker 的参数必须是结构化克隆安全 DTO。例如 Projection rebuild 的 `AbortSignal` 不跨 IPC 传输；Daemon 用 Job 生命周期 / Worker 生命周期负责取消，IPC 只传 `logicalSessionId` / `strategy` 等可移植字段。

### 5. 远程事务仍保持原子语义

Daemon 侧通过 `AsyncLocalStorage` 保存当前远程 transactionId，并串行 Writer 请求。

Writer Worker 中 `SqliteExecutor` 支持外部事务拥有者：

```text
BEGIN IMMEDIATE
 -> 多个 Repository RPC
 -> COMMIT / ROLLBACK
```

事务期间 Repository 内部再次调用 `executor.transaction()` 会复用已有事务，不重复 `BEGIN`。事务外的其他 Writer 请求不会插入当前事务边界。

### 6. Reader / Writer 隔离

普通读方法根据明确的 Read Method Contract 路由到 Reader，包括：

- get / list / query / find；
- summary / aggregate；
- health / diagnostics；
- overview / preview / verify / audit 等只读能力。

Mutation、Projection rebuild、Maintenance 和事务内调用进入 Writer。

前台 Data Runtime 读请求预算当前固定为 2 秒；超时返回数据面错误，不允许把前台请求无限挂在 SQLite 上。

Writer 内执行同步阻塞工作时，Reader Worker 和 Daemon 主事件循环仍然可以独立响应。

### 7. `/ready`、`/health` 与故障降级

Data Runtime 启动失败或 Worker 崩溃不会再让 AgentLens Daemon 退出。

- `/ready` 只表达 Control Plane 已监听，不执行数据库重查询；
- `/health` 合并 Data Runtime Writer / Reader 状态；
- 数据面不可用时返回 degraded，而不是让 health 自身变成 500；
- Pi Control Plane 继续在线；
- 依赖数据面的请求快速失败，不无限等待；
- Worker 自动尝试恢复。

Reader 崩溃时 Writer 可以继续存储；Writer 崩溃时 Reader 对已提交数据仍可继续提供只读能力，直到 Writer 恢复。

### 8. Maintenance Job 是持久恢复边界

Schema 21 的 `maintenance_jobs` 是统一慢任务状态机：

```text
pending -> running -> completed
        -> paused
        -> failed
```

Job 保存：

- type / scope / priority；
- progress；
- revision/CAS；
- error summary；
- started / completed timestamp。

Projection Backfill 和 SourceRecord Compression 按批持久化 cursor；Parser Replay 继续使用 Source Checkpoint 保存更细业务游标。

Worker 瞬态 unavailable / timeout 时，统一 Job Runner 会在同一次 Daemon 生命周期内重试，并重新读取最新持久 progress 后继续；非瞬态业务错误仍直接进入 failed。

### 9. 启动与容量策略

正式规则：

- 启动期 Parser Replay 固定为 0；
- 重索引不在 migration 中构建；
- Schema 17 / 18 的历史 Projection 不在 migration 中全量回填；
- 旧 Projection 历史通过可恢复 Maintenance Job 批量补齐；
- `capacity=exceeded` 或 `unknown` 时历史扩张、Projection Backfill、Deferred Index、Replay 全部暂停；
- `approaching` 时只允许有限近期历史，不跑全量 Replay；
- SourceRecord Compression 属于减量维护，可按主键 cursor 在前台空闲时继续，不依赖额外大索引。

这样即使 Data Runtime 恢复，也不会在一个已经超预算或容量未知的数据库上立即重新制造重负载。

### 10. 可观测性

Control Plane / Data Runtime 暴露：

- Data Runtime request / completed / timeout / pending / maxPending；
- IPC duration P50 / P95 / P99；
- SQLite queue depth / wait P50 / P95 / P99；
- SQLite execution duration P50 / P95 / P99；
- transaction duration；
- Daemon Event Loop Lag P50 / P95 / P99；
- Maintenance Job state / progress；
- DB / WAL / reclaimable bytes / capacity state。

默认不记录敏感 payload。

### 11. 调度优先级

```text
Pi / HTTP Control Plane
> 实时采集
> 最近历史增量
> Projection
> Deferred Index / Replay
> Compression / Cleanup
```

真正的隔离由 Worker 边界保证；前台 Idle Gate、批量预算和优先级仍保留，防止 Data Plane 自身出现无界争用。

## 已完成迁移

- [x] D1：Data Runtime IPC Contract；
- [x] D2：Writer / Reader Worker 生命周期、探活、终止、degraded；
- [x] D3：Maintenance 执行移入 Data Runtime；
- [x] D4：Projection / History / Canonical 写入进入唯一 Writer；
- [x] D5：独立 readonly Reader 与 Task Center 有界读路径；
- [x] D6：`/ready` 与 Data Runtime 解耦，Pi Control Plane 在数据面故障时继续在线；
- [x] D7：Worker crash/recovery、timeout/backpressure、事务、读写隔离与 Maintenance 恢复回归测试。

Daemon 对 SQLite 的直接所有权已删除；Data Plane 隔离不再处于“迁移中”。

## 验收边界

代码级回归已覆盖：

- Writer 同步阻塞时 Reader / Control Plane 隔离；
- Reader / Writer 崩溃后 degraded + 自动恢复；
- 远程事务 commit / rollback；
- 单 Writer；
- Projection / Compression cursor 恢复；
- Maintenance 瞬态故障续跑；
- Control Plane health 降级；
- Data Runtime 隔离性能基准入口 `perf:data-runtime-isolation`。

仍需真实大库 / 实机验收：

- 约 1.5GB 数据库下 `/health`、Pi、Task Center 的 P50 / P95 / P99；
- Replay / Compression 并行期间 Control Plane Event Loop Lag；
- 长时间狗粮稳定性与资源增长。

这些是发布验收，不再是未实现代码项。

## 非目标

- 不重写 Canonical 数据模型；
- 不把 Cordis Plugin 改造成通用 RPC 框架；
- 不自动 Purge / VACUUM；
- 不复制第二套 SQLite 数据库；
- 不以 Worker 化替代查询优化、容量治理和真实大库验收。
