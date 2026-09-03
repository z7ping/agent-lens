# AgentLens 1.0.0-alpha.3 Task Surface 实现状态

更新日期：2026-08-30
状态：实现收口 / Draft PR #32 / 未发布

本文只记录 1.0.0-alpha.3 的两个核心目标：

1. 任务复盘长会话交互与性能；
2. Pi Live 作为 Pi TUI 替代体验的运行时与 Web Task Surface。

不改变 `docs/1.0/IMPLEMENTATION-STATUS.md` 中其他 1.0 / Hub 能力的既有状态。

> 当前 HEAD、ahead/behind、某次 GitHub Actions Run 与具体性能数字属于 **Repository Reality**，必须从 GitHub / Actions 实时读取。本文只记录已经进入正式实现的能力、尚未完成的门禁和稳定架构边界，避免下一次提交后状态文档立即漂移。

## 1. Task Review 长会话

已实现：

- `VirtualRoundMount` 对轮次进行近屏挂载、远屏卸载；
- 卸载重子树后保留实测高度，减少滚动位置跳变；
- 保留 `interactionId` anchor，Turn Rail / 定位语义不因卸载丢失；
- 当前焦点仍位于轮次内部时不执行卸载；
- 会话详情分页、历史阅读位置恢复、最新记录跟随规则继续保持；
- 用户浏览历史时，新记录不得强制抢滚动。

当前正式预算参数：

```text
root margin    = 1400px
unmount delay  = 320ms
```

自动化已建立 1000 轮虚拟窗口预算门禁，用于限制同时挂载的 Review 重子树数量。

该门禁验证的是正式参数驱动的**重子树挂载窗口预算**，不等同于真实浏览器 DOM / React 节点数量实测。真实浏览器滚动流畅度、DOM 数量和内存趋势仍属于实机验收。

## 2. Pi Live 架构边界

### 2.1 事实观测与主动控制分离

`@agent-lens/source-pi` 继续拥有 Pi 的事实观测：History、Runtime Tail、Assets、Canonical Observation / Evidence。

Pi Live 主动控制属于 `@agent-lens/runtime-cordis`：

```text
source-pi
  -> observation only

runtime-cordis / piLive
  -> active Pi process ownership
  -> prompt / steer / follow-up / abort
  -> snapshot / live event transport
```

Pi Live 不把控制状态写成 Canonical Observation，也不形成第二事实源。

### 2.2 Runtime 决策

ADR-0009 已取代 ADR-0008。alpha.3 的目标运行时边界为：

```text
AgentLens Daemon
  -> 独立 Pi Runtime Worker
     -> 用户实际 Pi SDK
     -> createAgentSessionServices()
     -> createAgentSessionRuntime()
```

当前代码已进入 Worker 迁移阶段：Start 先返回 `initializing` Runtime，用户 Pi SDK、资源、Extension 与 `AgentSession` 在独立 Node Worker 内后台加载。支持 Services API 的 Pi 版本使用 `createAgentSessionServices()`、`createAgentSessionRuntime()` 与 `createAgentSessionFromServices()`；受支持的旧版本保留 Worker 内兼容创建链，不退回 Daemon 内执行。

目标实现同时保持：

- 使用用户实际 Pi 配置与资源；
- Pi Runtime / Extension 与 AgentLens Daemon 进程隔离；
- Browser View 生命周期不拥有任务生命周期；
- 官方 `AgentSessionRuntime` 语义直接驱动 Session；
- Start API 与完整 Session 初始化解耦。

详细阶段和证据要求见 `ALPHA3-PI-RUNTIME-WORKER-CHECKLIST.md`，公开实施由 GitHub Issue #51 跟踪。

## 3. Pi Live Runtime

现有 Service Contract 已实现：

- 用户 Pi 可执行入口、npm 包与 SDK compatibility 定位；
- SDK 动态导入 Promise 预热与复用；
- `SessionManager.create/open`；
- `AgentSession` 事件订阅与 Pi Live Wire Event 映射；
- Session Entries / Leaf ID Snapshot；
- Prompt；
- Steer；
- Follow-up；
- Clear Queue；
- Abort；
- Extension UI Bridge 与原始 Request ID response；
- Model / Thinking Level 查询与切换。

生命周期明确分为：

```text
Abort Task       != Terminate Runtime
Close View       != Abort Task
Close View       != Terminate Runtime
Terminate Runtime = 显式释放 AgentLens 所持有的 Pi Session
目标 Worker 完成后 = 同时结束对应 Worker 进程
```

