# AgentLens 1.0 性能基线

状态：Daemon 启动期负载首轮治理完成
日期：2026-08-26  
关联：ADR-0006

## 1. 目标

性能治理遵循“先测量、再定位、最后优化”。当前已经完成会话摘要、长会话任务复盘、工具分析 / 智能体概览三类核心读路径、Source 历史扫描与实时采集，以及 Daemon 启动期负载的首轮治理。

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

前三项、Source 历史导入与后台扫描、Daemon 启动期重复 Projection 重建均已完成首轮治理。下一步只测量 History Sync、Projection 与 Asset Scan 的启动期资源竞争，再决定是否需要调度调整。

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
| Daemon Health Ready | < 2 s | **403.77 ms，通过**（M 级干净启动） |
| Web 新事件可见延迟 | < 500 ms | 待测 |
| 空闲 CPU | 接近 0 | 待测 |

预算不因为现状超标而修改；达到预算后也不继续为了跑分增加不必要复杂度。

## 11. 后续优化顺序

核心读路径、Source 历史扫描和 Daemon 重复 Projection 重建已经完成首轮治理。下一性能对象不是直接改并发，而是先测量启动期资源竞争：

```text
Daemon HTTP Ready（保持优先）
  -> History Sync 的 CPU / SQLite / 磁盘占用
  -> Session Summary Projection rebuild / reuse
  -> Asset Scan 的目录遍历 / Hash / SQLite 占用
  -> 三者是否在启动窗口发生有意义的竞争

测量后再决定
  -> 是否错峰
  -> 是否限并发
  -> 是否需要更细的增量策略
```

在没有竞争证据前，不改变现有调度和架构。

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

## Source 历史扫描与实时采集基线（2026-08-26）

这一阶段遵守 ADR-0006：Source 的检查点只用于增量读取与扫描跳过，不改变 Canonical Observation / Evidence 的事实来源。

### Pi

优化前，Pi Runtime 每 500ms 重新执行一次完整 `ingestPiHistory()`：递归枚举所有 JSONL、`stat` 每个文件，并为未变化文件重复读取 Session Metadata。50 个小会话的空转 P95 为 **37.05ms**。

第一轮优化后：

- `path + offset + size + mtime` 完全一致时，在读取 Session Metadata 前直接跳过；
- Session Header 从整文件 `readFile()` 改为最多读取前 64KB；
- 50 文件空转 P95：**37.05ms → 2.19ms**；
- 首次同步：**64.06ms → 32.23ms**。

M 级（2000 文件 / 42000 条记录）在“完整历史扫描入口、全部文件未变化”下：

- 首次同步：**1618.05ms**；
- 空转 P50：**85.05ms**；
- 空转 P95：**100.78ms**。

随后 Runtime 改为 `fs.watch` 优先 + 180ms 去抖，只处理变化文件；只有监听不可用/报错时才退回 **5s** 目录轮询。因此上述 M 级 100.78ms 代表历史同步/轮询兜底成本，不再是每 500ms 的常驻成本。

### DSH

历史同步新增文件状态检查点（`path + size + mtime`），并保留原来的 `sessionId + lastSeq` 语义检查点。未变化 `.jsonl/.jsonl.zst` 会在 `readFile`、Zstandard 解压和 JSON 解析之前跳过。

Smoke（50 会话 / 500 事件）：

- 首次同步：**42.11ms**；
- 空转 P50：**3.50ms**；
- 空转 P95：**3.66ms**。

M 级（2000 会话 / 40000 事件）：

- 首次同步：**1154.57ms**；
- 空转 P50：**58.95ms**；
- 空转 P95：**63.96ms**。

DSH Runtime 仍以文件监听为主；文件读取期间若发生再次追加，只有读取前后文件状态一致时才写文件状态检查点，避免把尚未处理的新字节误标为已扫描。

### Codex / Claude Code

两者原本已经按文件 offset / sequence 做内容增量，但未变化旧文件仍会进入后续读取路径。现在统一增加同样的文件状态快速判断：

`path 一致 && offset == size && size 一致 && mtime 一致 → 直接跳过`

其中 Codex 可因此避免对未变化文件重复读取最多 256KB 的 `session_meta` 预览；Claude Code 可避免在 EOF 上重复创建 JSONL 读取流。语义检查点与历史记录归一化逻辑均未改变。


## Daemon 启动期负载治理（2026-08-26）

