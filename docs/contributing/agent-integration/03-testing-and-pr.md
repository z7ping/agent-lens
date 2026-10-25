# 03 · 验证、边界和提交 PR

本教程针对**仓库内贡献的 Agent Integration**。任何通过 PR 合并的新 Agent 都必须遵守同一 Source / Live Contract、共享 Task Surface 和数据证据规范。

## 1. 本地运行

Node.js 22.23+，在仓库根目录：

```bash
npm install
npm run test --workspace @agent-lens/core
npm run test --workspace @agent-lens/daemon
npm run check:web-presentation
npm run typecheck
npm test
npm run build:dist
```

先用对应工作区运行快速测试，再进行仓库级回归。工作区测试命令运行整个工作区，不只是一个样例。UI 真机验收要额外记录，不能用 CI 的模拟 Agent 用例冒充真实客户端验收。

参考测试：
- [Source 最小 Mock](../../../packages/core/src/contracts/mock-source-adapter.test.ts)
- [Live 最小 Mock](../../../packages/core/src/contracts/mock-live-adapter.test.ts)
- [Cordis → Source → Canonical 与 Live 集成测试](../../../apps/daemon/src/third-party-adapter.integration.test.ts)
- [现有布局/样式契约检查](../../../scripts/check-task-style-ownership.mjs)
- [现有 Agent 分支负例门禁](../../../scripts/agent-convergence-ownership.mjs)

## 2. 功能与证据验证矩阵

| 验证场景 | Source / Review | Live |
| --- | --- | --- |
| 安装/可用性 | 未检测到时不报告 `available` | 原生服务不可用不允许发送 |
| 身份与顺序 | 多会话、不同事件、重复导入不串联 | 同一 run ID、event sequence 可靠 |
| 消息和工具 | 正确保留 User/Assistant/Tool、callId、错误 | 增量、完整结果、结算状态一致 |
| 原生未知事件 | Evidence + `unknown` 可追踪 | 原生 `event` 可见，语义安全降级 |
| 大会话 | 窗口/Checkpoint 与资源边界 | Snapshot 分页有界、滚动稳定 |
| 异常恢复 | 读取缺失、轮转、版本变化、权限错误 | SSE 断开、恢复、失败、取消、中断 |
| 能力与交互 | 未观察到的不臆测 | 真正支持时才展示模型/审批/队列等 |
| UI | 使用共享 Review | 使用共享 Task Surface，无专属 JSX/CSS |

如同一原生会话可用于 Review 和 Live，应测试消息、工具、错误和子任务等事实在两者中的对应关系。只实现 Source 或只实现 Live 时，在 PR 中明确标注另一侧未提供，不要构造虚假测试通过。

## 3. 提交前的禁止事项

- 禁止提交真实会话、数据库、日志、Prompt、个人目录、Token、密钥；Fixture 应为最小化合成数据。
- 不复制一套完整 Agent 原生会话库；Checkpoint、Canonical Observation、Evidence 和可追溯原生位置各司其职。
- 不绕过 Source Runner / Canonical 直接向 Web 写历史消息。
- 不在 Web 通过 `sourceId === 'xxx'` 创建 Agent 专属时间线、消息卡、工具折叠、输入框或样式。
- 不把未知、处理中、断线、取消、被拒绝都归为成功；不把未经验证的能力声明为可用。
- 新增外部 SDK 时先查官方成熟方案、依赖许可证和兼容性，并在 PR 中记录取舍。

## 4. PR 说明模板

可复制以下内容到 PR 正文：

```markdown
## 目标 Agent
- 名称及官方项目：
- 已验证版本 / 操作系统：
- 接入类型：Source / Live / 二者

## 原生实现证据
- 原生 API / 日志 / 数据库来源：
- 会话/事件稳定 ID、增量恢复方法：
- 官方 SDK/API 与自研逻辑的取舍：

## 能力矩阵
- 已支持：...
- 部分支持：...
- 不支持：...

## 验证
- [ ] Typecheck / 相关单测
- [ ] Canonical + Evidence 或 Live 集成测试
- [ ] check:web-presentation
- [ ] npm test / build:dist
- [ ] 真实 Agent 的 Live / Review 样例（或说明未验证）
- [ ] 长会话、未知事件、失败与断线场景
- [ ] 敏感数据审查，无私有日志/Token

## 风险与未覆盖事项
- ...
```

每个 PR 尽量只接入一个 Agent 或完善其一个明确能力；代码层面通过后可交由维护者合并，真实平台验收另外记录。对于变更 Core Contract、Canonical Identity 或跨 Agent UI 的需求，请先开 Issue 讨论，不要让新的 Adapter 迫使共享组件变成特例。

更多规则：[CONTRIBUTING.md](../../../CONTRIBUTING.md)、[AGENTS.md](../../../AGENTS.md)、[底层 API 契约](../../third-party-agent-adapter.md)。
