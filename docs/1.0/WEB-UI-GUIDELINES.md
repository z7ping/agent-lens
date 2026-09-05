# AgentLens Web UI 规范

本文约束 `packages/web` 的正式界面实现。目标不是限制视觉表达，而是避免同一类交互在不同页面形成多套图标、尺寸、线宽和浏览器表现。

## 图标

### 唯一入口

操作、导航、展开/收起类图标统一走：

`业务组件 → UiIcon → lucide-react`

- `packages/web/src/components/UiIcon.tsx` 是通用 UI 图标的唯一映射入口。
- 业务组件不得直接从 `lucide-react` 导入图标。
- 新增通用图标时，先在 `UiIconName` 和 `icons` 映射中注册，再由业务组件通过 `UiIcon` 使用。
- 领域组件可以继续封装语义，例如 `ToolKindIcon`，但其图形最终仍应由 `UiIcon` 提供。

### 禁止

正式 Web UI 中，操作、导航、展开/收起图标禁止使用以下实现：

- 业务组件内手写 `<svg>` / `<path>`。
- 用 CSS 边框、伪元素、旋转等方式手绘箭头、关闭、菜单等操作图标。
- `data:image/svg+xml`、CSS `mask` / `-webkit-mask` 内嵌操作图标。
- Unicode、字符或文本符号冒充图标。
- 直接暴露浏览器原生 `details/summary` marker 作为正式展开/收起图标。
- 在 `UiIcon.tsx` 之外直接 import `lucide-react`。

### 允许的非图标图形

以下内容属于状态、数据编码或品牌资产，不要求迁移到 Lucide：

- 来源颜色点、在线/错误/步骤状态点。
- 时间线节点、进度条、统计柱、图表及其它数据可视化图元。
- 品牌 Logo、产品 Logo 和正式品牌源资产。
- 分割线、连接线、背景装饰、纯排版标点等不承担操作语义的图形。

判断原则：**用户会把它理解为“可执行动作或导航提示”时，必须走 `UiIcon`；只是表达状态、数值或品牌身份时，不机械图标化。**

### 展开 / 收起

自定义 `details/summary` 必须显式提供统一图标：

- 默认使用 `UiIcon name="chevron-right"`。
- 展开时由 CSS 对图标节点旋转 `90deg`，不得重新画第二个箭头。
- 必须隐藏原生 `summary::marker` 和 `::-webkit-details-marker`，避免浏览器双图标或跨浏览器差异。
- 动画必须尊重 `prefers-reduced-motion`。

### 尺寸与颜色

- `UiIcon` 默认线宽由统一组件维护，业务组件不要随意覆盖；当前默认 `strokeWidth = 1.75`。
- 紧凑控件和表格通常使用 `12–14px`；普通工具栏和按钮通常使用 `14–16px`；主要操作可按需要使用 `18–20px`。
- 图标优先继承 `currentColor`，状态色由容器或业务 CSS 控制，避免在 JSX 内硬编码颜色。
- 同一交互层级尽量保持一致的尺寸和视觉重量。

### 可访问性

- `UiIcon` 默认作为装饰图形：`aria-hidden="true"`、`focusable="false"`。
- 只有图标的按钮必须提供准确的 `aria-label`；需要悬停解释时同时提供 `title`。
- “图标 + 文本”按钮由文本承担可访问名称，不为图标重复声明名称。
- 图标不能成为唯一的状态信息来源；错误、成功、运行中等状态还应有文字、可访问名称或其它非颜色信号。

## 新增或修改图标的流程

1. 先判断是否属于操作 / 导航 / disclosure 图标；状态或数据图形不机械迁移。
2. 检查 `UiIconName` 是否已有等价语义。
3. 没有时在 `UiIcon.tsx` 注册 Lucide 图标和 AgentLens 语义名。
4. 业务组件只引用 AgentLens 语义名，不直接依赖 Lucide 导出名。
5. 检查 hover、disabled、active、open、暗色/亮色和 reduced-motion 表现。
6. 提交前做一次图标违规扫描。

## 审计检查项

修改 Web UI 时至少检查：

- `packages/web/src` 中是否新增业务层 `<svg>` / `<path>`。
- 是否新增 `data:image/svg+xml` 或用于操作图标的 `mask: url(...)`。
- 是否出现通过 `border-* + rotate()` 等方式绘制操作箭头。
- 是否存在 `UiIcon.tsx` 之外的 `lucide-react` 导入。
- 自定义 `<summary>` 是否仍使用浏览器 marker，或隐藏 marker 后没有显式 `UiIcon`。
- 是否使用字符、Unicode 作为按钮图标。

发现违规时应在当前改动中收口，不再新增第三套图标实现。
