# ADR-0002：Web Plugin 与客户端状态模型

- 状态：Accepted
- 日期：2026-08-21

## 背景

AgentLens 1.0 的 Core、Storage、Source 与 Surface 已按 Cordis-native Runtime 重建，但 Web 仍以独立 Vite App 的形式由 HTTP Surface 直接接收 `staticDir`，运行边界不完整；同时当前 Web 直接以 Timeline DTO 驱动手工 DOM，难以继续承载 Session Master-Detail、实时任务复盘、Agent 概览和工具分析。

0.x 已验证的产品认知继续保留：顶部一级功能导航（任务复盘 / 工具分析 / Agent 概览）以及按 Agent、项目和 Session 浏览。1.0 不为了“重新设计”而推翻这些认知，只升级数据语义、布局和实时状态模型。

## 决策

### 1. Web 是一个完整的 Cordis Plugin

`@agent-lens/web` 本身作为 `surface` 类型的 Cordis-native Plugin 参与 AgentLens Application 装配：

```text
AgentLens Cordis Application
├─ storage-sqlite
├─ core-services
├─ source-codex
├─ source-claude
├─ source-pi
├─ projections
├─ surface-http
└─ web
```

`surface-http` 负责 HTTP Server、API、SSE 与静态资源挂载能力；`web` 通过 `ctx.http` 挂载自己的 SPA。关闭 Web Plugin 时 API 仍可独立运行。

Web 内部不再建立第二棵 Cordis Plugin Tree，也不在 1.0 阶段承诺第三方 UI Plugin API。

### 2. React 只作为 Renderer

浏览器端采用：

```text
Protocol / SSE
      ↓
React-free Client Model
      ↓
Immutable Snapshot
      ↓
useSyncExternalStore
      ↓
React Renderer
```

业务状态、Session 实时同步、批处理和快照生成不得散落在 React Component 的 `useEffect` 中。React Component 只消费稳定的产品 DTO / Snapshot 并负责交互与展示。

连续实时事件采用微任务/短窗口合批，避免“一条事件一次整页刷新”。未变化的数据结构尽量保持引用稳定；展开、滚动、Inspector 等阅读状态不得被实时数据更新破坏。

### 3. 产品语义由 Projection 提供

Web 不直接从 Canonical Observation 猜测 Turn、Session Tree 或 Agent 特殊语义。服务端增加面向产品的 Read Model：

- ReviewProjection：Session / Interaction / Message / Tool / Lifecycle 任务复盘；
- FacetProjection：Agent / Project / 时间等筛选项；
- AgentOverviewProjection：安装、能力与资产状态；
- SessionRelationshipProjection：Pi 等来源的 Session/Branch 关系；
- UsageProjection：工具调用、成功失败、耗时与 Session 覆盖。

Web 只消费 `@agent-lens/protocol` 与 `/api/v1/*`。

### 4. Web 产品 Shell 保留两级顶部结构

```text
一级：AgentLens | 任务复盘 | 工具分析 | Agent 概览 | 状态/设置
二级：Agent 快捷入口 | 当前页面筛选/操作
```

Agent 快捷入口固定包含“全部”，其余按本机检测结果初始化，用户可调整。必须区分：

- Supported：是否有 AgentLens Source；
- Enabled：Source Plugin 是否启用；
- Detected：本机是否检测到；
- Pinned：是否显示在 Web 快捷入口。

`Pinned` 只属于客户端 UI Preference，不得改变采集状态。

任务复盘主体采用 `Session List | Session Detail` 两栏；Evidence / Raw Payload 使用临时 Inspector Drawer，不设置固定第三栏。

### 5. 前端技术基线

- TypeScript
- React
- Vite
- React Router
- Tailwind CSS
- `useSyncExternalStore`

不引入 Redux / Zustand；实时 Review 状态不依赖通用 Query Cache 驱动。普通只读查询如后续确有需要，可单独引入 TanStack Query。

## 结果

优点：

- Web 与 HTTP Surface 生命周期边界清晰；
- 保留 0.x 已验证的产品认知，不把 1.0 变成全新产品；
- 实时状态不绑死 React，未来替换 Renderer 的成本较低；
- Canonical Model、产品 Projection 与 Presentation 三层职责明确；
- 避免再次出现轮询/整页重绘破坏阅读上下文。

代价：

- 增加一层 Client Model 与产品 Projection；
- 需要维护稳定 DTO 和快照引用纪律；
- Web Plugin 与 HTTP Surface 之间新增 `ctx.http` 服务契约。

这些代价属于 AgentLens 长期实时观测场景的必要复杂度，优先于把状态和业务逻辑继续堆在页面组件中。
