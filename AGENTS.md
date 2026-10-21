# AGENTS.md

本文是 AgentLens 代码仓库的 AI Agent 工作约束。无论使用 Codex、Claude Code、Pi、OpenCode、Hermes 或其他编码 Agent，修改本仓库前都必须遵守本文。

## 当前阶段

AgentLens 1.0 处于 Alpha 阶段。当前源码版本以根目录 `package.json` 为准，实际公开发行版必须以 GitHub Releases / npm 发布记录核实，不得将源码版本误认为已发布。默认目标是处理缺陷、收敛 Task Center / Pi Live 的表现层，并提高性能和资源稳定性。

未经用户明确要求：

- 不合并 `main`；
- 不发布 npm / GitHub Release；
- 不扩无关 P1 / P2；
- 不重新设计已经确定的 1.0 架构。

## 架构底线

修改架构、Core Contract、Source / Storage / Surface、Daemon 生命周期前，先阅读相关实现、测试和当前任务提供的决策上下文。

Core 保持框架无关；Cordis 是唯一 Plugin Runtime。Source 事实必须走 Canonical Pipeline，不得绕过 Observation / Evidence / Projection 自建第二套事实链路。Web 只消费 `@agent-lens/protocol` / `/api/v1/*`。

## 跨平台与兼容性规则（强制）

涉及操作系统、Shell、PATH、包管理器、运行时管理器、CLI shim、安装目录、服务管理器等兼容性问题时，必须先抽象通用机制，再处理具体工具。

- 禁止针对单台机器、用户名、个人目录或固定安装路径写正式逻辑。
- 禁止把 Volta、nvm、Homebrew、mise、asdf 等单一工具作为主流程前提；具体工具只能作为通用 Resolver / Adapter 的一种实现。
- 优先使用操作系统、包管理器或工具自身提供的标准发现/解析能力，不复制其内部目录规则。
- 新增特判前，先判断是否属于现有通用机制；能扩展通用层时不得在业务层补丁式处理。
- Pi、Codex、Claude 等业务 Runtime 只消费统一发现结果，不感知具体机器环境或工具管理器。
- 任何仅能“让当前机器跑起来”的修复，都不得作为正式实现合入。

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
- SelectMenu（禁止原生 `<select>`）
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

### 工作区顶栏

- `Agents / Insights / Tools / Backup` 的一级位置由左侧导航表达，桌面端不再重复展示独占一行的标题。
- 非任务工作区共用 40px 下划线二级导航与至少 48px 的业务工具栏；筛选位于左侧、操作位于右侧，禁止新增页面私有导航或重复 Toolbar。
- Task Center / Review / Pi Live 保留必要的会话面包屑与任务上下文。
- 窄屏侧栏按钮放在共享二级标签行；工作区切换禁止对主列宽施加滑动动画，正文滚动容器尽量保持稳定。

### 间距与视觉分组

- 状态点 / 图标与相邻文字必须通过 `flex/grid + gap` 明确控制，**不得依赖 JSX / HTML 空白字符形成视觉间距**。
- 紧凑状态、图标 + 文字等单一语义组内部，优先使用约 `6px` 间距；同组相邻控件通常使用 `6–8px`。
- 不同语义组（例如连接状态 → 模型设置 → 发送方式）必须有明显大于组内的分隔节奏，桌面紧凑工具条优先使用约 `10–12px`。
- 页面不得因为空间紧张把状态文字、Label、Badge、Pill、按钮直接贴在一起；空间不足时优先响应式隐藏低优先级信息、缩短文案或重排，而不是压缩组间距。
- Segmented Control 等明确属于一个整体的复合控件可以使用更小的内部间距，但必须由组件自身持有，页面不得借此把不同语义控件挤成一组。

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


### Task 工具调用与可见性恢复契约（强制）

