# AgentLens 全量收敛审计台账（2026-10-20）

> 唯一总任务 [#523](https://github.com/z7ping/agent-lens/issues/523)。本文件是当前 `main` 的可核实技术债记录，不是完成声明。发现新项应更新所属子 Issue 与本文，不能用重写 UI 方式规避。

## 目标边界

- Source：Agent 原生记录 → SourceRecord / Evidence → Canonical；原文始终可追溯。
- Live：原生运行时 → LiveAdapter / 标准事件与快照 → 唯一 TaskSession 展示；能力由 Capability + Runtime 实际状态共同决定。
- Contribution：Adapter 提供数据、动作及稳定语义，不提供任意 React DOM/CSS。
- Surface：只有一套 TaskSurface、TaskSessionContent、TaskSessionComposer、TaskMessage、Tool/Thinking/错误呈现；来源只影响数据与能力。
- Cordis 是唯一插件运行时。Plugin Manifest 的 Source/Live/Analyzer/Storage/Surface 职责不得分叉。

## 可复核的遗留和 Owner

| 问题 | 真实代码位置 | 当前已知债务 | 子 Issue |
| --- | --- | --- | --- |
| Agent 能力与运行态一致性 | `packages/core/src/contracts/{plugin,source,live,integration}.ts`、`packages/{runtime-cordis,live-codex,live-hermes}` | 已有统一契约，但需要逐 Agent 能力/方法/运行态验证矩阵 | #515 |
| 错误/诊断 | `live-task-projection.ts`、Pi/Codex/Hermes Adapter | #514 已将错误可见性通用化，缺结构化诊断、修复动作契约 | #516 |
| Review 消息来源判断 | `features/ReviewRoundPresentation.tsx` | 对 Codex 用户消息源 ID 判断 **2 处**，暂按严格包装模板清洗 | #517 |
| Review 事件 Label 来源判断 | `features/review-event-presentation.ts` | Codex/Claude Code/Pi 各 **1 处** 来源分支，需迁移至可扩展语义投影 | #517 |
| Review 来源私有生命周期 | `features/review-interaction-presentation.ts` | Pi assistant.stop **1 处**特判，需要保留原生证据并迁移 | #517 |
| 旧 Pi 会话渲染 | `features/PiLiveTaskRound.tsx`、`features/pi-live-task-projection.ts` | 和 `LiveTaskTimeline` 并存；先核查消费者，再退役 | #518 |
| Live 通用页面命名 | `features/LiveTaskPage.tsx`、`live-task.css` | `LiveTaskPage.tsx` / `live-task.css` 通用 CSS 类全部更名为 `live-task-*`，现有名称例外清零；对应门禁禁止恢复 | #519 |
| Runtime Disclosure | `components/LiveRuntimeDisclosures.tsx`、Pi Service | 已在 PR #524 改用 `fieldId` / `section`，仍需实际 Web/Runtime 测试 | #520 |
| 复用与自动门禁 | `scripts/task-session-ownership.mjs`、`check-web-presentation.mjs` | 原有 AST/CSS 门禁；本轮追加 Agent 来源分支和历史钩子递减门禁 | #521 |
| 第三方接入 | `AGENTS.md`、`product-internal`、`agent-swe-skills` | 需要最小模拟插件及完整接入说明/例外清退清单 | #522 |

## 禁止误判完成

1. 静态源码、Issue 勾选、PR 合并、CI 成功都不能代替真机、真实 Agent、长会话与错误恢复验收。
2. 所有旧例外要记录消费者、迁移方案、删除验证和对应回归用例。禁止直接删除仍使用的组件。
3. 不许把来源差异压进通用页面，也不许把 Live 与 Review 再拆成两套 CSS/JSX。
4. 退役 CSS class 的结果要验证实际计算样式和窄屏布局；迁移 Source 语义要保留历史数据回放。
5. 新增 Agent 的最小验收：只引入 Source/Live Adapter 与受控 Contribution，不更改通用消息、工具、思考、输入区布局。

## 实施顺序

P0：#515、#516、#521 → P1：#517、#518、#519、#520 → P2：#522。若发现 P1 缺口会破坏 P0，先补上游契约再迁移。每一批 PR 都回写总 Issue #523；仅剩实机验收的任务也保持未完成状态。
