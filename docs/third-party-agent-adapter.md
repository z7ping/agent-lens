# 第三方 Agent 接入契约（Source / Live）

> 适用 AgentLens Plugin API `1.0`。入口契约：`packages/core/src/contracts/{plugin,source,live}.ts`；实施边界见 `AGENTS.md` 与 `docs/agent-convergence-audit.md`。本指南不承诺任何特定 Agent 已接入。

## 两条独立的数据入口

- **Source / Review**：`SourcePluginManifest`（`pluginType: 'source'`、`sourceId`、`productId`、`parserVersion`）负责原始记录发现与规范化。SourceRecord/Evidence 必须进入共享 Canonical Pipeline，再由共享 Review 展示；不得绕过 Pipeline 直接生成 UI 记录。
- **Live / Task**：`LiveAdapterManifest`（`pluginType: 'live'`、`liveId`、`productId`）与 `LiveAdapter` 负责运行时。标准化的 `LiveEvent` / `LiveRuntimeEvent.normalizedEvent` 进入共享 Live 投影与 TaskSurface；原生 `event` 保留作诊断证据。
- **Plugin runtime**：Cordis 是唯一加载与生命周期机制。Manifest 仅声明业务元数据，不能再建插件容器。所有插件需填 `pluginId`、`pluginVersion`、`apiVersion`、`pluginType`、`displayName`。

## Live 实施顺序

1. 实现 `LiveAdapter` 必需方法：`availability/list/start/state/snapshot/send/subscribe/terminate/dispose`；`snapshot` 必须分页有界，默认上限常量为 `LIVE_SNAPSHOT_DEFAULT_LIMIT`，单页不得超过 `LIVE_SNAPSHOT_MAX_LIMIT`。
2. 仅声明真正实现的 `capabilities`。如 `resume/fork/fork-at/queue/history-index/session-tree/model-switching/thinking-control` 等，需要实现其对应可选方法；注册阶段已有校验，不得用空实现伪装支持。
3. `inputCapabilities` 按 text/largeText/image/file/multiline 分别声明 `native/transform/unsupported`；`startCapabilities` 中 workspace/title 分别声明 `required/optional/unsupported`。不可用时清晰表达，不解禁虚假的输入选项。
4. 标准事件表达用户文本、推理、工具、状态和错误；任意 provider/网络/进程错误应以统一 `error` / 失败状态等事件传达并保留原文，不按 HTTP 状态码扩展共享页面。
5. Runtime Contribution 只提供结构化字段、`fieldId`、`section` 和受控 action。展示由 `LiveRuntimeDisclosures` 负责，不允许插件注入 JSX/CSS；语言文案不应决定语义或布局。

## 验证清单

- Manifest / Capability / 对应运行方法一致；未支持能力不在 UI 展示。
- Source 原始事实与 Evidence 可回放；旧历史、长会话、缺失/未知事件不静默丢失。
- Live 文本、思考、工具输入输出、失败、取消、断线重连及分页恢复正确；错误不会混入正常回答。
- 新增 Agent 不修改 `LiveTaskPage`、`LiveTaskTimeline`、`ReviewRoundPresentation`、`TaskSessionComposer` 及通用 CSS。
- 运行项目现有 `check:web-presentation`、单测、类型检查和构建；当前完整 Pi/Codex/Hermes 实机矩阵由 #521 跟踪。

## 已知待办

本指南是可核实契约与接入步骤，**不是** #522 所要求的可运行最小模拟插件。模拟插件和完整端到端集成测试仍需实现后再关闭 #522。
