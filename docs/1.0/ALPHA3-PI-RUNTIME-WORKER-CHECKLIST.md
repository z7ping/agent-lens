# AgentLens 1.0.0-alpha.3 Pi Runtime Worker 开发 Checklist

状态：开发中
最后同步：2026-09-03
架构依据：ADR-0009
实施跟踪：GitHub Issue #51

## 进度规则

- 只有代码、测试或实机证据已经存在时才能勾选；设计完成不等于实现完成。
- 每个阶段完成后同步 GitHub Issue：提交、测试结果、实机证据、剩余风险和下一阶段。
- 本文同步公开实现状态；产品范围、版本顺序或安全边界变化另行完成私密文档联动。
- CI、模拟 SDK 和真实 Pi 验收分别记录，不互相替代。
- 未经真实运行验证，不使用“已修复启动速度”或“接近原生体验”等完成性表述。

## 阶段 0：基线与契约

- [x] 使用 `PI_TIMING=1` 记录当前 Pi 0.83.0 与兼容目标版本的冷启动、热启动数据
- [ ] 记录 `createAgentSession`、Resource Loader、每个 Extension、`bindExtensions` 的分段耗时
  - 已进入代码：Worker 启动、SDK、Resource Loader 整体、Session 创建、Extension 绑定和总耗时；逐 Extension 名称/耗时仍缺少稳定 SDK 可观察点，暂不勾选。
- [x] 固化 Start / State / Snapshot / SSE 的 initializing、ready、failed、terminating 状态契约
- [x] 固化 Worker 请求、响应、事件、错误和版本协商协议
- [x] 明确提示词、凭据、Extension UI 与 stderr 的脱敏和大小上限
- [x] 为当前同步 Start 行为增加回归夹具，证明改造前基线

## 阶段 1：异步 Runtime 状态机

- [x] Start 在分配 Runtime ID 后立即返回，不等待 AgentSession
- [x] Runtime 支持 initializing、ready、failed、terminating、terminated
- [x] State / Snapshot / SSE 返回当前阶段和脱敏失败原因
- [x] initializing 时 Composer 与 Session 控制保持禁用
- [x] initializing 时允许 Terminate，并取消仍在进行的初始化
- [x] ready 后原位启用 Composer，不丢失页面状态
- [x] failed 后可以显式重试，不无限自动重启
- [ ] 并发 Start、Terminate、Retry 不产生悬空 Runtime
- [ ] Start API P95 不超过 200ms，initializing UI P95 不超过 300ms

## 阶段 2：独立 Pi Runtime Worker

- [x] 新增独立 Worker 入口，并由 Daemon 直接启动 Node 入口而非 Shell
- [x] 一个活动 Pi Runtime 对应一个 Worker；并行任务使用独立 Worker
- [x] Worker 使用用户实际 Pi SDK，并执行版本与能力检查
- [x] Worker 使用 `createAgentSessionServices()` 创建 cwd 绑定服务
- [x] Worker 使用 `createAgentSessionRuntime()` 管理 Session replacement
- [x] Worker 使用 `createAgentSessionFromServices()` 创建实际 Session
- [x] 完整加载 Extensions、Skills、Prompts、Themes 与 Context Files
- [x] Extension UI Bridge 在 Worker 与 Web 之间保持原始 Request ID
- [x] Worker 退出、崩溃、超时和协议错误不会导致 Daemon 退出
- [x] Worker stderr 有界且脱敏
- [x] Terminate 后进程、IPC、监听器、计时器和临时状态全部回收

## 阶段 3：本地 IPC 与背压

- [x] IPC 消息包含协议版本、Runtime ID、Request ID 与消息类型
- [x] 请求与响应严格关联，未知或重复 ID 明确拒绝
- [x] 消息大小、stderr tail 和待处理请求均有上限
- [x] Streaming delta 可以合并，但 Tool、Queue、Extension UI 和终态事件不得丢失
- [x] Daemon 消费变慢时不产生无界内存积压
- [x] Worker 启动握手与能力矩阵可诊断
- [x] IPC 断开后 Runtime 进入准确失败状态，不伪装为 settled

