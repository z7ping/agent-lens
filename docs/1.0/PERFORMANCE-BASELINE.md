# AgentLens 1.0 性能基线

状态：第四阶段首轮优化完成  
日期：2026-08-26  
关联：ADR-0006

## 1. 目标

性能治理遵循“先测量、再定位、最后优化”。当前已经完成会话摘要、长会话任务复盘、工具分析 / 智能体概览三类核心读路径的首轮治理。

架构护栏：

1. Web / Surface 不为性能绕过 Projection 直接访问 SQLite；
2. 缓存 / 持久化 Projection 不成为第二事实源，必须可由 Canonical 数据重建；
3. 性能与运行诊断不写入 Canonical Observation。

统一优化顺序：

```text
基准 + EXPLAIN QUERY PLAN
  -> 索引
  -> SQL / Repository 查询重构
  -> 增量 / 持久化 Projection
  -> 必要的只读缓存
```

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

### 工具分析 / 智能体概览

| 级别 | Installation | Session / Installation | Tool Call / Session | Tool Observation | 用途 |
| --- | ---: | ---: | ---: | ---: | --- |
| smoke | 2 | 10 | 10 | 400 | 普通性能烟测 |
| S | 4 | 50 | 50 | 20,000 | 快速规模验证 |
| M | 6 | 100 | 100 | 120,000 | 1.0 正式基线 |

M 级工具夹具为 60,000 次 Tool Call，每次包含 `tool.call + tool.result`，并关联 120,000 条 Evidence。

当前正式判断以各对象的 M 级基准为准。L 不进入普通 CI。

## 3. 性能对象优先级

1. 会话列表摘要查询；
2. 长会话任务复盘；
3. Tool Analysis / Agent Overview 聚合；
4. Source 历史导入与后台扫描；
5. 资产 / 备份扫描。

前三项已经完成首轮治理。下一阶段转入 Source 历史导入与后台扫描。

## 4. 会话摘要：首轮基线

基准脚本：

```text
scripts/performance/session-summary-benchmark.ts
```

M 级数据：10,000 Session / 1,000,000 Observation / 2,000,000 Evidence。

优化前：

| 指标 | 实测 |
| --- | ---: |
| fixture 生成 | 29,992 ms |
| SQLite 数据库 | 941.4 MiB |
| 会话列表 20 条 P50 | 479.25 ms |
| 会话列表 20 条 P95 | 506.37 ms |

主要查询计划信号：

```text
SCAN observations USING INDEX idx_observations_session
USE TEMP B-TREE FOR ORDER BY
CORRELATED SCALAR SUBQUERY
USE TEMP B-TREE FOR DISTINCT
```

结论：会话摘要每次重新聚合大范围 Canonical Observation，普通索引无法消除随全库数据增长的核心复杂度。

## 5. 会话摘要：持久化可重建 Projection

落地链路：

```text
Canonical Observation
  -> observation/committed
  -> ProjectionService
  -> Session Summary Projection
  -> SQLite 可重建派生表
  -> SessionSummaryReader
```

约束：

- Canonical Observation 仍是唯一事实源；
- `session_summary_projection` 可删除、可全量重建；
- Source 不直接写摘要；
- Web / Surface 不直接访问 SQLite；
- 新 Observation 提交后按 `logicalSessionId` 刷新摘要；
- 同一 Session 连续事件使用约 500 ms 去重窗口合并刷新；
- 老数据库启动后后台全量重建，不阻塞 HTTP 首先可用；
- Projection 尚未可用时保留 Canonical 回退。

优化后 M 级：

| 指标 | 优化前 | 优化后 |
| --- | ---: | ---: |
| SQLite 数据库 | 941.4 MiB | 945.7 MiB |
| Projection 行数 | - | 10,000 |
| Projection 全量重建 | - | 2,412.54 ms |
| 会话列表 20 条 P50 | 479.25 ms | 0.27 ms |
| 会话列表 20 条 P95 | 506.37 ms | **0.54 ms** |

P95 约提升 `938x`，降低约 `99.89%`。

优化后的查询计划直接走：

```text
SCAN summary USING INDEX idx_session_summary_projection_recent
```

日常查询不再扫描百万 Observation。

## 6. 长会话任务复盘：基线

