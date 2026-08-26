# AgentLens 1.0 性能基线

状态：第二阶段完成  
日期：2026-08-26  
关联：ADR-0006

## 1. 目标

性能治理遵循“先测量、再定位、最后优化”。第一阶段先建立百万级基线并定位热点；第二阶段只对已经确认的热点实施优化，不以破坏 1.0 Core Contract、Canonical 事实源或 Cordis 生命周期边界换取性能。

架构护栏：

1. Web / Surface 不为性能绕过 Projection 直接访问 SQLite；
2. 缓存 / 持久化 Projection 不成为第二事实源，必须可由 Canonical 数据重建；
3. 性能与运行诊断不写入 Canonical Observation。

## 2. 基准规模

| 级别 | Session | Observation | Evidence | 用途 |
| --- | ---: | ---: | ---: | --- |
| S | 1,000 | 100,000 | 200,000 | 本地快速复现 |
| M | 10,000 | 1,000,000 | 2,000,000 | 1.0 正式基线 |
| L | 50,000 | 5,000,000 | 10,000,000 | 后续压力验证 |

当前以 M 为正式判断标准。L 不进入普通 CI。

## 3. 第一阶段对象

优先级：

1. 会话列表摘要查询；
2. 长会话任务复盘；
3. Tool Analysis / Agent Overview 聚合；
4. Source 历史导入与后台扫描；
5. 资产 / 备份扫描。

第一阶段确认会话列表摘要是第一个数据库热点：旧实现每次查询都会按 `logical_session_id` 聚合 Observation，并计算起止时间、Observation / 用户消息 / 工具 / 错误数量，同时查询首条用户消息、首条有效内容和来源集合。

## 4. 会话摘要基准

基准脚本：

```text
scripts/performance/session-summary-benchmark.ts
```

运行 M 级基线：

```bash
npm run perf:session-summary
```

快速运行：

```bash
npm run perf:session-summary -- --sessions=1000 --observations-per-session=100 --evidence-per-observation=2 --samples=10
```

脚本必须：

- 使用正式 SQLite migration；
- 使用正式 `SqliteSessionSummaryReader` 执行查询；
- fixture 只写临时数据库；
- 不通过 Source / Observation Service 制造百万级数据，避免把基准时间混入业务 normalization 开销；
- 记录 fixture 生成耗时；
- 记录数据库 / WAL 大小；
- 输出 Projection 重建耗时；
- 输出查询 P50 / P95 / min / max；
- 输出查询计划摘要；
- 结束后删除临时数据库；
- 不写入 AgentLens 正式数据目录。

## 5. 2026-08-26 M 级首轮结果

运行环境：GitHub Actions `ubuntu-24.04`，Node.js `22.23.0`。

数据规模：

```text
Session      10,000
Observation  1,000,000
Evidence     2,000,000
```

结果：

| 指标 | 实测 |
| --- | ---: |
| fixture 生成 | 29,992 ms |
| SQLite 数据库 | 941.4 MiB |
| 会话列表 20 条 min | 462.32 ms |
| 会话列表 20 条 P50 | 479.25 ms |
| 会话列表 20 条 P95 | 506.37 ms |
| 会话列表 20 条 max | 507.25 ms |

首轮 P95 相对 `< 100 ms` 软预算约慢 5 倍，确认属于需要治理的正式热点，而不是共享 runner 抖动。

主要查询计划信号：

```text
SCAN observations USING INDEX idx_observations_session
USE TEMP B-TREE FOR ORDER BY
CORRELATED SCALAR SUBQUERY
USE TEMP B-TREE FOR DISTINCT
```

第一阶段结论：

- Timeline 游标查询已有独立表达式索引，当前热点不是单 Session Timeline 分页；
- Session Summary 每次仍需对大范围 Observation 做会话聚合和排序，成本随 Canonical 数据量增长；
- `logical_sessions.started_at / ended_at` 当前不是 Observation commit 链维护的可靠派生字段，不能为了性能把它们直接当成最新会话事实源；
- 继续增加普通索引不能消除“每次重新聚合百万 Observation”的核心复杂度；
- 因此进入可重建、由 Canonical Observation 驱动的 Session Summary Projection，而不是让 Web / Surface 或 Source 绕过架构边界。

## 6. 第二阶段：持久化会话摘要 Projection

第二阶段落地链路：

```text
Canonical Observation
  -> observation/committed
  -> ProjectionService
  -> Session Summary Projection
  -> SQLite 可重建派生表
  -> SessionSummaryReader
```

实现约束：