这一阶段先测启动链路，没有先加缓存或改变架构。结论是：HTTP / Web 本身并不是热点，真正的高成本来自 HTTP 已可用后仍无条件执行 Session Summary Projection 全量重建。

基准脚本：

```text
scripts/performance/daemon-startup-benchmark.ts
```

正式 Performance Workflow 已增加 `daemon-startup`：push 默认执行 smoke；S / M 可按基准规模执行。基准区分：

- `unclean`：模拟上次未干净关闭，必须从 Canonical 重建 Projection；
- `clean`：已有完整 Projection 且上次干净关闭，应直接复用；
- `cycle`：先执行一次 unclean，再正常关闭并执行 clean 重启，验证真实关闭标记链路。

### 优化前测量

S 级（1,000 Session / 100,000 Observation）：

| 指标 | 实测 |
| --- | ---: |
| HTTP Health Ready | 358.70 ms |
| 重复 Projection 完成 | 1,111.15 ms |
| HTTP Ready 后后台额外时间 | 752.45 ms |

M 级（10,000 Session / 1,000,000 Observation）中，HTTP 已经成功启动，但重复 Session Summary Projection 在 **60 秒**超时窗口内仍未完成，证明问题不是“页面起不来”，而是启动后持续占用 CPU / SQLite / 磁盘。

后续同规模基准中，单次 M 级 Projection 全量重建实测为 **45,583.28 ms**。该数字是夹具预构建成本，不属于干净启动耗时，但说明“每次启动无条件再重建一次”本身就是数十秒级工作。

### 优化方案

没有新增事实源，也没有让 Web / Surface 访问 SQLite：

```text
Canonical Observation
  -> 可重建 Session Summary Projection
  -> 正常增量刷新
  -> 受控关闭前 flush
  -> 写入“本次 Projection 已追平”的运行检查点

下一次启动
  -> 先读取检查点
  -> 立即清除检查点，把当前进程标记为 dirty
  -> 检查 Projection 至少已物化
  -> 满足条件则复用
  -> 否则从 Canonical 全量重建
```

运行检查点为 `runtime / projection:session-summary:clean-v1`，只描述上一次**受控关闭时的派生数据就绪状态**：

- 进程启动后，在 Source 可以提交新 Canonical 数据之前立即清除；
- 只有 Session Summary 增量队列 `flush` 成功后才在受控关闭时重新写入；
- 崩溃 / 强杀 / 检查点缺失 / Projection 缺失 / rebuild 失败都会回退到 Canonical 全量重建；
- 检查点和持久化 Projection 均可删除，事实仍由 Canonical Observation 重建；
- 性能基准与运行就绪信息不写入 Canonical Observation。

HTTP-first 顺序没有改变。

### 优化后实测

S 级（1,000 Session / 100,000 Observation），同一次 `cycle` 同时验证保守重建和干净复用：

| 启动类型 | 行为 | HTTP Ready | Projection 决策完成 | HTTP Ready 后 |
| --- | --- | ---: | ---: | ---: |
| 非干净启动 | 全量重建 | 525.18 ms | 1,382.40 ms | 857.21 ms |
| 干净重启 | **复用** | **350.62 ms** | **953.42 ms** | **602.80 ms** |

M 级（10,000 Session / 1,000,000 Observation）干净启动：

| 指标 | 实测 |
| --- | ---: |
| HTTP Health Ready | **403.77 ms** |
| Projection 复用决策完成 | **906.54 ms** |
| HTTP Ready 后 | **502.77 ms** |
| 本次启动是否执行全量 Projection rebuild | **否** |

这里 `Projection 决策完成` 仍包含 Daemon 现有的约 600 ms 后台启动延迟；这轮没有为了跑分删除该延迟。治理目标是消除重复的数十秒级 Projection 计算和 SQLite / 磁盘负载，而不是把日志决策时间压到最低。

结论：

1. M 级 `Daemon Health Ready < 2 s` 预算通过；
2. 干净启动不再重复执行数十秒级 Session Summary 全量重建；
3. 非干净启动仍保守地从 Canonical 重建，正确性优先；
4. 架构护栏保持不变，没有引入第二事实源或 Surface → SQLite 快路径；
5. 下一步只测量 History Sync、Projection rebuild（仅需要时）与 Asset Scan 是否存在启动期资源竞争，未经测量不调整并发。
