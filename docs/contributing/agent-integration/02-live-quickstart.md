# 02 · Live：从原生运行时到统一实时会话

目标：通过官方 SDK、API 或 CLI 与 Agent 交互，把**真实运行态事件**映射为共享 `LiveEvent`。Live 与 Source 是独立能力；支持历史回顾并不等于已经支持 Live。

## 1. 先明确上游能做什么

在开发前对照目标 Agent 的版本和官方资料核对：

| 核查 | 为什么 |
| --- | --- |
| 创建、发送、停止、继续会话 | 决定基本生命周期与恢复方式 |
| 增量消息、工具开始/结束、最终结果 | 决定事件的完整性及顺序 |
| 历史读取、分页、流重连 | 决定重启后是否能恢复 |
| 图片、文件、模型、推理、审批、队列 | 决定 `capabilities` 和 `inputCapabilities` |
| 原生会话 ID、任务 ID、流事件 ID | 防止断线重复与错误关联 |

**协议存在 ≠ 当前安装版本支持**。如果不能实证验证，先标为 `unsupported`，不要显示假的操作按钮。

## 2. 最小 LiveAdapter 契约

完整接口：[packages/core/src/contracts/live.ts](../../../packages/core/src/contracts/live.ts)；能运行的演示：[third-party-adapter.integration.test.ts](../../../apps/daemon/src/third-party-adapter.integration.test.ts)。

```ts
import type { LiveAdapter } from '@agent-lens/core'

const live: LiveAdapter = {
  manifest: {
    pluginId: '@community/live-example',
    pluginVersion: '0.1.0',
    apiVersion: '1.0',
    pluginType: 'live',
    displayName: 'Example Live',
    productId: 'example',
    liveId: 'example',
    capabilities: ['create', 'send', 'stream'],
  },
  capabilities: new Set(['create', 'send', 'stream']),
  inputCapabilities: {
    text: 'native',
    largeText: 'unsupported',
    image: 'unsupported',
    file: 'unsupported',
    multiline: 'native',
  },
  startCapabilities: { workspace: 'unsupported', title: 'optional' },
  // 以下方法要由原生 Runtime 实现；不要以固定 mock 响应提交真实 Agent。
  async availability() { return { available: false, reason: 'not configured' } },
  async list() { return [] },
  async start() { throw new Error('not implemented') },
  async state() { throw new Error('not implemented') },
  async snapshot() { throw new Error('not implemented') },
  async send() { throw new Error('not implemented') },
  subscribe() { return () => {} },
  async terminate() {},
  async dispose() {},
}
```

此代码只说明**接口形状**，是明确未实现的骨架；不能作为可用适配器注册。**可实际运行的 Mock** 请直接使用前述端到端测试，其中含完整的状态、订阅、发送与断言。

必需方法：`availability/list/start/state/snapshot/send/subscribe/terminate/dispose`。基础能力外的 `resume`、`interrupt`、`fork`、`queue`、`history-index`、`model-switching`、`thinking-control`、`extension-ui` 等必须同时实现对应方法并验证，才能声明。

## 3. 原生事件 → LiveEvent

```ts
// 一条原生消息变化：既保留原始证据，也提供可共享渲染的语义。
listener({
  runtimeSessionId: id,
  sequence: nextSequence,
  receivedAt: new Date().toISOString(),
  event: { type: 'native-token', value: delta, nativeId }, // 原生事实
  normalizedEvent: { type: 'text.delta', delta, messageId: nativeId },
})
```

典型事件：

| 原生事实 | 共享语义 |
| --- | --- |
| 助手开始/文本增量/结束 | `message.start`、`text.delta`、`text.end` |
| 推理片段 | `reasoning.start/delta/end`，仅在来源真实可见时 |
| 工具发起/输出/结束 | `tool.start/output/end`，用真实 `callId` 配对 |
| Agent 等待、运行、错误、结束 | `status`、`error`、`completed` |
| 原生交互请求 | `ui.request` + 稳定 `requestId`，需有真实响应路径 |

必须确保同一运行实例 `sequence` 有序、可去重；不要把 `transport` 中断解释成模型完成，也不要把工具调用数量当进度百分比。**不认识的原生事件保留 `event`，不造 `normalizedEvent`**。会话回放用 Snapshot 与流互相校正，不能把每次 SSE 重连当作新回合。

`snapshot` 按 `LIVE_SNAPSHOT_DEFAULT_LIMIT` / `LIVE_SNAPSHOT_MAX_LIMIT` 做单页有界读取，长会话需要正确的游标或窗口语义，禁止一次性拉取完整历史。图片/文件输入只有在上游确实支持并被 Adapter 正确转换时才可开启。

## 4. 通过 Integration 注册

实现并注册 Live Cordis 插件：

```ts
import { defineAgentLensPlugin, defineAgentLensIntegration, type AgentLensContext } from '@agent-lens/runtime-cordis'

const applyLive = Object.assign(
  (ctx: AgentLensContext) => {
    const registration = ctx.lives.register(live)
    return () => registration.dispose()
  },
  { inject: ['lives'] },
)
const livePlugin = defineAgentLensPlugin(live.manifest, applyLive)

// sourcePlugin 来源：01-source-quickstart.md
export const exampleIntegration = defineAgentLensIntegration({
  integrationId: 'example',
  productId: 'example',
  displayName: 'Example Agent',
  apiVersion: '1.0',
  capabilities: ['source', 'live'],
  componentPluginIds: ['@community/source-example', '@community/live-example'],
}, [
  { pluginId: '@community/source-example', capabilities: ['source'],
    activation: 'catalog', lifecycle: 'plugin', plugin: sourcePlugin },
  { pluginId: '@community/live-example', capabilities: ['live'],
    activation: 'enabled', lifecycle: 'plugin', plugin: livePlugin },
])
```

这一片段展示**Source + Live 组合关系**；需要导入第 01 篇定义的 `sourcePlugin`（或换成实际代码），并按仓库 Composition Root 注册 Integration。建议直接看：[Hermes 完整 Integration](../../../packages/integration-hermes/src/index.ts)、[第三方正式注册测试](../../../apps/daemon/src/third-party-adapter.integration.test.ts)。`integrationId`、`productId` 与 `liveId` 可以不同，不能靠字符串相等推断它们的关系。

目前第三方 npm 包自动安装未开放为可靠的公开路径；在 PR 中新增/完善仓库 Integration，而非在文档里宣称 `npm install` 后自动发现新 Agent。

## 5. 不能省略的 Live 验收

- [ ] 真实启动、发送、增量消息、工具开始/结束、停止、失败状态。
- [ ] 多次工具调用与多轮回复的顺序和结果关联正确。
- [ ] Snapshot 有界，较长历史可按能力恢复；重复订阅/断线不重复事实。
- [ ] 原生错误信息可见，失败消息不能渲染成成功答案。
- [ ] 允许的模型/推理/审批/图片/队列能力来自真实 Runtime，不伪造。
- [ ] 不更改 `LiveTaskPage`、`LiveTaskTimeline`、`TaskSessionComposer` 等共享 UI 的来源分支。

下一步：[03 · 测试与提交 PR](03-testing-and-pr.md)。
