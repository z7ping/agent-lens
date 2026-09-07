# AgentLens 1.0 存储维护与大库验收

本文记录 AgentLens 1.0 在大数据库场景下的 Parser Replay、Projection Backfill、SourceRecord 压缩、Retention/Purge、`VACUUM INTO` 与索引审计约束。

对应任务：#67；运行时隔离见 #68 / ADR-0010。

## 1. 设计目标

第一原则是：**前台可用性优先，破坏性操作显式执行。**

最终实现同时采用两层保护：

1. SQLite 全部进入 Data Runtime，Daemon / Pi / HTTP 控制面不再直接执行同步 SQLite；
2. Data Runtime 内仍保留容量门禁、持久 Job、批处理、前台 Idle Gate 与查询预算。

因此：

- 启动期 Parser Replay 固定为 0；
- Parser Replay 不再与普通 History Sync 重叠执行；
- 7 天 / 全量 Replay 只属于 Maintenance；
- 大库 `exceeded` / 容量 `unknown` 时禁止历史扩张、Projection Backfill、重索引和 Replay；
- Schema migration 不执行大表历史 Projection 回填和重索引构建；
- SourceRecord 旧数据压缩允许后台空闲分批执行；
- Retention/Purge 不自动执行；
- `VACUUM INTO` 不自动替换当前数据库；
- 索引审计只报告候选，不自动删除索引。

## 2. Data Runtime 隔离

正式运行时为：

```text
Daemon / Control Plane
  ├─ HTTP / SSE / Pi
  ├─ Reader Data Runtime
  │    └─ readonly SQLite
  └─ Writer Data Runtime
       └─ 唯一 writable SQLite
```

Replay、Projection rebuild、History / Canonical persistence、Compression 与 Deferred Index 都在 Data Runtime 内执行。

Reader Worker 独立提供只读查询；Writer 同步 SQL 不再直接阻塞 Reader 或 Daemon 主事件循环。

前台 Data Runtime 读请求当前预算为 2 秒；Data Runtime unavailable / timeout 会返回明确降级，不允许无限等待。

## 3. Parser Replay

### 启动阶段

**启动阶段不执行 Parser Replay。**

普通 `SourceHistoryRunner.sync()` 也不会隐式 Replay。Replay 只有明确的维护调度入口。

### 查询模型

Replay 按旧 `parser_version` 等值枚举，并使用：

```text
(source_id, installation_id, parser_version, captured_at, id)
```

专用复合索引与 `(captured_at, id)` 行值游标，避免旧实现的临时排序。

该专用索引属于 Deferred Index：migration 不在启动时构建大索引，由容量允许时的 Maintenance 创建。

### 维护阶段

- `healthy`：允许 7 天与全量 Replay；
- `approaching`：只允许较小 Replay，不执行全量；
- `exceeded` / `unknown`：Replay 全部暂停。

Maintenance 在前台 HTTP 活跃时等待；Replay 单事务同时受记录数与时间预算约束。

### Checkpoint

Replay 持久化保存：

- target parserVersion；
- pending / running / completed；
- dirty；
- parserVersion + capturedAt + id 游标；
- completedAt；
- revision/CAS。

中断后从最后实际成功处理的记录继续；已完成状态可快速跳过；旧 parserVersion 数据再次写入时会重新标脏。

## 4. Projection Backfill

Schema 17 Unknown Projection 与 Schema 18 Tool Usage Fact Projection 的表结构 / trigger 仍由 migration 建立，但 **migration 不再全量扫描历史数据做 backfill**。

旧历史改由持久 Maintenance Job 分批补齐：

- 每批有上限；
- 使用稳定 cursor；
- Job progress 每批持久化；
- Worker / Daemon 中断后可从 cursor 继续；
- `exceeded` / `unknown` 时暂停；
- 新写入数据仍由 trigger / 正常写路径实时维护 Projection。

这样升级大库时只执行必要 DDL，不在启动链路做历史大 JOIN / JSON 扫描。

## 5. `/ready`、`/health` 与 diagnostics

`/ready` 只表达 Control Plane 已经监听，不依赖数据库重查询。

`/health` 保持轻量并合并 Data Runtime 状态：

- SQLite 基本可读性；
- schema version；
- Source Runtime 基础状态；
- Checkpoint 摘要；
- DB / WAL / reclaimable bytes / capacity；
- Writer / Reader Data Runtime health / IPC metrics；
- Daemon Event Loop Lag。

Data Runtime 不可用时 health 返回 degraded，而不是自身变成 500。

以下重统计属于显式 diagnostics：

- Unknown；
- Coverage；
- 总量；
- 最近 7 天。

## 6. Unknown 与 Tool Usage Projection

### Unknown

Unknown 使用可重建成员投影，而不是单向累计。

Parser Replay 将 Observation 从 `unknown` 修正为已识别类型时，旧成员会撤销；Evidence 解绑和 kind 变化也会同步维护。

### Tool Usage

工具聚合读取轻量事实投影，高频字段在 Observation 写入 / 更新时提取一次：

- tool name；
- call id；
- success；
- duration；
- asset type / asset name；
- session / installation / project / source 等关联字段。

聚合读路由到 readonly Reader；详情仍可读取完整 Observation。

## 7. SourceRecord 压缩

### 新数据

