# ADR-0008：Pi Live 采用 RPC 子进程作为 Alpha.3 默认运行时边界

状态：Accepted / Alpha.3 实现冻结  
日期：2026-08-30  
范围：AgentLens 1.0.0-alpha.3 Pi Live / Task Surface

## 背景

AgentLens alpha.3 的第二核心目标，是改善 Pi 日常使用体验，以 Web Task Surface 替代 Pi TUI 中不适合长时间工作的部分，同时与既有任务复盘形成同一体验体系：

```text
Pi Live    = 当前正在执行的任务
Task Review = 已完成或历史任务
```

AgentLens 已经通过 `@agent-lens/source-pi` 采集 Pi 原生会话历史和 native-tail 事件，并映射为 Canonical Observation。Pi Live 新增的是主动控制能力，而不是第二套事实采集系统。

因此必须先决定：AgentLens 应直接通过 Pi SDK 在 Daemon 进程内创建 `AgentSession`，还是通过 Pi 官方 RPC 模式持有独立 Pi 子进程。

本 ADR 只决定 alpha.3 默认生产 Transport 与生命周期边界；Web 视觉、Task Review Projection 和 `source-pi` Canonical 语义不由本 ADR 重定义。

## 驱动因素

1. **真实 Pi 环境一致性**：用户已经安装、配置和长期使用的 Pi，其版本、认证、扩展、Skills、Prompts、模型配置应尽量原样被 AgentLens 使用。
2. **故障隔离**：Pi、Provider 或第三方 Extension 的异常不应直接击穿 AgentLens 单实例 Daemon。
3. **任务生命周期独立于 View**：关闭浏览器、刷新页面或断开 SSE 不能自动结束仍在执行的 Pi 任务。
4. **可恢复性**：Web 重连后需要先得到完整 Snapshot，再从稳定 Cursor 后继续增量事件。
5. **队列与中断语义准确**：Steer、Follow-up、Abort、Extension UI 必须保持 Pi 原生行为。
6. **Windows 可用性**：npm 安装的 `pi.cmd` 需要可控且不遗留孤儿子进程。
7. **避免不必要的版本耦合**：AgentLens alpha.3 不希望为了 Pi Web 强制绑定某个 Pi npm SDK 版本。
8. **Source / Runtime 分离**：`source-pi` 继续只负责观测；主动控制不能反向污染 Canonical Source Contract。

## Spike 结果

### RPC Spike

Pi 官方 RPC 当前提供 alpha.3 所需的核心能力：

- `prompt`，并支持 Streaming 时 `steer` / `followUp` 行为；
- 独立 `steer`、`follow_up`、`abort`、`clear_queue`；
- `get_state`；
- `get_entries(since)`，使用稳定 Entry ID 作为跨客户端重启的增量 Cursor；
- `agent_settled`，可判断重试、压缩与队列后续已经全部收敛；
- Message / Thinking / Tool / Queue / Compaction / Retry 等流式事件；
- Extension UI request / response 子协议；
- 严格 LF JSONL framing。

AgentLens 已完成离线协议 Spike，覆盖：

- LF-only JSONL，且 `U+2028` / `U+2029` 不误分帧；
- Request ID 与 Response 关联；
- 异步 Streaming Event；
- Extension UI 原始 Request ID 回传；
- Command Timeout、stderr tail 与进程清理；
- Snapshot + Pi Entry Cursor 增量恢复骨架；
- Windows npm `pi.cmd` 解析为实际 Node CLI 入口，Daemon 直接拥有真正 Pi Node Process，而不是 `.cmd` wrapper。

### SDK Spike

Pi 官方 SDK 同样能够覆盖绝大多数功能：

- `createAgentSession()` / `AgentSession`；
- `prompt()`、`steer()`、`followUp()`、`abort()`；
- Session Event Subscription；
- Model / Thinking / Compaction；
- `AgentSessionRuntime` 提供 New / Switch / Fork / Import 等会话替换能力。

SDK 的优势：

- 无 JSONL 编解码与 IPC；
- 类型直接来自 Pi；
- Streaming Event 无协议转换；
- Windows 不存在命令 Shim 启动问题。

但 SDK 作为 alpha.3 默认生产边界存在更大的系统性代价：

- Pi 与 AgentLens Daemon 共进程，Pi/Extension 的异常边界变弱；
- AgentLens 必须直接依赖并发布固定 Pi npm 版本；
- 用户命令行正在使用的 Pi 版本与 AgentLens 内嵌版本可能不同；
- Pi SDK Runtime / Session replacement 后需要重新订阅并重新绑定扩展；
- Pi SDK 的全局配置、认证、模型目录与 AgentLens Daemon 生命周期形成更强耦合；
- Pi 升级节奏会直接进入 AgentLens 自身依赖升级和发行链。

当前没有发现 alpha.3 必需能力只能通过 SDK、无法通过 RPC 表达。

## 考虑过的方案

### 方案 A：AgentLens Daemon 内直接使用 Pi SDK

优点：调用链最短，类型最直接，理论 IPC 开销最低。

问题：进程隔离、版本所有权和用户真实 Pi 环境一致性均较差。

结论：alpha.3 不采用为默认生产 Transport。

### 方案 B：Daemon 持有 Pi RPC 子进程

优点：

- 使用用户实际 Pi 安装与配置；
- Pi 与 AgentLens 故障隔离；
- Runtime 可以独立于 Web View 存活；
- RPC 原生提供稳定 Entry Cursor；
- Pi 升级不要求 AgentLens 同步升级 SDK 依赖；
- 现有协议已经覆盖 alpha.3 所需控制能力。

代价：需要处理 JSONL、IPC、子进程和 Windows Shim。