基准脚本：

```text
scripts/performance/review-detail-benchmark.ts
```

M 级：2,000 Interaction / 20,000 Observation / 20,000 Evidence。

优化前：

| 路径 | P50 | P95 |
| --- | ---: | ---: |
| 首屏正向分页 | 112.56 ms | 159.91 ms |
| 最新交互 | 114.51 ms | 127.09 ms |
| 错误筛选 | 221.10 ms | 235.91 ms |
| 高延迟筛选 | 222.37 ms | 241.24 ms |

Timeline 查询本身已经走：

```text
SEARCH observations USING INDEX idx_observations_timeline_order (logical_session_id=?)
```

真正热点是 `ReviewProjection.get()` 在分页前先通过 Session Projection 物化整段会话来生成顶部摘要，导致“只看 20 条首屏也先处理整个长会话”。

## 7. 长会话任务复盘：首轮优化

没有新增第二张持久化 Projection，而是复用已有 `session_summary_projection`：

```text
ReviewProjection.get(logicalSessionId)
  -> SessionSummaryReader 精确读取 logicalSessionId
  -> Timeline 只分页读取当前需要显示的交互
```

同时：

- “最新 / 向后分页”直接复用摘要中的 `interactionCount`；
- 如果目标会话刚产生、摘要仍处于约 500 ms 刷新窗口，只对该 `logicalSessionId` 临时执行 Canonical 精确聚合；
- 错误 / 高延迟筛选仍保留全会话扫描语义，不为当前已经达标的性能新增持久化 Projection。

优化后 M 级：

| 路径 | 优化前 P95 | 优化后 P95 | 变化 |
| --- | ---: | ---: | ---: |
| 首屏正向分页 | 159.91 ms | **29.50 ms** | 约快 5.4 倍 |
| 最新交互 | 127.09 ms | **31.94 ms** | 约快 4.0 倍 |
| 错误筛选 | 235.91 ms | **192.44 ms** | 降低约 18% |
| 高延迟筛选 | 241.24 ms | **181.13 ms** | 降低约 25% |

500 Observation 到 20,000 Observation 时，首屏仍保持同一数量级，说明首屏和最新已经摆脱分页前整会话物化的线性成本。

## 8. 工具分析 / 智能体概览：基线与热点

基准脚本：

```text
scripts/performance/tool-overview-benchmark.ts
```

初始实现存在两层放大：

1. `ToolAssetUsageProjection` 分别读取所有 `tool.call` 与 `tool.result`，完整 Observation Repository 还会加载 Evidence 引用并做额外元数据查询；
2. `AgentOverviewProjection` 对每个 Installation 重复调用完整 Tool Usage 聚合，即使页面最终只使用 `usage.assets`。

初始 smoke 查询计划还显示 `installationId + kind` 只命中 `kind` 索引，并需要临时排序。

第四阶段第一刀在 Storage 边界增加了工具聚合专用的轻量只读 Reader：

```text
Projection
  -> ToolUsageObservationReader
  -> Canonical observations + source/install metadata
```

它不是缓存或新事实源，只从 Canonical Observation 读取工具聚合真正需要的字段，并且：

- 不读取 Evidence 关联；
- 不为每条 Observation 再查询 SourceSession / Installation；
- 单页从 1,000 提升到 5,000；
- v6 增加按 `kind + timeline order` 与 `installation + kind + timeline order` 的组合表达式索引。

查询计划从临时排序改为直接走：

```text
SEARCH observations USING INDEX idx_observations_installation_kind_timeline_order (installation_id=? AND kind=?)
SEARCH observations USING INDEX idx_observations_kind_timeline_order (kind=?)
```

轻量 Reader + 索引后的 M 级结果：

| 路径 | P50 | P95 |
| --- | ---: | ---: |
| 单 Installation Tool Analysis | 88.29 ms | 113.34 ms |
| 全局 Tool Analysis | 614.13 ms | **669.60 ms** |
| Agent Overview（6 Installation） | 538.14 ms | **586.97 ms** |

索引已经正确命中，但全局聚合和 Overview 仍超过 `< 500 ms` 软预算。此时主要成本已从 SQLite 选行转为 Node 侧大批量对象物化与重复聚合。