较大的 SourceRecord payload 使用 gzip BLOB 透明存储。Repository 对调用方仍返回原始 payload。

小 payload 或压缩收益不足时继续使用普通 JSON。

### 旧数据

旧 `payload_encoding='json'` 数据通过 Maintenance 分批迁移。

当前批处理使用 **SourceRecord 主键 cursor**，不再为了压缩维护额外构建 `payload_encoding` 待办索引。

每批：

- 数量受限；
- 前台活跃时等待；
- 批间让出执行机会；
- 保存 cursor 与累计统计；
- Worker 瞬态失败恢复后从最新 progress 继续。

Compression 属于减量维护，因此即使数据库已经 `exceeded`，仍可以在受控前台空闲条件下继续。

注意：**逻辑压缩不等于 SQLite 文件立即变小。** 空闲页需要后续受控 `VACUUM INTO` 才会形成更小的新数据库文件。

## 8. Maintenance Job

Schema 21 的 `maintenance_jobs` 统一管理慢任务：

```text
pending -> running -> completed
        -> paused
        -> failed
```

保存 priority、progress、revision/CAS、错误与时间信息。

Data Runtime unavailable / timeout 等瞬态错误会有限重试，并重新读取最新持久 progress 后续跑；非瞬态错误直接 failed。

Job 与 Replay Checkpoint 分工：

- Maintenance Job：任务生命周期 / 优先级 / progress；
- Source Checkpoint：Replay 业务级精确恢复位置。

## 9. 容量策略

软阈值当前为 512 MiB。

History 扩张：

- `healthy`：最新 1、最近 10、7 天；
- `approaching`：仅最新 1 + 最近 10；
- `exceeded` / `unknown`：0 历史扩张。

Replay：

- `healthy`：7 天 + 全量；
- `approaching`：仅 7 天；
- `exceeded` / `unknown`：0 Replay。

Projection Backfill / Deferred Index：

- `exceeded` / `unknown`：暂停。

Compression：

- 属于减量型维护，可继续受控执行。

## 10. Retention / Purge

Retention 按完整 Logical Session 删除，不按单表 TTL 直接截断。

默认 `dryRun=true`。当前不启用自动 Retention，也不预设 30/60/90 天。

删除会覆盖关联 Observation、Interaction、Actor、Relationship、SourceSession，以及不再共享的 Evidence / SourceRecord。

是否需要正式 Retention，应先看 Compression + `VACUUM INTO` 后的真实体积。

## 11. `VACUUM INTO`

`VACUUM INTO` 只生成新数据库文件，不替换在线数据库。

执行后至少检查：

1. 文件存在且大小合理；
2. `integrity_check`；
3. schema version；
4. Session / SourceRecord / Observation 等关键数量；
5. Task Center 随机会话；
6. 压缩 SourceRecord 透明解压；
7. 再人工决定是否停止 Daemon 并替换正式库。

不得在线自动生成后立即替换。

## 12. 索引审计

索引审计只识别 duplicate / prefix-covered 候选，不自动删除。

删除前必须结合真实数据库：

- `EXPLAIN QUERY PLAN`；
- 高频查询路径；
- 查询耗时；
- 写放大；
- 数据规模。

Parser Replay、时间线、Projection 等专用索引不能仅因为“前缀可覆盖”就直接删除。

## 13. 可观测性与性能入口

当前可观察：

- Data Runtime IPC pending / maxPending / timeout；
- IPC duration P50 / P95 / P99；
- SQLite queue wait / execution / transaction P50 / P95 / P99；
- Daemon Event Loop Lag P50 / P95 / P99；
- Maintenance progress；
- DB / WAL / reclaimable bytes。

代码级隔离性能入口：

```bash
npm run perf:data-runtime-isolation
```

该基准验证 Writer 同步阻塞时 Reader 与 Control Plane 仍然可以响应，但不能替代真实 1.5GB 数据库验收。

## 14. 真实大库最终验收顺序

1. 升级 schema；
2. 启动 Daemon，确认 `/ready` 即时；
3. 检查 `/health` 中 Writer / Reader 状态；
4. 验证 Pi availability 与空会话列表；
5. 确认超限库没有 History 扩张、Projection Backfill、Deferred Index 或 Replay；
6. 观察 SourceRecord Compression；
7. 记录 `/health`、Pi、Task Center P50 / P95 / P99；
8. 记录 Event Loop Lag、Replay / Compression CPU / IO；
9. Compression 完成后执行一次 `VACUUM INTO` 到新文件；
10. 校验完整性与空间收益；
11. 用真实 `EXPLAIN QUERY PLAN` 决定索引收敛；
12. 只有空间仍不可接受时才决定 Retention 策略；
13. 完成长期狗粮稳定性验证。

## 15. 仍必须实机完成的验收

以下不能由单元测试替代：

- 约 1.5GB 真实数据库下 Pi / Task Center / `/health` 的 P50 / P95 / P99；
- 真实 Replay / Compression 期间的 Control Plane Event Loop Lag；
- SourceRecord 实际压缩比例与 CPU / IO；
- `VACUUM INTO` 实际收缩收益与完整性；
- 基于真实查询计划的索引删除决策；
- 长时间狗粮稳定性。

这些属于生产 / 发布验收，不再是未实现代码项。#67 与 #68 在这些验收完成前可以保持打开。