### 当前缺口

- Worker IPC 已具备版本、Runtime ID、Request ID、消息大小和待处理请求上限，但 Streaming 事件背压与能力矩阵诊断仍未完成；
- initializing 阶段已可取消，failed 已可显式重试；并行 Runtime、崩溃与重试竞态仍需更完整自动化；
- 旧 Pi SDK 的兼容创建链尚不具备完整 Session replacement 语义；
- Windows 已完成创建/就绪/结束冒烟，但真实 Prompt、Tool、Extension UI、断线恢复与长时间运行仍需端到端验证。

## 4. Local HTTP / SSE

Pi Live Local Surface 继续只监听 loopback。

已实现能力包括：

- availability；
- start runtime；
- state；
- snapshot；
- controls；
- set model；
- set thinking level；
- prompt；
- steer；
- follow-up；
- abort / queue restore；
- extension response；
- per-runtime SSE；
- explicit terminate。

SSE 连接断开只释放该 View 的订阅，不结束后台 Pi Runtime。

浏览器刷新或重新连接后，通过 Runtime ID + Snapshot / entry cursor 恢复当前任务视图。

## 5. Pi Live Web Task Surface

Pi Live **不是第六个一级页面**。

当前一级页面仍固定为：

1. 任务复盘；
2. 工具分析；
3. 使用洞察；
4. 智能体概览；
5. 资产备份。

Pi Live 是任务复盘域的实时状态：

```text
/review/live
/review/live/:runtimeSessionId
```

普通本机任务复盘 Header 提供“Pi 实时”入口；进入 Pi Live 后不重复展示该入口。

已实现：

- 工作目录启动；
- 可选 Provider / Model；
- Runtime 内 Model / Thinking Level 真实查询和切换，控制归 Composer；
- 最近 Runtime ID 本地恢复索引；
- 后台仍存活 Runtime 的重新发现与状态校验；
- 实时消息；
- Thinking 可观察片段；
- Tool Progress；
- Queue 状态；
- Steer / Follow-up 两种发送方式；
- Stop 当前任务；
- Stop 后把未执行 Steer / Follow-up 恢复为可编辑草稿；
- 显式 Terminate Runtime；
- Extension UI confirm / select / input / editor；
- IME `compositionstart` / `isComposing` / keyCode 229 防误发送；
- Enter / Alt+Enter / Shift+Enter 输入语义；
- 用户不在底部时不抢滚动，只提示“有新记录”；
- SSE reconnect + Snapshot recovery；
- 调度诊断信息；
- View Dispose 不再交付排队中的旧视图事件；
- Runtime 切换后，旧 Snapshot / event 异步结果不得回写新视图；
- Follow Latest 已把 Composer / Queue / Restored Draft / Extension 高度变化纳入重新贴底逻辑；
- Snapshot 历史通过独立投影保留 User / Assistant / Thinking / Tool Call / Tool Result / Model Change / Thinking Level Change / Compaction / Branch Summary / Session Info 等可证明事实；
- Assistant Thinking 不再混入正文；
- 找不到对应 Tool Call 的原生 Tool Result 仍保留，不因投影不完整静默丢事实；
- Runtime Event 使用 Pi 实时协议的 `model_changed` / `thinking_level_changed`，与持久化 Entry 的 `model_change` / `thinking_level_change` 分层处理；
- `thinking_level_change` 已进入 Canonical Observation：`thinking.level.changed`，并同步 Timeline Protocol；
- 历史事实按 8 条一块使用 `VirtualRoundMount` 有界挂载，最近 2 块 eager；远端重子树卸载后保留实测高度；
- Pi Live 使用 `.pi-live-reader` 作为虚拟化观察根，不截断历史事实。

仍需继续收口：

- 大 Markdown / JSON / Diff / Tool Payload 的按需 / 分块 / 上限治理；
- Extension UI 请求响应后的长期事实沉淀仍需在不制造第二事实源的前提下继续核对；
- 历史生命周期行与 Tool / Thinking 的最终视觉层级仍需实机 UI 验收。

## 6. Streaming Scheduler / Page Visibility

Pi Live Web 不允许每个 Pi delta 都直接触发一次 React 提交。

正式调度规则：

