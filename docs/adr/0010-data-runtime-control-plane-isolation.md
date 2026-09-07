# ADR-0010：Data Runtime 与 Daemon 控制面隔离

状态：Accepted / Implemented（真实大库验收中）
日期：2026-09-06
范围：AgentLens 1.0.0-alpha.3 稳定化 / 大库运行时
实施跟踪：GitHub Issue #68

## 背景

AgentLens 曾把 HTTP / SSE、Pi Live 生命周期、Canonical Pipeline、Projection、History / Replay、Maintenance 与同步 `better-sqlite3` 放在同一个 Daemon Node 事件循环中。第一阶段把 SQLite 移入 Data Runtime Worker 后，真实约 1.5GB 数据库继续暴露出第二层问题：单 Reader 仍是共享故障域，普通 query timeout 会拖垮其它前台读取，Maintenance 也可能在很短的交互空隙重新抢占数据库。

因此本 ADR 的最终实现不再是“1 Writer + 1 Reader”，而是明确的 Control Plane / Foreground Reader Pool / Maintenance Reader / Single Writer 四层边界。

## 决定

### 1. Daemon 是 Control Plane

```text
AgentLens Daemon / Control Plane
  -> loopback HTTP / SSE
  -> Pi Live Runtime / Pi Worker 生命周期
  -> Data Runtime IPC Clients
  -> constant /ready
  -> cached health / Event Loop metrics
  -> degraded / recovery orchestration
```

Daemon 主事件循环不直接持有 SQLite 连接，也不直接执行 Replay、Projection rebuild、SourceRecord Compression、清理或索引构建。

### 2. Data Plane 最终拓扑

正式文件数据库使用：

```text
Daemon / Control Plane
       │
       ├── Foreground Reader Pool
       │     ├── Reader A -> readonly SQLite
       │     └── Reader B -> readonly SQLite
       │
       ├── Maintenance Reader
       │     └── readonly SQLite
       │
       └── Writer
             └── 唯一 writable SQLite
```

Foreground Reader 负责 Task Center、facets、detail、relationships、usage、agents 等前台读。Reader Pool 优先选择 ready 且 pending 最低的 Worker，pending 相同时轮转。

Maintenance Reader 专门承接 Parser Replay scan、diagnostics、audit 等后台只读扫描，避免与前台 Reader 共队列。

Writer 负责 Schema migration、Canonical/Repository 写入、History persistence、Projection rebuild、Maintenance Job、Deferred Index、Compression 等所有写操作。

SQLite `:memory:` 是连接私有数据库，因此测试中的 `:memory:` 允许逻辑 Reader/Maintenance 复用 Writer Client；正式文件数据库使用独立 readonly Worker。

### 3. Single Writer 是硬约束

同一 AgentLens 数据库只允许 Writer Data Runtime 打开 writable SQLite。

- Daemon 不打开 writable SQLite；
- Foreground Reader / Maintenance Reader 使用 readonly；
- Schema migration 只由 Writer 执行；
- Repository mutation、事务、Projection rebuild 与写维护强制进入 Writer；
- 不允许长期双 Writer 或“Daemon 写一部分、Worker 写一部分”。

Cordis Service / Repository Contract 保持业务边界，IPC 只负责执行位置迁移。

### 4. IPC 与事务

Data Runtime IPC 使用版本化 request / response / error Contract，包含 protocolVersion、requestId、role、消息大小、pending 上限、timeout、health/metrics 与显式 transaction begin/commit/rollback。

Daemon 侧通过 `AsyncLocalStorage` 保存 transactionId，Writer Worker 中 `SqliteExecutor` 复用外部事务边界，保持：

```text
BEGIN IMMEDIATE
 -> 多个 Repository RPC
 -> COMMIT / ROLLBACK
```

IPC 不复制第二套 Canonical Schema，也不把 Transport Event 变成新的事实源。

### 5. timeout 与 liveness 必须分离

普通 SQL / IPC request timeout 是**请求级失败**：

- 只 reject 当前 request；
- 记录 timeout / slow-query 指标；
- 不 terminate 共享 Reader；
- 不把一个慢 SQL 扩散成其它请求的 500。

Worker 回收只由独立 heartbeat/liveness 负责。生产默认：

- heartbeat interval：5s；
- liveness timeout：15s。

只有 Worker 真正不响应、IPC 通道异常或 Worker crash 才进入 degraded + terminate/recovery。health 分别暴露 `timeouts` 与 `livenessFailures`。

### 6. 前台与 Maintenance 调度

调度优先级：

```text
Pi / HTTP Control Plane
> Realtime Capture / Writer foreground persistence
> Foreground Reader Pool
> Recent history incremental
> Projection maintenance
> Replay
> Compression / Cleanup
```

