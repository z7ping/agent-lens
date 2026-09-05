# AgentLens 1.0 存储维护与大库验收

本文记录 AgentLens 1.0 在大数据库场景下的 Parser Replay、SourceRecord 压缩、Retention/Purge、`VACUUM INTO` 与索引审计约束。

对应任务：#67。

## 1. 设计目标

存储维护的第一原则是：**前台可用性优先，破坏性操作显式执行。**

因此：

- Parser Replay 不再与普通历史同步重叠执行；
- 启动期只恢复近期 Replay；
- 7 天 / 全量 Replay 只在维护阶段运行；
- 大库超限时不会自动执行全量 Replay；
- SourceRecord 旧数据压缩允许后台空闲分批执行；
- Retention/Purge 不自动执行；
- `VACUUM INTO` 不自动替换当前数据库；
- 索引审计只报告候选，不自动删除索引。

## 2. Parser Replay

### 启动阶段

启动阶段只恢复最近会话，避免 Daemon 刚启动时立即扫描全部历史。

Replay 查询按旧 parserVersion 等值扫描，并使用：

```text
(source_id, installation_id, parser_version, captured_at, id)
```

专用索引与 `(captured_at, id)` 行值游标，避免历史实现中的临时排序。

### 维护阶段

7 天和全量 Replay 属于后台维护任务：

- `healthy`：允许 7 天和全量维护；
- `approaching`：只允许较小维护阶段，不执行全量 Replay；
- `exceeded` / `unknown`：暂停维护 Replay。

维护任务在前台 HTTP 活跃时等待；每个事务同时受记录数和时间预算约束。

### Checkpoint

Replay 状态持久化保存：

- target parserVersion；
- running / pending / completed；
- parserVersion + capturedAt + id 游标；
- completedAt。

Replay 中断后从最后实际成功处理的记录恢复。已完成任务可以快速跳过；如果又写入旧 parserVersion 数据，对应状态会重新标记为 pending/dirty。

## 3. `/health` 与 diagnostics

`/health` 只承担轻量健康检查：

- SQLite 基本可读性；
- schema version；
- Runtime 基础状态；
- Checkpoint 摘要；
- 数据库容量快照。

以下重统计不再放进普通 health：

- Unknown 聚合；
- Coverage 详情；
- 总量统计；
- 最近 7 天统计。

这些数据属于显式 diagnostics。

最近任务数直接读取 `session_summary_projection.ended_at`。

## 4. Unknown 与工具统计投影

### Unknown

Unknown 使用可重建成员投影，而不是单向累计计数。

因此 Parser Replay 将 Observation 从 `unknown` 修正为已识别类型时，旧 Unknown 成员会自动撤销；Evidence 解绑和 kind 变化也会同步维护。

### Tool Usage

工具聚合读取轻量事实投影，高频字段在 Observation 写入/更新时提取一次：

- tool name；
- call id；
- success；
- duration；
- asset type / asset name；
- session / installation / project / source 等关联字段。

任务详情仍读取完整 Observation，不牺牲原始信息。

## 5. SourceRecord 压缩

### 新数据

较大的 SourceRecord payload 使用 gzip BLOB 透明存储。Repository 对调用方仍返回原始 payload 对象。

小 payload 或压缩收益不足的数据继续使用普通 JSON。

### 旧数据

旧 `payload_json` 数据通过后台空闲维护逐批迁移：

- 每批数量受限；
- 每批之间重新等待前台空闲；
- 批间主动让出事件循环；
- 单批失败只记录错误，不应导致 Daemon 退出。

注意：**逻辑压缩不等于 SQLite 文件立即变小。**

SQLite 旧页需要后续通过受控 `VACUUM INTO` 才能真正形成更小的新数据库文件。

## 6. Retention / Purge

Retention 按完整 Logical Session 删除，不按单表时间直接截断。

默认行为是 dry-run。

正式删除前必须先确认候选 Session 列表。删除逻辑会同时处理：

- Observation；
- Interaction；
- Actor；
- Session relationship；
- Source session；
- 不再被其他 Observation 使用的 Evidence；
- 不再被其他 Evidence 使用的 SourceRecord。

共享 Evidence / SourceRecord 不应因为删除一个 Session 被误删。

当前不启用任何自动 Retention 周期，也不预设保留天数。是否需要 Retention，应先看 SourceRecord 压缩和 `VACUUM INTO` 后的真实体积。

## 7. `VACUUM INTO`

`VACUUM INTO` 只生成新的数据库文件，不替换在线数据库。

执行前：

1. 确保有足够磁盘空间容纳一份新库；
2. 选择一个不存在的目标路径；
3. 不要直接覆盖当前 `agent-lens.db`；
4. Windows 下还需要考虑 WAL/SHM 和文件占用。

执行后至少检查：

1. 新库文件存在且大小合理；
2. SQLite `integrity_check` 正常；
3. schema version 正确；
4. Session / SourceRecord / Observation 等关键总量符合预期；
5. 随机抽查 Task Center 会话详情；
6. 随机抽查 SourceRecord 压缩数据可以正常透明解压；
7. 再人工决定是否停止 Daemon 并替换正式数据库。

不得在 Daemon 在线状态下自动进行“生成后立即替换”。

## 8. 索引审计

索引审计当前只识别明显的：

- duplicate；
- prefix-covered。

审计结果只是候选，不代表可以直接删除。

删除前必须结合真实生产库：

- `EXPLAIN QUERY PLAN`；
- 高频查询路径；
- 查询耗时；
- 写入成本；
- 数据规模。

特别是 Parser Replay、任务时间线、工具聚合等专用索引，不允许仅因为“被另一个索引前缀覆盖”就自动删除。

## 9. 真实大库最终验收顺序

建议严格按以下顺序执行：

1. 升级数据库 schema；
2. 启动 Daemon，确认 `/health` 接近即时返回；
3. 验证 Pi 可用性检测和空会话列表；
4. 观察近期 Parser Replay；
5. 确认大库超限状态下没有自动全量 Replay；
6. 观察 SourceRecord 空闲压缩，不影响 Pi / Task Center；
7. 记录 `/health`、Pi、Task Center 的 P50 / P95 / P99；
8. 记录 Replay 吞吐、CPU 和磁盘占用；
9. 压缩完成后生成一次 `VACUUM INTO` 新库；
10. 校验新库完整性与实际空间收益；
11. 最后才根据真实查询计划决定是否删除冗余索引；
12. 只有空间仍不可接受时，才决定正式 Retention 策略。

## 10. 当前不能由代码替代的验收

以下项目必须在真实大库 / 实机完成，不能用单元测试代替：

- Replay 期间 Pi 可用性检测、Pi 空会话列表、Task Center、`/health` 的真实响应耗时；
- 真实数据库 SourceRecord 压缩比例和 CPU / IO 成本；
- `VACUUM INTO` 后的实际文件大小和完整性；
- 基于真实查询计划的索引删除决策。

在这些数据拿到之前，#67 应保持打开状态，不应把生产性能验收标记为完成。
