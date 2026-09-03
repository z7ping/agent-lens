# ADR-0009：Pi Live 使用独立 SDK Worker 承载原生运行时

状态：Accepted
日期：2026-09-03
范围：AgentLens 1.0.0-alpha.3 Pi Live / Task Surface
实施跟踪：GitHub Issue #51

## 背景

Pi Live 当前在 AgentLens Daemon 进程内，通过用户已安装的 `@earendil-works/pi-coding-agent` SDK 直接调用 `createAgentSession()`。SDK 定位和动态导入已经可以后台预热，但首次创建 Session 仍需要同步完成模型、配置、Extensions、Skills、Prompts、Themes 与 Context Files 的发现和初始化。

实机分段日志已经确认：SDK 可以在 `0ms` 内就绪，但首次 `AgentSession` 创建曾分别出现约 25 秒和 76 秒的等待。相同环境的热态复测约为 4 秒，同一 Node 进程内第二次创建约为 149 毫秒。延迟主要位于首次资源和扩展加载，而不是 Pi Live 历史同步或 Web 渲染。

这造成两个问题：

1. `POST /api/v1/pi-live` 必须等待完整 Session 创建，用户在进入任务界面前没有可观察进度；
2. Pi Runtime 与第三方 Extension 和 AgentLens Daemon 同进程，阻塞、异常或退出可能影响历史采集和其他 AgentLens 能力。

## 决定

### 1. 一个活动 Pi Runtime 由一个独立 Worker 进程持有

```text
AgentLens Web
  <-> loopback HTTP / SSE
AgentLens Daemon
  <-> versioned local worker IPC
Pi Runtime Worker
  -> createAgentSessionServices()
  -> createAgentSessionRuntime()
  -> AgentSession / Extension Runtime
```

Worker 使用用户实际安装且通过兼容性检查的 Pi SDK。AgentLens 不复制 Pi 的 Session、模型、队列、压缩或扩展语义。

一个 Worker 在其生命周期内通过官方 `AgentSessionRuntime` 完成当前任务的 New、Resume、Fork、Import 或 Session replacement。需要并行执行的独立 Pi 任务使用独立 Worker，避免扩展状态和失败边界互相污染。

### 2. Runtime 创建改为异步状态机

Pi Live Runtime 至少具有以下状态：

```text
initializing -> ready
             -> failed
initializing -> terminating -> terminated
ready        -> terminating -> terminated
```

- Start 先分配 `runtimeSessionId` 并快速返回，不等待完整 AgentSession；
- State、Snapshot 与 SSE 暴露状态、当前初始化阶段和脱敏后的失败原因；
- Prompt、Steer、Follow-up、模型与 Thinking 控制只在 `ready` 后执行；
- initializing 阶段允许 Terminate，并必须取消初始化、回收 Worker；
- Browser View 关闭或 SSE 断开只取消订阅，不终止 Worker；
- 初始化失败允许用户显式重试，不在后台无限重启。

### 3. 对齐 Pi CLI 的官方服务与 Session 创建链

Worker 不再只调用最简 `createAgentSession({ cwd, sessionManager })`，而是使用：

1. `createAgentSessionServices()` 创建 cwd 绑定的 Settings、Model Runtime 与 Resource Loader；
2. `createAgentSessionRuntime()` 持有可替换 Session 生命周期；
3. `createAgentSessionFromServices()` 从已创建服务构造 Session；
4. `bindExtensions()` 接入 AgentLens Extension UI Bridge。

不得使用空 Resource Loader 或默认禁用资源来制造启动速度。用户原有 Extensions、Skills、Prompts、Themes、Context Files、认证和模型配置必须保持可用，并在诊断中报告实际加载结果。

