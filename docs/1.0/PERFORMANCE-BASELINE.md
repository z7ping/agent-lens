# AgentLens 1.0 性能基线

状态：第一阶段  
日期：2026-08-26  
关联：ADR-0006

## 1. 目标

性能治理遵循“先测量、再定位、最后优化”。第一阶段不提前引入缓存或持久化摘要表，先回答：当前实现随数据增长会在哪里退化、退化到什么程度。

架构护栏：

1. Web / Surface 不为性能绕过 Projection 直接访问 SQLite；
2. 缓存 / 持久化 Projection 不成为第二事实源，必须可由 Canonical 数据重建；
3. 性能与运行诊断不写入 Canonical Observation。

## 2. 基准规模

| 级别 | Session | Observation | Evidence | 用途 |
| --- | ---: | ---: | ---: | --- |
| S | 1,000 | 100,000 | 200,000 | 本地快速复现 |
| M | 10,000 | 1,000,000 | 2,000,000 | 1.0 第一阶段正式基线 |
| L | 50,000 | 5,000,000 | 10,000,000 | 后续压力验证 |

第一阶段以 M 为正式判断标准。L 不进入普通 CI。

## 3. 第一阶段对象

优先级：

1. 会话列表摘要查询；
2. 长会话任务复盘；
3. Tool Analysis / Agent Overview 聚合；
4. Source 历史导入与后台扫描；
5. 资产 / 备份扫描。

当前已确认会话列表摘要是第一个数据库热点候选：每次查询会按 `logical_session_id` 聚合 Observation，并计算起止时间、Observation / 用户消息 / 工具 / 错误数量，同时查询首条用户消息、首条有效内容和来源集合。

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
- 输出查询 P50 / P95 / min / max；
- 输出查询计划摘要；
- 结束后删除临时数据库；
- 不写入 AgentLens 正式数据目录。

## 5. 第一版性能预算

这些是软预算，不是最终 SLA：

| 指标 | M 级目标 |
| --- | ---: |
| 会话列表 20 条 P95 | < 100 ms |
| 会话详情首屏 P95 | < 200 ms |
| Tool Analysis P95 | < 500 ms |
| Agent Overview P95 | < 500 ms |
| Daemon Health Ready | < 2 s |
| Web 新事件可见延迟 | < 500 ms |
| 空闲 CPU | 接近 0 |

第一轮如果现状明显超预算，不直接修改预算来“通过”，先定位复杂度原因。

## 6. 优化顺序

会话摘要等数据库热点统一按以下顺序处理：

```text
基准 + EXPLAIN QUERY PLAN
  -> 索引
  -> SQL / Repository 查询重构
  -> 增量 / 持久化 Projection
  -> 必要的只读缓存
```

如果最终新增 Session Summary Projection，它必须：

- 由 Canonical Observation 驱动；
- 可全量重建；
- 删除后不丢失事实；
- 不允许 Source 直接写入；
- 不改变 Canonical Observation / Evidence 的身份与语义。

## 7. CI 策略

普通主 CI 暂不执行 M / L 基准。

后续分为：

```text
主 CI
  -> 小规模性能烟测
  -> 只阻断数量级退化

独立 Performance Workflow
  -> M / L 数据规模
  -> 手动或定时执行
  -> 保存性能报告
```

不因为共享 runner 的几十毫秒波动阻断普通开发。