结论：采用。

### 方案 C：RPC 与 SDK 同时作为 alpha.3 正式 Transport

优点：选择自由。

问题：alpha 阶段会立刻产生两套 Runtime 行为矩阵、两套故障模式和两套跨平台验收，增加大量维护面，并且当前没有业务收益证明需要双 Transport。

结论：拒绝。

## 决定

### 1. Alpha.3 默认且唯一生产 Transport 为 Pi RPC

```text
AgentLens Daemon
  └─ PiLiveService
      └─ PiRpcClient
          └─ owned Pi process: pi --mode rpc
```

Pi Runtime 由 AgentLens 单实例 Daemon 持有，而不是由浏览器或 React 组件持有。

### 2. PiLiveService Contract 不暴露 RPC 细节

Web / HTTP 依赖语义接口：

- Start / State / Snapshot；
- Prompt / Steer / Follow-up；
- Abort；
- Extension UI Response；
- Subscribe；
- Terminate。

因此未来如果 SDK 被证明更合适，可以新增 Transport 实现，而不推翻 Web Task Surface 和 HTTP DTO。

### 3. `source-pi` 与 Pi Live Runtime 严格分离

```text
source-pi
  -> Observe / Canonical Facts / Evidence

PiLiveService
  -> Control current Pi runtime
```

Pi Live Event Stream 是实时 UI 控制流，不直接成为第二事实源。

任务完成后，最终可复盘事实仍由现有 Source / Canonical Pipeline 形成。

### 4. View 生命周期不拥有 Pi Process

以下行为必须严格区分：

```text
Close View / SSE disconnect
  -> unsubscribe only
  -> Pi continues

Abort Task
  -> clear_queue by default
  -> abort current run
  -> return queued text for editor restoration
  -> Pi process continues

Terminate Runtime
  -> explicit operation
  -> terminate owned Pi process
```

浏览器刷新、路由切换和 SSE 网络抖动都不得隐式结束 Pi 任务。

### 5. Reconnect 使用 Pi 原生 Entry Cursor

恢复路径采用：

```text
GET Snapshot
  -> state + get_entries(since?) + leafId

SSE
  -> live runtime events
```

`get_entries(since)` 的稳定 Entry ID 是持久增量 Cursor；AgentLens 不额外发明另一套 Pi Entry 序号。

SSE Sequence 只承担当前 Runtime Connection 内的实时排序，不升级为持久事实 ID。

### 6. Extension UI 使用 Pi 原始 Request ID

`extension_ui_response` 必须原样回显 Pi 发送的 Request ID。

它不是普通 RPC Command，不允许通过 AgentLens 自动生成的 Request ID 替换。

### 7. Windows npm Shim 不通过 Shell 启动

当检测到标准 npm `pi.cmd` / `pi.bat` 时：

1. 读取本机可信 Shim；
2. 解析 `%~dp0` 指向的 Pi JS CLI；
3. 校验目标文件存在；
4. 使用当前 `node` 直接启动该 JS CLI；
5. AgentLens 直接拥有真正的 Pi Node 子进程。

不使用 `shell: true`，避免参数转义、Shell 注入面和 wrapper orphan process。

无法识别的非标准 Shim 明确失败，并允许用户通过 `PI_BIN` 指向 `pi.exe` 或标准安装入口。

### 8. RPC 性能必须由指标证明，而不是假设

LLM 与 Tool 执行通常远高于本地 IPC 成本，但 alpha.3 仍必须测量：

- Event ingress rate；
- Event queue depth；
- dropped/coalesced event count；
- UI commit latency；
- Long task CPU / Heap / RSS；
- 1h Streaming 与 8h dogfood 趋势。

如果 RPC Transport 自身成为可测量的主要瓶颈，再重新评估 SDK。

## 重新打开本 ADR 的条件

满足以下任一条件时，应重新比较 SDK：

1. Pi 必需的新能力仅 SDK 提供，RPC 无等价 Contract；
2. RPC IPC / Serialization 经性能数据证明成为主要瓶颈；
3. Pi 官方明确弃用 RPC 或无法维持兼容；
4. AgentLens 决定自行拥有和发布固定 Pi Runtime，而不再复用用户本机 Pi；
5. 未来需要同进程自定义 Tool / Extension 注入，并且无法通过现有 Pi 扩展机制完成。

在这些条件发生前，不为“代码更短”同时维护 SDK 与 RPC 两套正式路径。

## 长期影响

- `runtime-cordis` 负责 Pi Live Runtime Service；不新增第二 Plugin System。
- `surface-http` 只暴露 Loopback Pi Live 控制 API / SSE。
- Web Task Surface 不直接操作 Child Process。
- AgentLens 不新增 Pi SDK 生产依赖，因此当前 package lock 和发行链不因 Pi Live 被迫绑定具体 Pi 版本。
- `source-pi` 可独立演进其历史采集、native-tail 与 Canonical 映射。
- Pi Live 的实时状态可以丢失并通过 Snapshot 重建；Canonical Observation 仍是可复盘事实的长期来源。

## 验收门禁

Alpha.3 不因本 ADR Accepted 就视为 Pi Live 完成。仍需通过：

- Runtime / HTTP 单元与契约测试；
- Linux / macOS / Windows CI；
- Windows 标准 npm `pi.cmd` 路径；
- 真实 Prompt -> Streaming -> Tool -> Steer / Follow-up -> Abort -> Reconnect 链；
- Extension UI 实际交互；
- 1h Streaming 稳定性；
- 8h dogfood CPU / Heap / RSS / DOM / Listener 趋势。

未跑过的实机或长时间门禁不得在 Checklist 中标记为通过。
