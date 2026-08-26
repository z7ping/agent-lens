# AgentLens 1.0 性能基线

状态：第三阶段首轮优化完成  
日期：2026-08-26  
关联：ADR-0006

## 1. 目标

性能治理遵循“先测量、再定位、最后优化”。第一阶段先建立百万级基线并定位热点；第二阶段只对已经确认的会话摘要热点实施优化；第三阶段进入长会话任务复盘，继续坚持先测量、不机械复制持久化 Projection 方案。

架构护栏：

1. Web / Surface 不为性能绕过 Projection 直接访问 SQLite；
2. 缓存 / 持久化 Projection 不成为第二事实源，必须可由 Canonical 数据重建；
3. 性能与运行诊断不写入 Canonical Observation。

## 2. 基准规模

### 会话摘要

| 级别 | Session | Observation | Evidence | 用途 |
| --- | ---: | ---: | ---: | --- |
| S | 1,000 | 100,000 | 200,000 | 本地快速复现 |
| M | 10,000 | 1,000,000 | 2,000,000 | 1.0 正式基线 |
| L | 50,000 | 5,000,000 | 10,000,000 | 后续压力验证 |

### 长会话任务复盘

| 级别 | Interaction | Observation | Evidence | 用途 |
| --- | ---: | ---: | ---: | --- |
| smoke | 50 | 500 | 500 | 普通性能烟测 |
| S | 500 | 5,000 | 5,000 | 本地快速复现 |
| M | 2,000 | 20,000 | 20,000 | 1.0 长会话正式基线 |

当前正式判断以各对象的 M 级基准为准。L 不进入普通 CI。

## 3. 性能对象优先级

1. 会话列表摘要查询；
2. 长会话任务复盘；
3. Tool Analysis / Agent Overview 聚合；
4. Source 历史导入与后台扫描；
5. 资产 / 备份扫描。

第一阶段确认会话列表摘要是第一个数据库热点；第三阶段确认任务复盘虽然对 Timeline 做了分页，但详情入口此前仍存在分页前的整会话派生工作。该公共前置成本已经在第三阶段首轮优化中消除。

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

## 5. 2026-08-26 会话摘要 M 级首轮结果

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

## 7. 2026-08-26 会话摘要 M 级优化后结果

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

## 8. 第三阶段：长会话任务复盘

基准脚本：

```text
scripts/performance/review-detail-benchmark.ts
```

M 级数据模型：单个逻辑会话包含 2,000 个交互，每个交互 10 条 Observation，共 20,000 Observation / 20,000 Evidence。夹具同时制造固定比例的工具错误与高延迟交互，用于覆盖四条真实读路径：

```text
首屏正向分页
最新交互
错误筛选
高延迟筛选
```

普通 push 使用 `smoke`；M 级只在明确基准阶段或手动性能工作流执行。

### 8.1 优化前 smoke 结果

规模：50 Interaction / 500 Observation / 500 Evidence。

| 路径 | P50 | P95 |
| --- | ---: | ---: |
| 首屏正向分页 | 22.35 ms | 27.49 ms |
| 最新交互 | 27.33 ms | 30.75 ms |
| 错误筛选 | 9.29 ms | 9.45 ms |
| 高延迟筛选 | 13.44 ms | 15.03 ms |

### 8.2 优化前 M 级结果

规模：2,000 Interaction / 20,000 Observation / 20,000 Evidence。SQLite 数据库约 `13.8 MiB`。

| 路径 | min | P50 | P95 | max |
| --- | ---: | ---: | ---: | ---: |
| 首屏正向分页 | 99.49 ms | 112.56 ms | **159.91 ms** | 159.91 ms |
| 最新交互 | 110.31 ms | 114.51 ms | **127.09 ms** | 127.09 ms |
| 错误筛选 | 215.29 ms | 221.10 ms | **235.91 ms** | 235.91 ms |
| 高延迟筛选 | 218.74 ms | 222.37 ms | **241.24 ms** | 241.24 ms |

Timeline 查询计划本身正常：

```text
SEARCH observations USING INDEX idx_observations_timeline_order (logical_session_id=?)
```

因此第三阶段首轮热点不是 Timeline 缺索引，而是 Projection 组合方式。

### 8.3 优化前结构性结论

此前 `ReviewProjection.get()` 在真正执行分页前，会先调用 `SessionProjection.queryEntries({ logicalSessionId })` 生成顶部会话摘要。该调用会把指定会话的全部 Observation 分块加载、排序、统计并构建全部 Interaction。

这意味着：

```text
用户只打开 20 条首屏
  -> 先物化整个长会话
  -> 再执行分页 Timeline
```

所以首屏虽然显示分页，关键路径仍包含 O(n) 的整会话派生成本。500 Observation 到 20,000 Observation 时，首屏 P95 从 `27.49 ms` 增至 `159.91 ms`，增长趋势与这一结构性问题一致。

“最新交互”除同样承担前置整会话摘要成本外，还需要计算总交互序号；“错误 / 高延迟”本身设计上需要扫描全会话交互描述符，因此其 M 级 P95 达到约 `236–241 ms`。

### 8.4 首轮优化方案

没有为任务复盘新增第二张持久化 Projection，而是复用第二阶段已经存在的 `session_summary_projection`：