## 阶段 4：Web 初始化体验

- [x] 点击新建任务后立即进入统一 Task Surface
- [x] 显示“启动 Worker / 加载配置 / 加载扩展 / 创建 Session / 绑定扩展”等真实阶段
- [ ] 显示当前慢扩展的名称与耗时，但不暴露私密路径或凭据
- [x] 初始化期间提供取消入口
- [x] 初始化失败提供重试与错误诊断入口
- [x] 页面刷新、路由切换和 SSE 重连不结束 Runtime
- [x] 切换任务时旧 Runtime 的 Snapshot / Event 不回写当前视图
- [x] Composer 固定底部，初始化、ready、streaming、failed 状态之间不跳动

## 阶段 5：自动化验证

- [x] Runtime 状态机单元测试
- [ ] Worker 握手、命令、事件、退出和崩溃测试
- [x] initializing 期间 Terminate / Retry 生命周期测试
- [ ] 两个并行 Runtime 的 Session、队列和 Extension UI 隔离测试
- [ ] IPC 背压与有界队列测试
- [x] HTTP Start / State / Snapshot / Controls / Prompt / Retry 契约测试
- [ ] SSE 初始化进度、ready、failed 与重连测试
- [x] Web 初始化态、取消和重试契约测试
- [ ] `source-pi` 历史采集无重复事实回归
- [ ] Typecheck、全量 Test、Build、Web presentation 与 Desktop contract 通过

## 阶段 6：真实验收

- [x] Windows 用户实际 Pi 0.83.0 安装与 npm shim 路径
- [x] 真实冷启动与热启动基准
- [ ] `Prompt -> Streaming -> Tool -> Steer / Follow-up -> Abort -> Reconnect`
- [ ] Model 与 Thinking Level 切换
- [ ] Extension UI 请求与响应
- [ ] 页面刷新和重新进入同一 Runtime
- [ ] Worker 崩溃、Daemon 重启、断网和睡眠恢复
- [ ] 100 次 Runtime 创建/结束后的进程、Listener 与内存趋势
- [ ] 后台 Streaming 30 分钟
- [ ] 连续 Streaming 1 小时
- [ ] 8 小时 CPU、Heap、RSS、DOM、Listener 与资源回落

## 当前进度

- 已完成 `initializing -> ready / failed` 状态机、初始化取消、显式重试和 HTTP / SSE / Web 契约贯通。
- 已完成每 Runtime 独立 Node Worker；支持 Services API 时使用官方 AgentSessionRuntime 创建链，旧版兼容链也只在 Worker 内运行。
- IPC 已增加严格响应关联、重复 Request ID 拒绝、有界 Worker 出站队列和 Streaming delta 合并；关键 Tool / Queue / Extension UI / 终态消息不以静默丢弃作为背压策略，关键队列无法继续承载时显式失败 Runtime。
- Worker 初始化握手现在返回协议/SDK/Session Runtime/模型切换/Thinking/Extension UI 能力矩阵；State / Snapshot 可携带初始化总耗时和阶段耗时。
- 初始化耗时已拆到 Worker/SDK/Resource Loader 整体/Session/Extension Binding 等阶段。逐 Extension 名称与耗时仍未获得稳定、安全的 SDK 观测点，因此没有伪造扩展级诊断。
- 本机源码服务 Start 返回约 9–13ms；打包 Daemon 稳态 HTTP Start 为 81ms。Daemon 首轮历史同步并发期间测得 1687ms，因此 P95 门禁暂不勾选。
- 本机 Pi 0.83.0 的独立 Worker 冷态约 7.5s 到 ready；Terminate 后已确认 Worker PID 回收。上述旧实机数据不代表本轮 IPC 改造已经完成集中回归。
- `shell.css` 已移除 11px 有效字号；本轮新 CI 正在重新验证 Web presentation / Typecheck / 全量构建，未绿前不勾选总门禁。
- 按当前计划，真实 Prompt / Tool / Extension UI / Reconnect、并发/崩溃自动化、1 小时 Streaming 和 8 小时狗粮统一留到后续集中测试阶段。