- **相邻分组，不整轮聚合**：同一逻辑轮次中，仅相邻连续工具调用构成一个独立组；思考、过程消息、原生事件等非工具事实即使隐藏也必须打断分组。仅相邻连续超过 1 条工具调用才成组，单条直接显示；每组默认展示首 1 条，运行中/失败工具始终可见，展开/折叠独立且不改变原始顺序或证据。
- **同一实现**：Live 与 Review 必须复用 `TaskProcessSequence` / `TaskToolGroup`，不得在任一页面复制筛选、预览或折叠规则。Review 处理详情初始折叠，Live 活动过程初始展开；状态结算不得自动关闭用户正在阅读的详情。
- **阅读现场**：浏览器短暂切换标签页仅同步运行状态；长时间后台/断线恢复不清空已显示会话、不用整页 Loading 覆盖已有内容。恢复快照复用未变化的投影事实，允许增量修补遗漏的工具结果；必须保护手动滚动位置、每组工具/过程的展开意图及输入草稿。
- **活动轮次**：工具间无事件不代表任务完成，活动尾轮必须在真实结算/稳定历史切换前持续为运行中状态。虚拟轮次不能因 `document.visibilityState === 'hidden'` 自行卸载。
- **回归**：`task-tool-group.test.ts`、`review-tool-round-collapse.test.ts`、`live-task-projection.test.ts`、`live-task-history-window.test.ts` 均属于共享规则守护。涉及其中一项时，须同步校验多 Agent 的 Live / Review 表现，不允许以 Agent ID 添加独立 CSS 或状态分支。

### 会话输入区唯一实现（强制）

- `components/TaskSessionComposer.tsx` 是 **Review + Live 的唯一完整输入区**；持有展开/收起、运行状态、模型、推理级别、发送模式、发送按钮等 DOM。两页只通过 props 传入真实 Runtime 状态/能力和回调，禁止各自构造第二套 Composer 外壳。
- `components/LiveMarkdownComposer.tsx` 仅负责 Markdown、输入历史、附件、键盘和草稿。不得误以为复用了编辑器就等于复用了完整输入区。
- `task-session-composer.css` 独占完整 Composer 外观，`task-session-view.css` 独占 Session 槽位几何，`live-task.css` 独占 Live Runtime/队列/诊断视觉；**禁止恢复 `pi-live.css`**，禁止为特定 Agent 创建输入框 CSS。
- 输入区公共类名统一为 `task-composer-*`，不使用 `pi-live-*` 命名新的通用组件/样式。`live-task.css` 不得定义 `pi-live-*` 通用类名；兼容层的 Pi 名称不得渗透通用 DOM/CSS。
- Review 尚未恢复原生 Runtime 时，只能显示 capability 可确认的**禁用**模型/推理/流式模式控件，不能伪造当前模型、推理生效状态；发送后才进入原生 Live Runtime。
- `features/task-session-composer-contract.test.ts` 与 `scripts/check-web-presentation.mjs` 是禁止第二实现、样式漂移和错误文件命名的硬门禁。

### 多智能体 Session 单一渲染所有权（强制）

- **唯一正文实现**：Pi / Codex / Hermes / 后续 Agent 的 Live 均进入 `LiveTaskTimeline`；Live 与 Review 共用 `TaskSessionContent`、`TaskToolGroup`，按 `mode='live'|'review'` 表达生命周期，不再另建消息、思考、工具、过程 JSX 或 CSS。
- **唯一样式所有者**：`task-detail.css` 持有消息/思考/工具/过程视觉；`task-session-view.css` 持有会话阅读轴和壳层。智能体 Adapter 只提供原始事实、语义投影、模型/推理/审批等 capability；不能以来源名称创建新的会话外观。
- **允许差异**：确有原生能力的 Agent 专属控制、扩展、证据及状态可以按已有 Contribution/Capability 接口呈现，但必须复用既有 UI Primitive，不能改变共享消息 DOM 或覆盖共享组件 CSS。
- **受控扩展语义**：Runtime Disclosure 的字段分组由 `fieldId`（稳定语义键）和 `section`（status/performance/resources/advanced）提供。Web 不得根据英文 label、翻译文案或 Agent ID 猜测语义/分区；旧插件未声明时应按字段类型安全降级。
- **已退役**：`features/PiLiveTaskRound.tsx` / `pi-live-task-projection.ts` 是过时的并行渲染链，禁止恢复；`ReviewRoundPresentation.tsx` 的原始事件详情可直接使用 `TaskThinking`（剩余例外另行收敛）。
- **全量收敛递减门禁**：`scripts/check-agent-convergence-ownership.mjs` 由 `check:web-presentation` 执行，禁止共享 Task 页面再引入 Agent ID 特判、私有 Pi CSS 钩子和第二套编辑器；`scripts/agent-convergence-ownership.mjs` 的已知旧例外额度**只能减少，不能扩大**；Review 来源硬编码预算已清零，跟踪 #517/#519/#521/#523。新增例外必须先解决底层能力边界，不能修改额度蒙混通过。
- **硬门禁**：`scripts/check-task-style-ownership.mjs` 调用 `task-session-ownership.mjs`，递归检查 `packages/web/src` 全部 TSX 的 JSX AST 与 CSS 选择器；禁止新增私有 Task 组件、DOM、样式及绕开共享入口的 Live/Review 实现。对应负例在 `scripts/task-session-ownership.test.mjs`；两者分别由 `check:web-presentation` 和 `npm test` 执行。任何新增例外必须先说明不能复用的真实差异、收敛计划和对应回归测试，不可静默放行。