```text
ReviewProjection.get(logicalSessionId)
  -> SessionSummaryReader 精确读取 logicalSessionId
  -> 复用 observationCount / interactionCount / toolCount / errorCount / 首条用户消息
  -> Timeline 只分页读取当前需要显示的交互
```

具体变化：

- `SessionSummaryReader.query()` 增加可选 `logicalSessionId` 精确条件；
- SQLite 稳态精确读取直接走 `session_summary_projection` 主键索引；
- `ReviewProjection.get()` 不再为了顶部摘要调用 `SessionProjection.queryEntries()` 物化整个会话；
- “最新 / 向后分页”的总交互数直接复用摘要中的 `interactionCount`，不再额外扫描全部用户消息计数；
- Timeline 分页实现和 `idx_observations_timeline_order` 保持不变；
- 如果目标会话刚产生、摘要行仍处于约 500 ms 的去重刷新窗口内，则仅对该 `logicalSessionId` 临时执行 Canonical 精确聚合，确保性能优化不造成“会话暂时不存在”的错误结果。

稳态摘要精确查询计划：

```text
SEARCH session_summary_projection USING COVERING INDEX sqlite_autoindex_session_summary_projection_1 (logical_session_id=?)
```

### 8.5 优化后 M 级结果

同样规模：2,000 Interaction / 20,000 Observation / 20,000 Evidence。任务复盘基准在执行前使用正式 `sessionSummaryProjection.rebuild({ logicalSessionId })` 建立生产态派生数据；单会话摘要重建约 `67.41 ms`，该重建属于派生状态维护成本，不进入稳态详情请求关键路径。

| 路径 | 优化前 P95 | 优化后 P50 | 优化后 P95 | 变化 |
| --- | ---: | ---: | ---: | ---: |
| 首屏正向分页 | 159.91 ms | 25.29 ms | **29.50 ms** | 约快 5.4 倍 |
| 最新交互 | 127.09 ms | 21.92 ms | **31.94 ms** | 约快 4.0 倍 |
| 错误筛选 | 235.91 ms | 173.71 ms | **192.44 ms** | 降低约 18% |
| 高延迟筛选 | 241.24 ms | 169.98 ms | **181.13 ms** | 降低约 25% |

首屏从 500 Observation 的优化后 smoke P95 `22.39 ms` 到 20,000 Observation 的 M 级 P95 `29.50 ms`，数据量增长 40 倍但仍处于同一数量级；“最新”也从 smoke P95 `21.17 ms` 到 M 级 `31.94 ms`。这说明首屏和最新的公共关键路径已经摆脱“先处理整个会话”的线性成本，主要成本重新由当前页物化决定。

错误 / 高延迟筛选也因为公共前置整会话物化被移除而下降，但其自身仍按设计扫描全部交互描述符，所以仍属于 O(n) 路径。当前 P95 约 `181–192 ms`，明显低于 `< 500 ms` 软预算，第三阶段暂不为它们继续新增持久化 Projection；后续只有在真实狗粮或更大规模基准显示有必要时，再独立治理。

## 9. 第一版性能预算

这些是软预算，不是最终 SLA：

| 指标 | M 级目标 | 当前结果 |
| --- | ---: | ---: |
| 会话列表 20 条 P95 | < 100 ms | **0.54 ms，通过** |
| 会话详情首屏 P95 | < 200 ms | **29.50 ms，通过** |
| 会话详情最新交互 P95 | < 200 ms | **31.94 ms，通过** |
| 会话详情错误筛选 P95 | < 500 ms | **192.44 ms，通过** |
| 会话详情高延迟筛选 P95 | < 500 ms | **181.13 ms，通过** |
| Tool Analysis P95 | < 500 ms | 待测 |
| Agent Overview P95 | < 500 ms | 待测 |
| Daemon Health Ready | < 2 s | 待测 |
| Web 新事件可见延迟 | < 500 ms | 待测 |
| 空闲 CPU | 接近 0 | 待测 |

预算不因为现状超标而修改。当前任务复盘四条路径均在预算内；已经确认并能低风险消除的首屏 / 最新结构性浪费已处理完，错误 / 高延迟不为了追求更低数字而过度设计。

## 10. 后续优化顺序

数据库热点统一按以下顺序处理：

```text
基准 + EXPLAIN QUERY PLAN
  -> 索引
  -> SQL / Repository 查询重构
  -> 增量 / 持久化 Projection
  -> 必要的只读缓存
```

会话摘要和长会话任务复盘首轮治理均已完成。下一性能对象转入 Tool Analysis / Agent Overview 聚合，仍从正式基准和查询计划开始，不预设一定需要新 Projection。

错误 / 高延迟筛选保留为观察项：它们仍扫描整会话描述符，但当前 M 级明显低于预算，因此不阻塞 1.0 稳定化。

任何新增持久化 Projection 都必须：

- 由 Canonical 数据驱动；
- 可全量重建；
- 删除后不丢失事实；
- 不允许 Source 直接写入；
- 不改变 Canonical Observation / Evidence 的身份与语义。

## 11. CI 策略

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

性能工作流在 push 时保持 `smoke`；M 级通过 `workflow_dispatch` 手动运行或在明确的基准收口阶段临时执行，完成后必须恢复 `smoke`。不因为共享 runner 的正常波动阻断普通开发。
