# Pi 原生会话覆盖表（Issue #611）

> 基于 2026-11-05 的 `main` 静态源码审查。此表的“代码具备”仅表示已合并，**不表示已通过自动化、浏览器或 Pi 实机验收**。原生文件仍是事实来源；部分窗口的数据不能当成完整会话统计。

| 原生事实 / 功能 | 事实来源与接入 | Live / Review / 统一 UI | 状态与边界 |
| --- | --- | --- | --- |
| 扩展 select/confirm/input/editor | Pi SDK → `pi-live/extension-ui-bridge` / Worker → `ui.request/ui.dismiss` | Live FIFO 弹窗请求，按 requestId 响应和清除 | 已编码 #1020；断线恢复仍需实机验证 |
| 自动重试 | Pi `auto_retry_start/end` → `pi-live/adapter` → Live Protocol | Live `TaskEvent` 过程事实 | 已编码 #1021；不推断重试后整轮成败 |
| 摘要重试 | Pi `summarization_retry_scheduled/attempt_start/finished` → Live Adapter → Live Protocol | 共享 TaskEvent 显示次数、等待、错误、真实摘要来源 | 本次已编码；finished 只说明重试循环结束，成功与否取决于 `compaction_end` 或持久摘要条目，不能从 finished 推断成功 |
| 扩展追加条目 | `entry_appended.entry` → 原生 JSONL / Source | 原始 Live 事件仍可追查，正文通过 Source 快照呈现 | 有意不映射成第二条 Live 消息，避免重复；原生 Source 类型按现有 `pi-native` 解析 |
| 直接 RPC Bash 输出 | `bash_execution_update.id/delta` | 保留原始事件；不创建无归属的工具行 | 本项目使用 Pi SDK Worker，尚无直接 RPC Bash 调用与响应能力；不能伪造工具 start/end |
| 上下文压缩 | SDK `compaction_start/end` 和原生 JSONL `compaction` | Live 过程事件、历史快照重建；Review 继续按原生会话读取 | 已编码 #1021/#1022；本轮补全 SSE→原生压缩的唯一锚点去重、跨页游标合并和失效游标显式报错；测试已提交但仍需真实 Pi/跨端验收 |
| 工具执行与富结果 | SDK `tool_execution_*`、原生 `toolResult.content/details` | SSE 有界预览；Live 快照完整结果→共享 `TaskToolRow` / 图片 | 已编码 #1022；超大结果按需窗口仍属 #324 |
| 修改补丁 | Pi 内置 edit 的 `details.patch` | 共享 `PatchDiff`，可切换原文 | 已编码 #1023；不将 `details.diff` 误认为统一补丁 |
| 输出长度限制 | Pi assistant `stopReason='length'` | `message.end` / 原生快照→过程警告 | 已编码 #1024；不误作终态失败 |
| setStatus / setWidget | Pi 扩展运行时 keyed 更新 / 清除 | `ui.state`、内存重连重放，复用 `TaskEvent` | 已编码 #1025；任意自定义 TUI 不能强行序列化 |
| 嵌套工具 | `ctx.executeTool()` 的 `parentToolCallId` | Live/共享工具行展示真实父 ID；当前窗口可解析父名称和已加载子数 | 已编码 #1026；不推导窗口外关系 |
| 特殊会话记录 | 原生 `branch_summary/custom_message/context_edit/bashExecution` | Live 原生过程事实、原始证据 | 已编码 #1027；隐藏消息不在默认预览泄露正文 |
| 输入框阶段 | SDK retry/compaction start/end | 共享 Composer 真实状态提示 | 已编码 #1028；无原生事件时不做超时猜测 |
| 模型与 Token / 费用 | 原生 assistant/toolResult/usage/compaction/branch_summary 的 `usage` | Live 源记录级 `TaskEvent`；区分 billed/catalog 费用 | 已编码 #1029；**不汇总分页片段为整轮** |
| 系统提示词 / 工具声明 | 原生 `role='system'` sections 与 toolsAdded/Removed | Live 原生事实，按需看证据 | 已编码 #1030；不等于当前完整生效上下文 |
| 引用继续提问 | 已加载的 Live/Review 消息正文 | 复用消息操作与 Lexical `restoreMessage` | 已编码 #1031/#1036；只在可恢复 Review 提供操作，不自动发送 |
| 相关文件预览 | 文件变更 DTO 路径 → 现有 host file-preview | 共享文件变更面板内联图片/Markdown/代码 | 已编码 #1033；仅已记录文件，不能当任意文件浏览 |
| 子智能体只读会话跳转 | `SessionRelationshipDto` 中 `subagent/exact` | Review 现有会话选择/只读详情 | 已编码 #1034；缺 **toolCallId↔childSessionId** 原生关系，工具级跳转未支持 |
| 长轮次导轨 | 原生索引、已加载用户/助手正文 | 共享 TaskSurface 的 Q/A 预览与原有分页跳转 | 已编码 #1035；未加载正文不可推断回答 |
| 正文搜索命中精准定位 | Source 搜索 `NativeBodySearchHitDto.observationId`；Review 索引 `NativeReviewTurnLocatorDto.cursor/nativeEventId` | 现有搜索只定位会话，原生导轨能定位已校验轮次 | **待开发**：两者没有可靠、可直接使用的 observation→turn 映射；不可猜 ordinal |
| 官方 Subagent 执行详情 | Pi 示例扩展 `toolResult.details.mode/results[]`（single/parallel/chain）经 Live/Review 已关联原生结果 | 复用共享 `TaskToolRow` 展示子任务状态、模型、原生用量和消息/工具调用；按需展开、分批显示，保留原始详情 | 本次已编码；官方扩展默认 `--no-session`，这是工具内部执行记录，**不是可恢复子会话**；超大原生结果沿用分页读，不复制子会话正文 |
| 工具级子会话跳转 | Pi `parentSession` 可用于 fork/clone/newSession；不证明子智能体 | 仅已校验的 session-level `subagent/exact` 可点击 | **仍待事实来源**：工具调用 ID 与可持久子会话的原生关联，不使用相邻记录猜测 |
| 精确单次模型耗时 | Pi 消息记录 timestamp / usage；本轮未发现可证明的完整 provider start/end 测量对 | 当前轮次间隔和推理区间不等于精确模型耗时 | **待核实**：缺可靠采样时显示不可用 |
| Shell / 工具权限预设 | SDK 支持相关功能，但是否能安全通过 AgentLens Runtime capability 暴露需逐项验证 | 已有 Runtime action、Slash、通用 Composer | **待开发**：不得创建无后端动作的开关，也不得绕过权限确认 |

