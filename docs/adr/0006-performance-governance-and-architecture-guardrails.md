# ADR-0006：性能治理与架构护栏

状态：Accepted  
日期：2026-08-26  
范围：AgentLens 1.0 性能治理 / Projection / Storage / Surface / Diagnostics

## 背景

AgentLens 1.0 已完成以 Canonical Observation + Evidence 为核心的 Clean Rebuild，并通过 Cordis 统一 Source、Storage、Surface 的运行时边界。随着 1.0 alpha 进入真实狗粮阶段，性能问题开始成为下一阶段重点：长会话、百万级 Observation、历史导入、实时更新、资产扫描与备份都可能随着数据增长产生退化。

性能优化如果直接绕过现有分层，容易重新制造 0.x 曾出现的耦合：页面直接依赖数据库、缓存成为第二事实源、运行诊断混入业务 Observation。这样即使局部变快，也会破坏 1.0 重构的核心价值。

因此，本 ADR 不规定某一条 SQL、缓存实现或阈值，而是约束性能优化允许发生的位置与事实边界。

## 决策

### 1. Web / Surface 不得为了性能绕过 Projection 直接访问 SQLite

正式读取链继续保持：

```text
Canonical Repository
  -> Projection / Reader
  -> Protocol / Surface
  -> Web / Desktop
```

性能问题必须优先在数据模型允许的层内解决，例如：

1. 查询计划与索引；
2. SQL / Repository 查询重构；
3. Projection 增量化或持久化；
4. 必要的只读缓存；
5. 前端窗口化、批处理和局部重渲染。

禁止：

- Web 直接打开 SQLite；
- HTTP Surface 为某个页面写 Source / Storage 专用旁路查询；
- 为了页面性能让 Protocol DTO 绑定数据库表结构；
- 让 UI 自行解释 Canonical Identity / Evidence / SessionRelationship。

### 2. 缓存和持久化 Projection 不得成为第二事实源

Canonical Observation、Evidence、Identity、Asset 等 Core 数据继续是事实来源。

任何为性能引入的缓存或持久化 Projection 必须满足：

- 可由 Canonical 数据重新生成；
- 删除缓存不会丢失事实；
- Source 不直接写缓存来绕过 Canonical Pipeline；
- 缓存失效不会改变事实语义，只影响性能或短暂的新鲜度；
- 一旦缓存结果与 Canonical 数据冲突，以 Canonical 数据为准。

允许示例：

```text
Canonical Observation
  -> Incremental Session Summary Projection
  -> Session List API
```

禁止示例：

```text
Source
  -> Session Summary Cache
  -> UI
```

### 3. Agent 行为事实与 AgentLens 自身性能诊断必须分离

以下属于 Canonical Observation / Evidence：

- 用户消息；
- 智能体消息；
- 工具调用与结果；
- 模型调用；
- 权限请求；
- 子智能体；
- 生命周期与上下文事件。

以下属于 Diagnostics / Operations：

- SQL 查询耗时；
- Daemon 启动耗时；
- Source 扫描耗时；
- SSE 队列长度；
- RSS / CPU；
- SQLite / WAL 大小；
- 缓存命中率；
- 性能基准结果。

性能诊断不得写成 Canonical Observation，也不得为了复用 Timeline UI 把 AgentLens 自身运行指标伪装成 Agent 行为。

Diagnostics 应独立演进，长期可聚合：

```text
Diagnostics
  +-- StorageHealth
  +-- SourceHealth
  +-- RuntimeHealth
  +-- HookHealth
  +-- BackupHealth
  +-- PerformanceHealth
```

Surface 负责组合展示，不要求所有诊断长期塞入 Storage Health。

### 4. 性能优化必须先有基线数据

除明显的复杂度错误或资源泄漏外，性能优化应具备优化前后的可重复测量结果。

优先记录：

- P50 / P95；
- 吞吐量；
- CPU / RSS；
- SQLite / WAL 体积；
- 扫描文件数 / 处理记录数；
- 查询计划。

不因为“感觉会更快”就引入持久化缓存、复杂并发或额外状态。

### 5. 优先级：索引 / 查询 > 增量 Projection > 缓存

数据库与 Projection 性能问题默认按以下顺序处理：

```text
EXPLAIN QUERY PLAN
  -> 索引与查询重构
  -> 增量 / 持久化 Projection
  -> 只读缓存
```

只有确认前一层无法在目标数据规模下满足预算，才进入后一层。

### 6. Source 性能优化不得破坏统一 Source Contract

History / Runtime / Asset Runner 不因性能问题按 Source 名称增加通用层特殊分支。

Source 自己可以优化原生读取方式，例如：

- 字节 offset；
- DB 游标；
- 文件指纹；
- 原生 sequence；
- Checkpoint；
- 有界并发。

但这些仍输出 SourceRecord / Candidate / Evidence，不能为某个 Source 建旁路事实表。

### 7. CI 只阻断数量级退化，完整基准独立运行

主 CI 应只加入轻量性能烟测，阻止明显数量级退化，例如：

- 查询从几十毫秒退化到数秒；
- 一次请求变成 N+1 千级查询；
- 内存出现明显无界增长。

百万级 / 大规模性能基准放在独立 Performance Workflow 或手动执行，不因 runner 抖动让普通提交频繁误报。

## 第一阶段性能对象

按影响优先级：

1. 会话列表摘要查询；
2. 长会话任务复盘；
3. Tool Analysis / Agent Overview 聚合；
4. Source 历史导入与后台扫描；
5. 资产 / 备份扫描。

第一阶段先建立会话摘要百万级基线，不提前决定是否新增持久化 Session Summary Projection。

## 被拒绝的方案

### Web 直接访问 SQLite

拒绝。短期可能减少一层调用，但会让页面绑定 Storage Schema，破坏 Protocol / Projection 边界。

### Source 直接更新页面缓存或统计表

拒绝。会形成第二条事实写入链，导致 Canonical Observation 与统计结果可能冲突。

### 把 AgentLens 性能指标写成 Observation

拒绝。运行诊断不是被观测 Agent 的行为事实，会污染 Timeline、统计与 Evidence 语义。

### 一开始就引入全局缓存层

拒绝。当前没有证据证明需要额外缓存基础设施；优先使用 SQLite 索引、增量 Projection 与前端局部更新。

## 验证标准

- Web / Desktop 不直接访问 SQLite；
- Projection / Reader 仍是正式读取边界；
- 新增缓存可被删除并从 Canonical 数据重建；
- 性能指标不进入 Canonical Observation；
- Source 性能优化仍通过统一 Contract 输出；
- 每项重要性能优化有优化前后基准；
- 性能测试不会迫使主 CI 承担大规模不稳定基准。
