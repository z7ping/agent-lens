from pathlib import Path

path = Path('docs/1.0/PERFORMANCE-BASELINE.md')
text = path.read_text()

replacements = [
    (
        '状态：第四阶段首轮优化完成  ',
        '状态：Daemon 启动期负载首轮治理完成',
    ),
    (
        '性能治理遵循“先测量、再定位、最后优化”。当前已经完成会话摘要、长会话任务复盘、工具分析 / 智能体概览三类核心读路径的首轮治理。',
        '性能治理遵循“先测量、再定位、最后优化”。当前已经完成会话摘要、长会话任务复盘、工具分析 / 智能体概览三类核心读路径、Source 历史扫描与实时采集，以及 Daemon 启动期负载的首轮治理。',
    ),
    (
        '前三项已经完成首轮治理。下一阶段转入 Source 历史导入与后台扫描。',
        '前三项、Source 历史导入与后台扫描、Daemon 启动期重复 Projection 重建均已完成首轮治理。下一步只测量 History Sync、Projection 与 Asset Scan 的启动期资源竞争，再决定是否需要调度调整。',
    ),
    (
        '| Daemon Health Ready | < 2 s | 待测 |',
        '| Daemon Health Ready | < 2 s | **403.77 ms，通过**（M 级干净启动） |',
    ),
    (
        '''前三项核心读路径首轮治理已经完成。下一性能对象：

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
```''',
        '''核心读路径、Source 历史扫描和 Daemon 重复 Projection 重建已经完成首轮治理。下一性能对象不是直接改并发，而是先测量启动期资源竞争：

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

在没有竞争证据前，不改变现有调度和架构。''',
    ),
]

for old, new in replacements:
    if old not in text:
        raise SystemExit(f'target not found: {old[:80]!r}')
    text = text.replace(old, new, 1)

heading = '## Daemon 启动期负载治理（2026-08-26）'
if heading in text:
    raise SystemExit('Daemon startup section already exists')

text += '''

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
'''

path.write_text(text)
print('performance baseline updated')