对于仍可被 AgentLens 支持、但尚未公开上述 Services API 的旧 Pi SDK，兼容路径也必须完全运行在独立 Worker 内，并继续使用 SDK 自己的默认 Resource Loader。兼容路径不得退回 Daemon 内执行；诊断应明确标记其未获得 Session replacement 能力。升级到具备 Services API 的版本后自动切换到完整创建链。

### 4. UI 立即进入任务工作台

Web 在收到 Runtime ID 后立即进入 Task Surface。初始化期间：

- 显示可行动的阶段文本，而不是阻塞导航或只显示无信息转圈；
- Composer 与需要 Session 的控制项保持禁用；
- 提供取消入口；
- ready 后原位启用，不重新创建页面或丢失阅读位置；
- failed 时显示脱敏错误、失败阶段与重试入口。

### 5. Worker IPC 是内部传输，不是第二事实源

- `source-pi` 继续负责原生 JSONL、Runtime Tail、Canonical Observation 与 Evidence；
- Worker Event 只服务当前任务的实时控制和展示；
- 最终可复盘事实继续由 Source / Canonical Pipeline 形成；
- IPC 消息使用版本号、请求关联标识、长度上限和有界队列；
- 不通过 Shell 启动 Worker，不在命令行传递提示词、凭据或扩展载荷；
- Worker stderr 只保留有界、脱敏的诊断尾部。

## 性能预算

在 Daemon 已就绪的本机环境中：

- Start API 返回 Runtime ID：P95 不超过 200ms；
- Web 显示 initializing 状态：P95 不超过 300ms；
- Worker ready 时间单独测量，不伪装为页面响应时间；
- 每个初始化阶段、每个 Extension 的耗时可诊断；
- 冷启动、热启动、失败与取消分别建立回归证据。

预算需要在 Windows、macOS 和 Linux 实测。CI 模拟通过不等同于实机性能达标。

## 与 ADR-0008 的关系

ADR-0008 选择 `pi --mode rpc` 子进程作为初始生产边界，随后实现改为 Daemon 内直接使用 SDK。当前决定保留“进程隔离”和“View 不拥有 Runtime”的正确部分，同时使用官方 SDK 的 `AgentSessionRuntime` 获得更直接的原生 Session 与 Extension UI 语义。

因此 ADR-0008 被本 ADR 取代，不再作为 alpha.3 当前实现目标。

## 非目标

- 不复制 Pi TUI 的视觉样式；
- 不把 Pi Live 变成第六个一级页面；
- 不改变 Canonical Observation Schema；
- 不同时维护 SDK Worker 与旧 RPC 两套正式生产 Transport；
- 不借此实现通用多 Agent Runtime Framework；
- 不因启动优化而静默关闭用户资源。

## 验收条件

- 首次启动出现 25 秒或 76 秒时，页面仍能立即进入 initializing 状态并允许取消；
- Worker 使用用户实际 Pi 配置完成真实 Prompt、Streaming、Tool、Steer、Follow-up、Abort、Reconnect 与 Extension UI；
- Worker 崩溃不导致 AgentLens Daemon 退出，失败状态可诊断且可重试；
- 页面刷新和 SSE 重连不结束正在运行的 Pi 任务；
- 并行 Runtime 之间的 Session、Extension UI、队列和事件不串线；
- Runtime 结束后 Worker、监听器、计时器和 IPC 资源全部回收；
- `source-pi` 历史采集不产生重复 Session、Message 或 Tool Event；
- 自动化、真实 Windows Pi、1 小时 Streaming 与 8 小时狗粮门禁分别记录，不互相替代。

## 重新评估条件

出现以下情况时重新比较官方 RPC、Pi Client/Protocol 或其他 Transport：

1. Pi SDK 不再支持当前所需的 Session 或 Extension UI 能力；
2. 官方远程协议成为稳定且完整的推荐宿主边界；
3. Worker IPC 经测量成为主要性能或维护瓶颈；
4. 用户真实安装版本无法安全提供兼容 SDK；
5. Pi 官方生命周期发生破坏性变化。