## 9. 工具分析 / 智能体概览：流式聚合优化

第二刀继续保持既有架构，没有新增持久化表：

### 9.1 Tool Analysis

`ToolAssetUsageProjection` 从：

```text
全部 calls 装入数组
+ 全部 results 装入数组
-> 合并数组
-> 第一轮构建 call identity
-> 第二轮完整聚合
```

调整为：

```text
分页读取 tool.call
-> 边读边建立 call identity / tool / asset 聚合
-> 释放页面
分页读取 tool.result
-> 边读边关联并更新 tool 聚合
-> 释放页面
```

因此不再在 Node 中同时持有完整 call/result 两个大数组，也不再为 call 事件做重复全量扫描。

### 9.2 Agent Overview

Agent Overview 实际只消费 `usage.assets`。新增 Projection 内部的 `queryAssets()` 轻量路径，仅扫描 `tool.call` 并计算 MCP / Skill 等资产使用情况，不再额外计算：

- `tool.result`；
- success / error；
- duration；
- 工具 Session 明细；
- 不会被 Overview 使用的完整 Tool DTO。

这仍然是 Projection 对 Canonical Observation 的派生，不产生第二事实源。

### 9.3 优化后 M 级结果

运行环境：GitHub Actions `ubuntu-24.04`，Node.js `22.23.0`。  
规模：6 Installation / 600 Session / 60,000 Tool Call / 120,000 Tool Observation / 120,000 Evidence，SQLite 约 `99.9 MiB`。

| 路径 | 第一刀 P95 | 流式优化后 P50 | 流式优化后 P95 | 变化 |
| --- | ---: | ---: | ---: | ---: |
| 单 Installation Tool Analysis | 113.34 ms | 56.06 ms | **70.17 ms** | 降低约 38% |
| 全局 Tool Analysis | 669.60 ms | 385.65 ms | **425.71 ms** | 降低约 36% |
| Agent Overview（6 Installation） | 586.97 ms | 130.56 ms | **137.38 ms** | 约快 4.27 倍 |

三条路径均进入当前 `< 500 ms` 软预算。Agent Overview 的收益最大，因为去掉了原先为资产摘要计算大量无用 Tool Result / 会话统计的工作。

当前不继续为了追求更低数字新增工具持久化 Projection。后续只有在真实狗粮或更大规模数据表明全局 Tool Analysis 再次成为热点时，才评估增量可重建聚合。

## 10. 第一版性能预算

这些是软预算，不是最终 SLA：

| 指标 | M 级目标 | 当前结果 |
| --- | ---: | ---: |
| 会话列表 20 条 P95 | < 100 ms | **0.54 ms，通过** |
| 会话详情首屏 P95 | < 200 ms | **29.50 ms，通过** |
| 会话详情最新交互 P95 | < 200 ms | **31.94 ms，通过** |
| 会话详情错误筛选 P95 | < 500 ms | **192.44 ms，通过** |
| 会话详情高延迟筛选 P95 | < 500 ms | **181.13 ms，通过** |
| Tool Analysis P95 | < 500 ms | **425.71 ms，通过** |
| Agent Overview P95 | < 500 ms | **137.38 ms，通过** |
| Daemon Health Ready | < 2 s | 待测 |
| Web 新事件可见延迟 | < 500 ms | 待测 |
| 空闲 CPU | 接近 0 | 待测 |

预算不因为现状超标而修改；达到预算后也不继续为了跑分增加不必要复杂度。

## 11. 后续优化顺序

前三项核心读路径首轮治理已经完成。下一性能对象：

```text
Source 历史导入与后台扫描
  -> Checkpoint 是否真正增量
  -> 是否存在重复全量目录 / DB 扫描
  -> 多 Source 并发与磁盘 IO
  -> Daemon Ready 是否被历史同步阻塞

资产 / 备份扫描
  -> mtime / size 指纹
  -> Hash 重算策略
  -> inventory 增量更新
```

任何新增持久化 Projection 都必须：

- 由 Canonical 数据驱动；
- 可全量重建；
- 删除后不丢失事实；
- 不允许 Source 直接写入；
- 不改变 Canonical Observation / Evidence 的身份与语义。

## 12. CI 策略

普通主 CI 不执行 M / L 基准。

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