- 前台可见：`requestAnimationFrame` 批量提交；
- 页面隐藏：250ms 降频；
- text / thinking / tool-call delta 按 message epoch + content index 合并；
- bash delta 合并；
- `tool_execution_update.partialResult` 为累计值，使用最新 Progress 替换旧值；
- Extension UI、Queue、Agent Settled、Tool Start/End、Compaction、Retry、Runtime Exit 等高优事件快速刷新；
- Surface Dispose 后丢弃仍未提交的 presentation queue，不把旧视图事件交付给已销毁页面。

当前诊断指标：

```text
ingressEvents
deliveredEvents
coalescedEvents
flushCount
maxQueueDepth
lastBatchSize
lastFlushLatencyMs
hidden
```

## 7. 自动验收状态

alpha.3 当前已有以下自动门禁：

- `AgentLens 1.0 CI`：Linux / macOS / Windows；
- Windows Desktop / npm lifecycle / package contents / shared Hook Dispatcher 等既有发行链测试；
- `Windows Installer Compile`：NSIS、安装包存在性、checksum、Artifact；
- `Alpha.3 Interaction Performance`：Pi Live Scheduler + Review 1000-round virtualization + Pi Live 4000-fact history virtualization budget；
- Pi Live Scheduler Dispose stale-event 防回归；
- Pi Live 持久化历史事实单元测试；
- `source-pi` Thinking Level Canonical Observation E2E；
- Pi Runtime Event / Persisted Entry / Core Observation / Timeline Protocol 的事件层级一致性契约。

**每次提交后的具体结论必须从 GitHub Actions 读取。文档中的“已建立门禁”不等于“未来任意 HEAD 自动通过”。**

Pi Live 4000-fact 门禁只验证虚拟挂载参数与重子树预算，不等同于真实浏览器 4000 条事实的 DOM / React / Heap 实测。

更重要的是：这些自动门禁均不得冒充真实 Pi、真实浏览器或长时间狗粮。

## 8. 自动契约护栏

`check:web-presentation` 已纳入 Pi Live 专项契约，固定：

- 一级导航仍为 5 个；
- `/review/live` 属于 Review 域；
- Review 必须有 Pi Live 可发现入口；
- IME 防误发送；
- Stop / Terminate 生命周期分离；
- Queue restore；
- 历史阅读不抢滚动；
- Extension UI response；
- Page Visibility 降频；
- Streaming coalescing；
- Tool Progress 累计替换；
- View dispose 不得隐式 Terminate；
- Runtime Event 与 Persisted Entry 名称不能混层；
- `thinking.level.changed` 必须同时存在于 Core 与 Timeline Protocol；
- Pi Live 历史投影必须保留 Tool Result / Model Change / Thinking Level Change；
- Pi Live 可见字号不得低于 12px；
- 不使用毛玻璃 / blur；
- 不新增 576px 响应式断点。

## 9. 仍未完成的真实门禁

以下项目**当前均视为未执行 / 待验证，绝不能因为自动化通过而视为完成**：

- 真实 Pi 认证 / 模型环境下：`Prompt -> Streaming -> Tool -> Steer/Follow-up -> Abort -> Reconnect`；
- 真实 Pi Model / Thinking Level 切换；
- 真实 Pi Extension UI 与实际 Extension / 模型交互；
- Windows 实机真实 npm `pi.cmd/.bat` 启动与进程生命周期；
- 正式浏览器 1000 轮真实 DOM / React 挂载数；
- Pi Live 4000 条历史事实真实 DOM / React / Heap 与滚动流畅度；
- 1000 轮滚动位置、展开/收起、Turn Rail、抽屉返回位置的实际交互流畅度；
- 100 次会话切换后的 Listener / Observer 资源趋势；
- 后台持续 Streaming 30 分钟时历史阅读位置稳定性；
- 1 小时连续 Streaming；
- 8 小时 CPU / Heap / RSS / DOM / Listener 趋势与任务结束后的资源回落；
- 断网、睡眠、Daemon 重启、Pi Runtime 异常、UI Reload 恢复矩阵；
- 1280x800、1366x768 等目标视口与目标缩放下的最终视觉验收；
- alpha.3 最终 8 小时交互体验确认。

Pi Runtime Worker 与异步启动的逐阶段状态以 `ALPHA3-PI-RUNTIME-WORKER-CHECKLIST.md` 为准；Checklist 未完成前，不得把 SDK 已可启动表述为接近原生 Pi TUI 的完成体验。

## 10. 发布状态

当前只存在 Draft PR #32。

未执行：

- 合并 main；
- Tag；
- GitHub Release；
- npm publish。

发布动作仍需显式确认。