### 禁止

- 禁止页面因为空间不足私自缩小正常字号、按钮高度或点击命中区。
- 正常可见文字不得低于 `12px`。
- 禁止页面重新声明已有品牌色、语义色、状态色、基础圆角。
- 禁止新增 `final / polish / override / alignment / prototype` 一类最后加载样式层。
- 禁止新增 `!important` 作为正常组件实现方式。
- 禁止通过一次性业务断点解决布局问题；正式断点只使用 `768 / 992 / 1200 / 1400`，除非先修改设计规范。
- 禁止新组件允许调用方随意传高度、字号、颜色绕过系统；API 应表达 `variant / size / state` 等语义。
- 禁止为了“组件化”过度抽象只出现一次、没有稳定契约的业务结构。

### CSS 样式所有权与层叠门禁（强制）

- 加载顺序固定：基础与 Token → `components/ui` 共享 Primitive → Workspace 壳层 → 领域/页面样式。不得把 Primitive 放到最后加载。
- `.ui-*` / `SelectMenu` / `.btn` 基础规则只能由其组件 CSS 所有者定义；页面只能使用有语义的域类，禁止重新覆盖共享触发器的高度、边框、字号或圆角。
- 单选与多选筛选框统一 32px 高度、1px 边框、8px 圆角、13px 字号。禁止双层边框、反复增加选择器权重和 `!important`。
- `npm run check:web-presentation` 必须校验共享规则所有权、CSS 导入顺序及筛选器几何；桌面验收要通过 `getComputedStyle` 检查最终生效的样式，而非仅匹配源码字面值。

### Design Token

`packages/web/src/tokens.css` 是正式运行时 Design Token 基线。页面和组件消费语义 Token，不维护自己的品牌色板。

公共控件尺寸基线：

- 标准按钮：`30px / 12px`
- 紧凑按钮：`26px / 12px`
- 统一筛选（智能体 / 项目）：`32px / 13px`
- 通用文本输入：`34px / 13px`
- 正文：`14px`
- 列表 / 表格：`13px`
- 辅助文字：`12px`

### 设计资料边界

高保真原型、设计探索、内部 Checklist 只存放在 `z7ping/product-internal`，不得复制到本公开仓库。

如果当前会话可以访问 `z7ping/product-internal`，修改表现层前应阅读：

- `agent-lens/docs/design/UI-UX-PROPOSAL.md`
- `agent-lens/docs/design/README.md`
- 当前 UI 修改再读 `UI-UX-CONTRACT.md`、`UI-UX-CHANGE-PLAN.md` 与相关 Phase 验收文档；`ALPHA3-*` 文件仅在追溯历史决策或验收依据时读取

真实功能 / 字段 / 数据语义以本仓库正式实现为依据；视觉、信息层级、公共控件和响应式以有效设计规范为依据。

## UI 修改前检查

修改页面之前必须先回答：

1. 现有 `packages/web/src/components` 或 Task Surface 是否已经有同类组件？
2. 是否可以扩展现有组件而不是新造一个？
3. 样式是否已经有 Token / Primitive 所有者？
4. 是否会引入第二套尺寸、状态或响应式规则？
5. 相邻状态、Label、Badge、Pill、按钮是否形成了清晰的“组内间距 < 组间间距”，并且所有视觉间距都由样式明确持有？

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

- **Issue 交付标准（#523）**：代码需求完成并合并 PR 后即可关闭 Issue，不等待 CI/Actions 或用户手工验收；Pi/Codex/Hermes 实际运行、跨端与视觉检查由用户自行验收。禁止把跳过手工验收理解成允许留下未实现的代码事项，或在 PR 中谎称已执行未执行的检查。

## 提交

提交信息、Issue / PR 说明优先中文。重要实现变化同步相关 Issue / Checklist，不允许实现进度只存在聊天上下文中。
