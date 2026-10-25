# 01 · Source：从原生会话到历史回顾

目标：把目标 Agent 的 **真实历史数据 → SourceRecord → Observation + Evidence → Canonical → Review**。本教程不要求写页面代码，也不要求 Live 已可用。

## 1. 找到原生数据，而不是先写 Parser

1. 检查官方 SDK/API、源代码、原生会话文件格式及版本差异；记录是 JSONL、SQLite、Hook 还是 API。
2. 确认**会话原生 ID**、每条事件的稳定 ID 或文件偏移、时间戳、用户/助手/工具调用与结果、错误状态。
3. 确认是否可增量读取、日志是否会轮转/改写、文件或数据库是否允许只读并发访问。
4. 检查现有 `packages/source-*` 和相关 Issue：例如 OpenCode/Claude Code CLI 的 Source 已存在，不要复制新的。

优先使用上游官方接口；不要从界面文本反推出工具结果。真实路径和数据库必须按平台检测，不要硬编码开发者本机路径。

## 2. 实现 SourceDefinition

接口：[packages/core/src/contracts/source.ts](../../../packages/core/src/contracts/source.ts)。

```ts
import type { SourceDefinition } from '@agent-lens/core'

// 演示注册形状；请用目标 Agent 的真实发现和解析替换模拟部分。
const source: SourceDefinition = {
  manifest: {
    pluginId: '@community/source-example',
    pluginVersion: '0.1.0',
    apiVersion: '1.0',
    pluginType: 'source',
    displayName: 'Example Agent',
    sourceId: 'example',
    productId: 'example',
    parserVersion: '1',
  },
  async detect(ctx) {
    // TODO: 验证真实可访问的可执行文件/配置目录/数据目录；找不到时返回 []
    return []
  },
  async declareCapabilities() {
    // TODO: 只有 ingestHistory 确实可用才声明 available
    return [{ sourceId: 'example', name: 'history', status: 'available', captureModes: ['native-log'] }]
  },
  async *ingestHistory(ctx) {
    // TODO: 从 ctx.installation 提供的位置按窗口、Checkpoint 增量读取
    // 每次 yield 完整 SourceRecord；见本文第 3 节和测试样例
  },
  async normalize(record) {
    return {
      observations: [{
        kind: 'unknown',
        capturedAt: record.capturedAt,
        ...(record.nativeId ? { nativeEventId: record.nativeId } : {}),
        identityHints: { nativeSessionId: record.sourceSessionNativeId ?? 'unknown' },
        payload: { rawType: record.nativeType, rawPayload: record.payload },
      }],
      evidenceCandidates: [{
        captureMethod: 'native-log',
        derivation: 'observed',
        confidenceHint: 'exact',
        sourceRecordId: record.id,
        sourceLocator: record.locator,
        capturedAt: record.capturedAt,
      }],
    }
  },
}
```

**注意：这是分层解释用的骨架，不是一个完成检测/读取的插件。** 请从[真实可运行的端到端测试](../../../apps/daemon/src/third-party-adapter.integration.test.ts)复制完整的模拟 `SourceRecord` 和 Cordis 注册，再替换为上游实现。不要把骨架中的 `detect() => []` 当作已发现安装。

## 3. SourceRecord 必须提供可追踪身份

真实读取时至少核对这些字段：

| 字段 | 作用 |
| --- | --- |
| `sourceId`、`installationId` | 归属哪个来源和安装 |
| `sourceSessionNativeId` | 原生会话身份，不能用显示标题代替 |
| `nativeId` / `sourceSequence` | 事件稳定定位与真实顺序（来源有证据才提供） |
| `capturedAt`、`nativeType` | 捕获时刻与原生事件种类 |
| `locator`、`payload` | 原始事实所在位置和原生载荷 |
| `parserVersion` | 解析版本，用于升级与重建 |

事件规范化优先使用已定义的 `message.user`、`message.assistant`、`tool.call`、`tool.result` 等语义；无法可靠解释时保留 `unknown` 和 Evidence，而不是丢弃。工具调用与结果应靠真实 `callId` / 来源 ID 关联；不要靠工具名或相邻文本猜配对。

**不要重复保存原生完整会话**；读取原生来源并保留必要的规范化事实与证据。源数据消失、漂移、无权限和解析失败须分别处理。

## 4. 把 Source 注册成 Integration 组件

已有真实实现：[OpenCode Source 注册](../../../packages/source-opencode/src/index.ts)、[OpenCode Integration](../../../packages/integration-opencode/src/index.ts)；更小的演示参见[端到端测试](../../../apps/daemon/src/third-party-adapter.integration.test.ts)。

```ts
import { defineAgentLensPlugin, type AgentLensContext } from '@agent-lens/runtime-cordis'

const applySource = Object.assign(
  (ctx: AgentLensContext) => {
    const registration = ctx.sources.register(source)
    return () => registration.dispose()
  },
  { inject: ['sources'] },
)
export const exampleSourcePlugin = defineAgentLensPlugin(source.manifest, applySource)
```

随后由 `defineAgentLensIntegration(...)` 按 `source` 能力注册，按产品生命周期启用（Integration 完整写法见[Live 教程第 4 节](02-live-quickstart.md#4-通过-integration-注册)）。不要直接让 Web 读 Agent 的 SQLite 或 JSONL。

## 5. 通过什么才算 Source 接入成功

- [ ] 能真实发现目标 Agent；未安装时不冒充可用。
- [ ] 至少一个真实会话的用户消息、助手回复、工具调用与结果按原始顺序进入 Review。
- [ ] 记录可回放、可增量更新；重复导入不制造重复事实。
- [ ] 未知事件保留原文和 Evidence；缺失、权限错误、数据漂移不被吞掉。
- [ ] 有多个会话、长会话及更新/删除/轮转数据的回归样例。

下一步：[02 · Live 接入](02-live-quickstart.md)；只贡献 Source 也可以直接按[03 · 测试及 PR](03-testing-and-pr.md)提交。
