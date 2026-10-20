# AgentLens 全量收敛审计台账（2026-10-20）

> 唯一总任务 [#523](https://github.com/z7ping/agent-lens/issues/523)。本文件是当前 `main` 的可核实技术债记录，不是完成声明。发现新项应更新所属子 Issue 与本文，不能用重写 UI 方式规避。**Issue 关闭标准为代码完成且 PR 已合并；实际运行、跨端与视觉手工验收由用户负责，不阻塞关闭。**

## 目标边界

- Source：Agent 原生记录 → SourceRecord / Evidence → Canonical；原文始终可追溯。
- Live：原生运行时 → LiveAdapter / 标准事件与快照 → 唯一 TaskSession 展示；能力由 Capability + Runtime 实际状态共同决定。
- Contribution：Adapter 提供数据、动作及稳定语义，不提供任意 React DOM/CSS。
- Surface：只有一套 TaskSurface、TaskSessionContent、TaskSessionComposer、TaskMessage、Tool/Thinking/错误呈现；来源只影响数据与能力。
- Cordis 是唯一插件运行时。Plugin Manifest 的 Source/Live/Analyzer/Storage/Surface 职责不得分叉。

## 可复核的遗留和 Owner

| 问题 | 真实代码位置 | 当前代码状态 / 待用户手工验收 | 子 Issue |
| --- | --- | --- | --- |
| Agent 能力与运行态一致性 | `packages/core/src/contracts/{plugin,source,live,integration}.ts`、`packages/{runtime-cordis,live-codex,live-hermes}` | 已合并 #530/#548–#551/#554/#558：注册期校验、身份防伪与 Product 多 Live 可用性回读；真实 Agent 运行由用户验收 | #515 |
| 错误/诊断 | `live-task-projection.ts`、Pi/Codex/Hermes Adapter | #514/#531/#532/#543–#546/#555 已补原生结构化诊断及共享投影；端到端真实失败恢复由用户验收 | #516 |
| Review 消息来源判断 | `features/ReviewRoundPresentation.tsx` | PR #528 已移除展示层 Codex ID 特判；代码收敛完成，手工历史回放由用户验收 | #517 |
| Review 事件 Label 来源判断 | `features/review-event-presentation.ts` | PR #528 已改为 kind/action 语义；代码收敛完成，真实记录由用户验收 | #517 |
| Review 来源私有生命周期 | `features/review-interaction-presentation.ts` | PR #528 已按 assistant.stop + stopReason 语义判别，不依赖 Pi ID | #517 |
| 旧 Pi 会话渲染 | `features/LiveTaskTimeline.tsx` | PR #527 已删除旧 `PiLiveTaskRound` 与独立投影；代码收敛完成，长会话/重连由用户验收 | #518 |
| Live 通用页面命名 | `features/LiveTaskPage.tsx`、`live-task.css` | `LiveTaskPage.tsx` / `live-task.css` 通用 CSS 类全部更名为 `live-task-*`，现有名称例外清零；对应门禁禁止恢复 | #519 |
| Runtime Disclosure | `components/LiveRuntimeDisclosures.tsx`、Pi Service | 已在 PR #524 改用 `fieldId` / `section`，代码收敛完成，Web/Runtime 实机验收由用户负责 | #520 |
| 复用与自动门禁 | `scripts/task-session-ownership.mjs`、`check-web-presentation.mjs` | 已合并 #525/#534/#535/#547/#556/#559：动态 Task/Review/Live 扫描与反例检查 | #521 |
| 第三方接入 | `AGENTS.md`、`product-internal`、`agent-swe-skills` | 已合并 #536/#541/#542/#557：第三方 Source/Live 接入指南、模拟契约、Cordis→Canonical SQLite/Live 集成代码测试 | #522 |

## 禁止误判完成

1. **验收职责区分**：代码完成且 PR 合并即允许关闭对应 Issue；真机、真实 Agent、长会话与错误恢复验收由用户独立执行；不得声称未做的验证已完成。
2. 所有旧例外要记录消费者、迁移方案、删除验证和对应回归用例。禁止直接删除仍使用的组件。
3. 不许把来源差异压进通用页面，也不许把 Live 与 Review 再拆成两套 CSS/JSX。
4. 退役 CSS class 的结果要验证实际计算样式和窄屏布局；迁移 Source 语义要保留历史数据回放。
5. 新增 Agent 的最小验收：只引入 Source/Live Adapter 与受控 Contribution，不更改通用消息、工具、思考、输入区布局。

## 实施顺序

P0：#515、#516、#521 → P1：#517、#518、#519、#520 → P2：#522。若发现 P1 缺口会破坏 P0，先补上游契约再迁移。每一批 PR 都回写总 Issue #523；只剩用户手动验收时应关闭代码 Issue，用户发现缺陷后新开或重开。

## 2026-10-20 已合并增量

- PR #527：删除旧 Pi Live 并行渲染及投影链。
- PR #528：移除共享 Review 的 Agent ID 条件分支，改用语义字段。
- PR #530：注册期检查 Manifest / Capability / Adapter 方法一致性。
- PR #531：取消或中断任务时不再将未结束工具误标为成功。
- PR #532：保留 code-only、嵌套 cause、聚合 errors 的错误详情（循环引用有界保护）。

**本表只表示代码变更情况，不代表真实 Agent 验收。**

## 2026-10-20 代码交付与关闭状态

- **已关闭**：#517（#528）、#518（#527/#552）、#519（#529/#535/#545）、#520（#524/#537–#540）；其余真实运行或视觉复核均由用户负责。
- **代码已交付并关闭**：#515（#554/#558 等）、#516（#555 等）、#521（#556/#559 等）、#522（#557 等）；手工验收由用户负责。
- 近期增量 #543/#544/#546 补足结构化错误跨 SSE / Snapshot / 投影链路，#547 增强共享 UI Owner 扫描，#548–#551 补 Source/Live Manifest 与生产 Cordis 同步边界，#552 清除确认的 TS 错误与过时 Pi 测试。
- 不等待 CI / Actions；只记录真实执行过的检查，不能以未执行的验证阻塞已完成代码 Issue 的关闭。

## 2026-10-20 最终结项

全部代码子 Issue #515–#522 已按代码提交且 PR 合并标准完成，相关 PR 至 #559，主 Issue #523 可关闭。完整 npm typecheck/test/build、Pi/Codex/Hermes 真实运行、Windows/浏览器与视觉验收**未在本轮执行**，由用户独立验收；若发现缺陷另开或重开 Issue。此处的代码完成仅表示需求按现有架构实现并合并，绝不暗示手工运行结果。
