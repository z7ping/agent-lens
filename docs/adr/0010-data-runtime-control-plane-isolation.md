# ADR-0010：Data Runtime 与 Daemon 控制面隔离

状态：Accepted
日期：2026-09-06
范围：AgentLens 1.0.0-alpha.3 稳定化 / 大库运行时
实施跟踪：GitHub Issue #68

## 背景

AgentLens 当前把以下能力放在同一个 Daemon Node 进程中：

- loopback HTTP / SSE；
- Pi Live 生命周期控制；
- Source History / Runtime Capture；
- Canonical Pipeline；
- Projection；
- SQLite `better-sqlite3`；
- Parser Replay 与存储维护。

SQLite 通过单个 `SqliteExecutor` 串行访问。该模型保证单连接事务语义简单，但 `better-sqlite3` 的单次 SQL 是同步执行；即使 Replay 已有分页、20ms 事务预算和前台空闲 Gate，一个长查询、`CREATE INDEX`、Projection rebuild 或新的维护 SQL 仍可能阻塞 Daemon 事件循环，使 Pi availability、Pi Start、Task Center 与 `/health` 一起变慢。

Issue #67 的限流、轻量 health、启动期零 Replay、延迟索引、Checkpoint CAS 和 Maintenance Job 是必要止血，但不能构成最终隔离边界。

## 决定

### 1. Daemon 成为 Control Plane

Daemon 只保留必须低延迟、必须在数据面故障时仍可响应的能力：

```text
AgentLens Daemon / Control Plane
  -> loopback HTTP / SSE
  -> Pi Live Runtime / Worker 生命周期
  -> Data Runtime IPC Client
  -> 常量级 /ready
  -> 最近一次 Data Runtime health/metrics 快照
  -> 降级状态与错误展示
```

Daemon 主事件循环不得直接执行重型 SQLite、Replay、Projection rebuild、压缩、清理或索引构建。

### 2. 独立 Data Runtime 持有 Data Plane

```text
AgentLens Data Runtime
  -> SQLite 唯一 Writer
  -> Canonical Pipeline
  -> Source History / Runtime Capture persistence
  -> Projection
  -> Maintenance Job
     -> deferred indexes
     -> parser replay
     -> source-record compression
     -> future retention / vacuum preparation
```

第一阶段允许通过 Node Worker Thread 建立隔离；若后续需要更强的崩溃边界，可保持同一 IPC Contract 切换到 Child Process。业务 Service Contract 不依赖具体传输方式。

### 3. IPC 是内部执行边界，不是第二业务模型

IPC 必须具备：

- 协议版本；
- requestId；
- request/response/error 三类消息；
- 单消息大小上限；
- 有界待处理请求数；
- 请求超时；
- 明确的 shutting-down / unavailable / protocol-mismatch 错误；
- health 与 metrics 快照；
- Worker crash 后拒绝新数据面请求并进入 degraded，不让 Daemon 随之退出。

IPC 不复制 Canonical Schema，也不把 transport event 当成新的事实源。

### 4. 单 Writer 是硬约束

进入 Data Runtime 迁移阶段后：

- 同一数据库只能由 Data Runtime 持有可写连接；
- Daemon 不再同时打开第二个 writable SQLite connection；
- 只读查询若需要独立连接，必须显式 `readonly`，并有 busy/timeout/查询预算；
- 迁移过程中不得出现“Daemon 写一部分、Worker 写一部分”的长期双写状态。

因此迁移按能力簇切换，而不是逐条 Repository 随机 RPC 化。

### 5. Maintenance Job 作为迁移桥梁

Schema 21 的 `maintenance_jobs` 是 Data Runtime 迁移前后共用的持久状态：

```text
pending -> running -> completed
        -> paused
        -> failed
```

Job 使用 revision/CAS，保存 priority、progress、error 和时间信息。Replay 自身继续使用 Source Checkpoint 保存细粒度游标；Job 负责“任务状态”，Checkpoint 负责“业务恢复位置”，两者不互相替代。

正式优先级：

```text
Pi / HTTP 前台
> 实时采集
> 最近历史增量
> Projection
> Deferred Index / Replay
> Compression / Cleanup
```

### 6. 渐进迁移顺序

1. 建立 Data Runtime IPC Client/Worker、health、ping、shutdown、crash 状态；
2. 先把 Maintenance Job 执行移入 Worker，验证长 SQLite 操作不阻塞 Daemon；
3. 再迁移 Projection rebuild；
4. 再迁移 History / Canonical 写入，形成唯一 Writer；
5. 最后收敛 Task Center 只读查询通道和查询预算；
6. 删除 Daemon 对 writable SQLite 的直接所有权。

在第 4 步完成前，本 ADR 视为“迁移中”，不得宣称真正的 Data Plane 隔离已经完成。

## 失败与降级

Data Runtime 初始化失败或崩溃时：

- Daemon 继续监听 HTTP；
- `/ready` 报告 Control Plane 是否在线，不执行数据库重查询；
- health 中标记 dataRuntime=`degraded/unavailable`；
- Pi Live 已运行任务的控制面不因数据面故障被强制终止；
- 依赖数据库的 Task Center 请求返回明确降级错误，不无限等待；
- Data Runtime 重启后从 Maintenance Job / Source Checkpoint 恢复，不从头扫描。

## 可观测性

Control Plane 与 Data Runtime 分别记录：

- IPC queue depth / wait / duration / timeout；
- SQLite queue wait P50/P95/P99；
- SQL/operation duration P50/P95/P99；
- transaction duration；
- Event Loop Lag；
- Maintenance Job state/progress；
- API P50/P95/P99；
- DB/WAL/冷存储增长。

跨边界请求必须能用 requestId 对齐，但默认不得记录敏感 payload。

## 非目标

- 不重写 Canonical 数据模型；
- 不把 Cordis Plugin 改造成进程 RPC 框架；
- 不在本 ADR 中自动 Purge/VACUUM；
- 不为了隔离而复制一套 SQLite 数据库；
- 不在迁移期保持长期双 Writer；
- 不以 Worker 化替代查询优化和容量治理。

## 验收条件

- Data Runtime 内执行可控长 SQL 时，Daemon Event Loop / Pi availability 仍可响应；
- Data Runtime 崩溃时 Daemon 不退出，并能展示 degraded；
- Maintenance Job 在 Worker 重启后从持久状态继续；
- 最终只有 Data Runtime 持有 writable SQLite；
- Replay、Projection、Compression 不再直接运行在 Daemon 主线程；
- Task Center 读路径具有稳定游标、查询预算和明确超时；
- 与 Issue #68 的阶段清单保持同步。