- Canonical Observation 仍是唯一事实源；
- `session_summary_projection` 是可删除、可全量重建的派生状态；
- Source 不直接写摘要；
- Web / Surface 不直接访问 SQLite；
- 新 Observation 提交后按 `logicalSessionId` 刷新对应摘要；
- 同一 Session 的连续事件使用约 500 ms 去重窗口合并刷新；
- 老数据库启动后后台执行一次全量重建，不把数据库升级变成同步 HTTP 启动阻塞；
- Projection 尚未可用时保留旧查询作为冷启动兼容回退。

同时把原本只有 Contract、尚未正式接入 Cordis Context 的 `ProjectionService` 接入运行时，避免为这一项性能优化建立旁路机制。

## 7. 2026-08-26 M 级优化后结果

运行环境与首轮一致：GitHub Actions `ubuntu-24.04`，Node.js `22.23.0`。

数据规模：

```text
Session      10,000
Observation  1,000,000
Evidence     2,000,000
```

结果：

| 指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| SQLite 数据库 | 941.4 MiB | 945.7 MiB |
| Projection 行数 | - | 10,000 |
| Projection 全量重建 | - | 2,412.54 ms |
| 会话列表 20 条 min | 462.32 ms | 0.24 ms |
| 会话列表 20 条 P50 | 479.25 ms | 0.27 ms |
| 会话列表 20 条 P95 | 506.37 ms | 0.54 ms |
| 会话列表 20 条 max | 507.25 ms | 0.55 ms |

M 级会话摘要 P95 从 `506.37 ms` 降至 `0.54 ms`，约提升 `938x`，耗时降低约 `99.89%`，明显低于 `< 100 ms` 软预算。

优化后的查询计划：

```text
SCAN summary USING INDEX idx_session_summary_projection_recent
SEARCH logical USING INDEX sqlite_autoindex_logical_sessions_1 (id=?)
SEARCH installation USING INDEX sqlite_autoindex_agent_installations_1 (id=?)
SEARCH project USING INDEX sqlite_autoindex_projects_1 (id=?) LEFT-JOIN
SEARCH workspace USING INDEX sqlite_autoindex_workspaces_1 (id=?) LEFT-JOIN
```

关键变化：查询路径不再扫描百万级 Observation，也不再为会话排序建立临时 B-Tree。读路径成本主要随返回 Session 数量变化，而不再随全部 Observation 数量线性放大。

全量重建约 `2.41 s` 是重建可派生状态的后台成本，不进入日常会话列表查询关键路径。后续继续关注实际旧库首次升级体验，但不把这一结果混同于查询 P95。

## 8. 第一版性能预算

这些是软预算，不是最终 SLA：

| 指标 | M 级目标 | 当前结果 |
| --- | ---: | ---: |
| 会话列表 20 条 P95 | < 100 ms | **0.54 ms，通过** |
| 会话详情首屏 P95 | < 200 ms | 待测 |
| Tool Analysis P95 | < 500 ms | 待测 |
| Agent Overview P95 | < 500 ms | 待测 |
| Daemon Health Ready | < 2 s | 待测 |
| Web 新事件可见延迟 | < 500 ms | 待测 |
| 空闲 CPU | 接近 0 | 待测 |

预算不因为现状超标而修改；只有完成真实测量后才调整预算或实现。

## 9. 后续优化顺序

数据库热点统一按以下顺序处理：

```text
基准 + EXPLAIN QUERY PLAN
  -> 索引
  -> SQL / Repository 查询重构
  -> 增量 / 持久化 Projection
  -> 必要的只读缓存
```

会话摘要已经完成这一闭环。下一性能对象按优先级进入“长会话任务复盘”，继续先测量，不把 Session Summary 的 Projection 方案机械复制到其他页面。

任何新增持久化 Projection 都必须：

- 由 Canonical 数据驱动；
- 可全量重建；
- 删除后不丢失事实；
- 不允许 Source 直接写入；
- 不改变 Canonical Observation / Evidence 的身份与语义。

## 10. CI 策略

普通主 CI 不执行 M / L 基准。

分为：

```text
主 CI / Performance push
  -> smoke
  -> 只阻断数量级退化

独立 Performance Workflow
  -> workflow_dispatch 选择 S / M
  -> M 默认为手动基准规模
  -> 保存性能报告

L
  -> 后续专门压力验证
  -> 不进入普通 CI
```

性能工作流在 push 时保持 `smoke`；M 级通过 `workflow_dispatch` 手动运行或在明确的基准收口阶段临时执行，完成后必须恢复 `smoke`。不因为共享 runner 的亚毫秒级正常波动阻断普通开发。
