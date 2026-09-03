# AGENTS.md

本文是 AgentLens 代码仓库的 AI Agent 工作约束。无论使用 Codex、Claude Code、Pi、OpenCode、Hermes 或其他编码 Agent，修改本仓库前都必须遵守本文。

## 当前阶段

AgentLens 1.0 当前处于 **1.0.0-alpha.3 稳定化 / 表现层收敛**。默认目标是修复缺陷、收敛 Task Center / Pi Live、提高性能和资源稳定性。

未经用户明确要求：

- 不合并 `main`；
- 不发布 npm / GitHub Release；
- 不扩无关 P1 / P2；
- 不重新设计已经确定的 1.0 架构。

## 架构底线

修改架构、Core Contract、Source / Storage / Surface、Daemon 生命周期前，先阅读：

1. `ARCHITECTURE.md`
2. `docs/1.0/CORE-CONTRACT.md`
3. `docs/adr/0001-agentlens-1.0-clean-rebuild-and-cordis-runtime.md`

Core 保持框架无关；Cordis 是唯一 Plugin Runtime。Source 事实必须走 Canonical Pipeline，不得绕过 Observation / Evidence / Projection 自建第二套事实链路。Web 只消费 `@agent-lens/protocol` / `/api/v1/*`。

## UI / 组件契约（强制）

跟踪 Issue：#55 `refactor(ui): 建立 Web 统一组件契约并收敛重复 UI 实现`。

AgentLens 已有 UI / UX 规范、Design Token 和 Task Surface 体系。**任何新的 UI 修改都必须优先复用现有统一组件，不得继续新增页面级重复控件。**

组件分层固定为：

```text
tokens
→ primitive components
→ domain / Task components
→ page layout
```

### 必须复用

已有对应 Primitive 时，页面不得自行重新实现：

- Button / IconButton
- Input / Textarea
- Select
- Badge / StatusBadge / StatusDot
- Disclosure
- Toolbar / ToolbarGroup
- Dialog / Drawer
- Empty / Error / Loading State

### 图标规范

- 通用界面图标统一使用 `components/ui` 导出的 `UiIcon`，页面和领域组件不得重复绘制同义 SVG。
- 工具类型只使用专用 `ToolKindIcon`；正式品牌标识只使用品牌资源，不用字符或 Emoji 代替。
- 禁止用 `× / ← / → / ↑ / ↓ / ✓ / ⌄ / ⌕` 等文本字符充当按钮、状态、导航或展开图标。
- 图标尺寸只使用 `12 / 14 / 16 / 20` 四档；默认 `16px`，随文字使用 `14px`，紧凑状态使用 `12px`，空态与强调状态使用 `20px`。
- 图标继承当前文字或语义状态颜色，不在页面内声明独立色值；描边、端点和视框由 `UiIcon` 统一维护。
- 纯图标操作必须使用 `IconButton` 并提供准确的 `aria-label`；图标与文字组合时由 `Button` 或对应 Primitive 负责间距和命中区。

Task Center / Review / Pi Live 的任务内容继续复用现有：

- `TaskSurface`
- `TaskHeader`
- `TaskRound`
- `TaskMessage`
- `TaskThinking`
- `TaskToolGroup`
- `TaskToolRow`
- `TaskEvent`

不得建立平行的第二套 Task 组件体系。

### 禁止

- 禁止页面因为空间不足私自缩小正常字号、按钮高度或点击命中区。
- 正常可见文字不得低于 `12px`。
- 禁止页面重新声明已有品牌色、语义色、状态色、基础圆角。
- 禁止新增 `final / polish / override / alignment / prototype` 一类最后加载样式层。
- 禁止新增 `!important` 作为正常组件实现方式。
- 禁止通过一次性业务断点解决布局问题；正式断点只使用 `768 / 992 / 1200 / 1400`，除非先修改设计规范。
- 禁止新组件允许调用方随意传高度、字号、颜色绕过系统；API 应表达 `variant / size / state` 等语义。
- 禁止为了“组件化”过度抽象只出现一次、没有稳定契约的业务结构。

### Design Token

`packages/web/src/tokens.css` 是正式运行时 Design Token 基线。页面和组件消费语义 Token，不维护自己的品牌色板。

公共控件尺寸基线：

- 标准按钮：`30px / 12px`
- 紧凑按钮：`26px / 12px`
- 筛选 / 输入：`34px / 13px`
- 正文：`14px`
- 列表 / 表格：`13px`
- 辅助文字：`12px`

### 设计资料边界

高保真原型、设计探索、内部 Checklist 只存放在 `z7ping/product-internal`，不得复制到本公开仓库。

如果当前会话可以访问 `z7ping/product-internal`，修改表现层前应阅读：

- `agent-lens/docs/design/UI-UX-PROPOSAL.md`
- `agent-lens/docs/design/README.md`
- alpha.3 任务相关修改再读 `ALPHA3-CHECKLIST.md` 与 `ALPHA3-TASK-REVIEW-PI-LIVE.md`

真实功能 / 字段 / 数据语义以本仓库正式实现为依据；视觉、信息层级、公共控件和响应式以有效设计规范为依据。

## UI 修改前检查

修改页面之前必须先回答：

1. 现有 `packages/web/src/components` 或 Task Surface 是否已经有同类组件？
2. 是否可以扩展现有组件而不是新造一个？
3. 样式是否已经有 Token / Primitive 所有者？
4. 是否会引入第二套尺寸、状态或响应式规则？

如果 1/2 为“是”，优先复用或扩展，不新增平行实现。

## 验证

涉及 Web / UI 的修改至少执行或确保 CI 覆盖：

```bash
npm run check:web-presentation
npm run typecheck
npm test
npm run build:dist
```

Task Center / Pi Live 还必须保留对应契约、性能与真实 Smoke 门禁。CI 通过不能代替用户要求的真实 Pi / Windows / 长时间狗粮验收。

## 提交

提交信息、Issue / PR 说明优先中文。重要实现变化同步相关 Issue / Checklist，不允许实现进度只存在聊天上下文中。
