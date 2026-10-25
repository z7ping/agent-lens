# 为 AgentLens 接入新 Agent

本目录面向希望通过 **Pull Request 向 AgentLens 增加或完善智能体适配**的 TypeScript 开发者。无需学习整个 Daemon 或 Web 架构，先跑通测试，再替换原生读取和事件转换逻辑。

> **当前支持路径**：在本仓库增加 / 完善 Integration，通过 PR 合入。Plugin API 为 `1.0`；**不承诺**第三方 npm 包现在可以自行安装或通过 UI 即插即用。当前安装服务主要管理内置官方 Integration，公共 SDK、第三方分发和授权机制属于未来独立工作。

## 选一条最短路径

| 你的目标 | 应实现 | 入门文档 |
| --- | --- | --- |
| 读取原生历史会话、工具调用、证据 | Source | [01 · Source 接入](01-source-quickstart.md) |
| 在 AgentLens 中启动或继续 Agent 对话 | Live（通常需要 Source 配合恢复） | [02 · Live 接入](02-live-quickstart.md) |
| 把 Source、Live 作为同一个产品接入 | Integration | [02 · Live 接入：注册](02-live-quickstart.md#4-通过-integration-注册) |
| 提交 PR，核对错误、恢复和 UI 一致性 | 验证与提交 | [03 · 测试及 PR](03-testing-and-pr.md) |

**已有支持不要重写：** OpenCode 已有 `packages/source-opencode` 和 `packages/integration-opencode`；Claude Code CLI 已有 `packages/source-claude` 和 `packages/integration-claude`。可以针对 Live、原生事件覆盖或现有缺口提交增量 PR。Pi / Codex / Hermes 也有已有的 Live 适配器。先检查代码和 Issue，再决定新建包还是完善现有包。

## 首次操作：先运行仓库现成的最小集成样例

在仓库根目录，使用 **Node.js 22.23+**：

```bash
npm install
npm run test --workspace @agent-lens/daemon
```

上述命令运行 Daemon 工作区的测试（不仅是适配器样例）。重点阅读并运行的用例在：

- [第三方 Source + Live + Cordis + Canonical 端到端测试](../../../apps/daemon/src/third-party-adapter.integration.test.ts) —— 本仓库目前最小的**已落地可运行参考**。
- [Source 最小契约测试](../../../packages/core/src/contracts/mock-source-adapter.test.ts)。
- [Live 最小契约测试](../../../packages/core/src/contracts/mock-live-adapter.test.ts)。

这几个测试使用模拟 Agent，不证明任何真实 Agent 已接入。完成练习后，必须替换成目标 Agent 的真实证据并做联调。

## 只需要理解三层

```text
                 Agent Integration
              （同一 Agent 的产品注册）
                      /     \
         Source / Review     Live / Task
        读原生日志/DB      原生 SDK/API/CLI
            |                  |
 SourceRecord → normalize   NativeEvent → LiveEvent
            |                  |
     Canonical + Evidence      |
            \                  /
              统一 Task Surface
               Live / Review
```

- **Source**：`detect`、`ingestHistory`、可选 `startCapture`、`normalize`。保留原始事实和 Evidence；不另存一份完整会话正文。
- **Live**：`availability/list/start/state/snapshot/send/subscribe/terminate/dispose`。真实能力才声明 `resume`、`steer`、`queue`、模型控制等；Snapshot 必须有界。
- **Integration**：使用现有 Cordis/AgentLens Plugin 机制组合能力，不另造容器、不创建 Agent 专属 React 组件或 CSS。

完整接口真值源：[Source Contract](../../../packages/core/src/contracts/source.ts)、[Live Contract](../../../packages/core/src/contracts/live.ts)、[Plugin Contract](../../../packages/core/src/contracts/plugin.ts)。更详细的底层约束见[第三方 Agent 接入契约](../../third-party-agent-adapter.md)和根目录 [AGENTS.md](../../../AGENTS.md)。

## 完成的最低标准

贡献者应能证明：原生会话标识稳定；用户、助手、工具消息顺序不乱；错误/取消不是成功回复；未知事件不静默丢弃；断线/重放不重复事件；没有声明不支持的能力；同一语义事实在 Live 与 Review 使用统一 Task 组件呈现。

**有文档不等于有实现。** 不确定的能力标记为部分支持或不支持，并在 PR 中写清来源版本和尚未验证的场景。
