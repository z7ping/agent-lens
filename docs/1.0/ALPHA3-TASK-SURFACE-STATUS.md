# AgentLens 1.0.0-alpha.3 Task Surface 实现状态

更新日期：2026-08-30
状态：实现收口 / Draft PR #32 / 未发布

本文只记录 1.0.0-alpha.3 的两个核心目标：

1. 任务复盘长会话交互与性能；
2. Pi Live 作为 Pi TUI 替代体验的运行时与 Web Task Surface。

不改变 `docs/1.0/IMPLEMENTATION-STATUS.md` 中其他 1.0 / Hub 能力的既有状态。

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

自动化 1000 轮虚拟窗口门禁：

```text
rounds                 = 1000
viewport               = 800px
average round height   = 312.1px
max mounted heavy tree = 14
budget                  = 40
```

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

### 2.2 Transport 决策

ADR-0008 已冻结：alpha.3 默认采用 **Pi RPC 子进程边界**。

原因包括：

- 复用用户实际安装的 Pi；
- AgentLens 与 Pi 版本不强绑定；
- Pi 故障与 AgentLens Daemon 进程隔离；
- Browser View 生命周期不拥有任务生命周期；
- Windows / macOS / Linux 可以保持同一 Service Contract。

SDK 不作为 alpha.3 第二条正式实现，只保留未来替换 Transport 的架构可能。

## 3. Pi RPC Runtime

已实现：

- 严格 LF JSONL framing；
- optional CRLF 输入兼容；
- 不使用 Node `readline`，避免 U+2028 / U+2029 被错误分帧；
- request-id correlation；
- command timeout；
- stderr tail；
- Pi 子进程退出后的 pending request fail；
- Runtime dispose / terminate 清理；
- Pi 原生 `get_entries(since)` entry cursor；
- Snapshot + reconnect 增量恢复；
- Prompt；
- Steer；
- Follow-up；
- Clear Queue；
- Abort；
- Extension UI response。

生命周期明确分为：

```text
Abort Task       != Terminate Runtime
Close View       != Abort Task
Close View       != Terminate Runtime
Terminate Runtime = 显式结束 AgentLens 所持有的 Pi 进程
```

### Windows npm shim

Windows 下 npm 常见 `pi.cmd` / `pi.bat` 不直接作为长期进程 owner。

AgentLens 解析受信任本机 npm shim 指向的 JS CLI entry，并使用当前 Node 直接持有真实 Pi Node 进程，避免：

- `.cmd` 直接 spawn 的兼容问题；
- 只杀 wrapper 后遗留 Pi 子进程。

当前已通过 Windows Typecheck / Test / Desktop package / Installer 编译链；仍需在真实安装了 Pi、具有真实模型认证的 Windows 环境做端到端运行验证。

## 4. Local HTTP / SSE

Pi Live Local Surface 继续只监听 loopback。

已实现能力包括：

- availability；
- start runtime；
- state；
- snapshot；
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
- 最近 Runtime ID 本地恢复索引；
- 后台仍存活 Runtime 的重新发现与状态校验；
- 实时消息；
- Thinking 可观察片段；
- Tool Progress；
- Queue 状态；
- Steer / Follow-up 两种发送方式；
- Stop 当前任务；
- Stop 前清空 Queue，并把未执行 Steer / Follow-up 恢复为可编辑草稿；
- 显式 Terminate Runtime；
- Extension UI confirm / select / input / editor；
- IME `compositionstart` / `isComposing` / keyCode 229 防误发送；
- Enter / Alt+Enter / Shift+Enter 输入语义；
- 用户不在底部时不抢滚动，只提示“有新记录”；
- SSE reconnect + Snapshot recovery；
- 调度诊断信息。

## 6. Streaming Scheduler / Page Visibility

Pi Live Web 不允许每个 Pi delta 都直接触发一次 React 提交。

正式调度规则：

- 前台可见：`requestAnimationFrame` 批量提交；
- 页面隐藏：250ms 降频；
- text / thinking / tool-call delta 按 message epoch + content index 合并；
- bash delta 合并；
- `tool_execution_update.partialResult` 为累计值，使用最新 Progress 替换旧值；
- Extension UI、Queue、Agent Settled、Tool Start/End、Compaction、Retry、Runtime Exit 等高优事件快速刷新。

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

## 7. 自动验收结果

当前 alpha.3 候选 HEAD `92d462f5b603c871adcc4414fa09ad21eff17119` 已通过：

### AgentLens 1.0 CI

Linux / macOS / Windows 全绿。

Windows 同时通过：

- Web presentation contract；
- Typecheck；
- Test；
- Build distributable；
- Desktop package；
- packaged Desktop Smoke；
- shared Hook Dispatcher；
- npm lifecycle；
- dist Smoke；
- npm package contents。

### Windows Installer Compile

全绿：

- desktop shell check；
- build distributable；
- prepare desktop runtime；
- NSIS compile；
- installer existence；
- checksum；
- unsigned installer artifact upload。

### Alpha.3 Interaction Performance

Pi Live Scheduler smoke：

```text
ingress events     = 15,441
delivered events   = 64
coalesced events   = 15,377
max queue depth    = 63
push time          = 46.34ms
push budget        = 500ms
delivered ratio    = 0.41%
ratio budget       = 3%
```

Review 1000-round virtualization：

```text
rounds             = 1000
viewport           = 800px
root margin        = 1400px
unmount delay      = 320ms
max mounted        = 14
mounted budget     = 40
```

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
- Pi Live 可见字号不得低于 12px；
- 不使用毛玻璃 / blur；
- 不新增 576px 响应式断点。

## 9. 仍未完成的实机门禁

以下项目**不得因为自动化通过而视为完成**：

- 真实 Pi 认证 / 模型环境下：`Prompt -> Streaming -> Tool -> Steer/Follow-up -> Abort -> Reconnect`；
- 真实 Pi Extension UI 与实际 Extension / 模型交互；
- Windows 实机真实 npm `pi.cmd` 启动与进程生命周期；
- 正式浏览器 1000 轮真实 DOM / React 挂载数；
- 1000 轮滚动位置、展开/收起、Turn Rail、抽屉返回位置的实际交互流畅度；
- 1 小时连续 Streaming；
- 8 小时 CPU / Heap / RSS / DOM / Listener 趋势；
- 1280x800、1366x768 等目标视口的最终视觉验收；
- alpha.3 最终交互体验确认。

## 10. 发布状态

当前只存在 Draft PR #32。

未执行：

- 合并 main；
- Tag；
- GitHub Release；
- npm publish。

发布动作仍需显式确认。