Maintenance Gate 默认至少等待 5 秒前台安静窗口，并同时检查：

- HTTP active；
- Foreground Reader pending；
- Writer pending。

任一前台负载存在时，不启动下一批 Maintenance。真正的执行隔离由 Worker 边界保证，Gate/批次时间预算负责防止 Data Plane 自身无界争用。

### 7. 容量策略必须先于扩张型维护

正式规则：

- 启动期 Parser Replay 固定为 0；
- 重索引不在 migration 中构建；
- Schema 17/18 历史 Projection 不在 migration 中全量回填；
- Capacity 必须在 Session Summary Projection rebuild 之前检查；
- `capacity=exceeded/unknown` 时 Projection rebuild、Backfill、Deferred Index、Replay 等扩张型维护暂停；
- Compression/Cleanup 仅作为低优先级减量维护，使用持久 cursor 和批次预算。

### 8. 前台查询必须使用物化/有界读模型

Worker 化不能代替查询优化。第二阶段同时确定：

- Task Center 首屏 20 条 + stable cursor；
- Session Summary 普通读不得重新扫描 observations/evidence/source_records 做历史纠错；
- facets 优先读取 SQLite `facetScope` 聚合结果并短期缓存；
- Tool Overview 默认走 Tool Fact summary-only 聚合，`detailLimit=0` 不计算 session/observation 排名；
- Tool Drawer 详情延迟到用户点击后再取有界样本；
- Agent Overview 按 source 聚合一次，不按 installation 重复执行相同重统计。

### 9. `/ready`、`/health` 与降级

- `/ready` 只表达 Control Plane 已监听，不访问数据库；
- `/health` 使用缓存 storage health，并合并 Writer / Foreground Readers / Maintenance Reader 状态；
- 数据面故障时 Control Plane 保持在线；
- Pi Control Plane 不依赖重 SQLite 查询；
- Worker 自动恢复；
- Reader crash 不应使 Writer 停止；Writer crash 时 Reader 可继续读取已提交数据。

### 10. Maintenance Job 是持久恢复边界

Schema 21 的 `maintenance_jobs` 是统一慢任务状态机：

```text
pending -> running -> completed
        -> paused
        -> failed
```

Job 保存 type/scope/priority/progress/revision/error/timestamps。Projection Backfill 和 Compression 按批持久 cursor；Parser Replay 使用 Source Checkpoint 保存更细粒度业务游标及 revision/CAS。

### 11. 可观测性

Control Plane / Data Runtime 暴露：

- Writer / 每个 Foreground Reader / Maintenance Reader state；
- request/completed/pending/maxPending；
- timeout 与 liveness failure；
- IPC duration P50/P95/P99；
- SQLite queue wait/execution/transaction P50/P95/P99；
- Daemon Event Loop Lag P50/P95/P99；
- Maintenance Job state/progress；
- DB/WAL/reclaimable bytes/capacity state。

默认不记录敏感 payload。

## 已完成迁移

- [x] D1：版本化 Data Runtime IPC Contract；
- [x] D2：Worker 生命周期、degraded 与自动恢复；
- [x] D3：重 SQLite 执行移出 Daemon 主线程；
- [x] D4：唯一 Writer；
- [x] D5：readonly 前台读路径；
- [x] D6：`/ready` 与 Data Runtime 解耦；
- [x] D7：事务、crash/recovery、基础隔离测试；
- [x] D8：源码/发行统一 `.mjs` Worker entry 语义；
- [x] D9：2 个 Foreground Reader + Maintenance Reader；
- [x] D10：普通 timeout 与 heartbeat/liveness 分离；
- [x] D11：5s Maintenance Gate + Reader/Writer pending + 容量前置；
- [x] D12（代码结构）：Task Summary/facets/Tool/Agent 前台查询收敛与防退化回归。

## 仍需验收

代码结构完成不等于性能门槛已通过。以下继续由 Issue #67/#68 跟踪：

- Reader saturation / max pending 大库场景；
- Maintenance + Foreground 并发；
- 约 1.5GB DB 下 Task Center / facets / tools / agents P50/P95/P99 与 failure-rate；
- Pi availability / Pi start 门槛；
- 源码 benchmark 与发行包行为一致性；
- 24h 狗粮稳定性与资源增长。

在真实大库重新满足门槛前，不把“架构代码已实现”表述为“发布验收已完成”。

## 非目标

- 不重写 Canonical 数据模型；
- 不把 Cordis Plugin 改造成通用业务 RPC 框架；
- 不自动 Purge / VACUUM / 删除索引；
- 不复制第二套 SQLite 数据库；
- 不靠增加 timeout / pending 上限掩盖慢查询；
- 不以 Worker 化替代查询优化、容量治理和真实大库验收。