## 验收边界

- 已新增/调整静态回归用例，**未运行** `typecheck`、自动化测试、构建、真实 Pi 以及浏览器跨平台验收。
- 后续先完成 **原生 observation→turn** 和 **toolCallId→childSession** 的验证契约，再在已有 Review/Live 入口补精确跳转。任何无法证实的数据保持未支持，不以近似 ID、时间或执行顺序代替。
- 原生会话正文不复制为第二份业务数据库；Review/Live UI 优先沿用 `TaskSurface`、`TaskMessage`、`TaskToolRow`、`TaskEvent` 及既有控件。

## 官方 AgentSessionEvent 覆盖门禁

依据 Pi SDK `AgentSessionEvent['type']`（当前依赖 `@earendil-works/pi-coding-agent@1.2.0`），`packages/runtime-cordis/src/pi-live/adapter.test.ts` 用编译期类型约束枚举了当前 23 类事件。新增 SDK 事件需要明确选择处理策略，不能静默忽略。

- **统一 Live 语义**：消息、工具、队列、压缩、两类自动重试、推理级别、运行结算等事件复用当前 Task Surface。
- **运行时转译**：`session_info_changed` 经 Pi Service 产生 `session_title`，不在 Adapter 重复派发。
- **原生日志负责**：`entry_appended` 由 Source JSONL 快照还原，不复制正文。
- **只保留原文**：`agent_end` 不能作为整轮结算；`turn_start/turn_end` 不重复制造轮次；直接 RPC `bash_execution_update` 当前没有可归属的 SDK ToolCall，不能伪造工具。
- **边界**：该类型门禁只覆盖官方 SDK 声明的事件集合，Worker 私有事件和 Extension UI 使用既有独立契约；代码/测试已提交不等于本机实际运行或跨平台验收。
