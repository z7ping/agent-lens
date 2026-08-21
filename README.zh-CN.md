<h1 align="center">AgentLens</h1>

<p align="center"><strong>本地 AI 编码 Agent 的观测与执行轨迹查看器。</strong></p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md"><strong>简体中文</strong></a>
</p>

> **1.0 alpha：** AgentLens 1.0 是一次 Clean Rebuild，以 Canonical Observation + Evidence 为核心。0.x 只保留为实现参考和回归材料，不再进入 1.0 运行时。

## AgentLens 解决什么问题

不同 AI 编码工具的数据散落在 Hook、JSONL、SQLite、配置文件中。AgentLens 把这些**可观察数据**统一成一套有证据来源的执行模型，用来回答：

- 一次任务到底发生了什么；
- 这条事实来自哪个原生来源；
- Runtime Hook 和历史日志是不是同一件事；
- 哪些 Tool 真正调用过、哪些失败了；
- 哪些 Skill / MCP 已安装或配置，哪些又能够被可靠归因为“实际使用过”。

AgentLens 不负责执行 Agent，也不会声称可以读取模型未暴露的隐藏思维链。

## 1.0 已支持的 Source

| Source | History | Runtime | Assets |
| --- | --- | --- | --- |
| Codex | 原生 Session JSONL | Runtime Hook + Durable Inbox | Skill、MCP、Plugin、Hook、Rule |
| Claude Code | Project/Session JSONL | Runtime Hook + Durable Inbox | Skill、MCP、Plugin、Hook、Command |
| Pi | 原生 Session JSONL | 持续尾读原生 JSONL | Skill、Extension、MCP、Memory 类资产 |

0.x 中的 Hermes、OpenCode、Cursor、OpenClaw 等**不自动算作 1.0 已支持**。后续必须重新按照 1.0 Source Contract 接入。

## 快速开始

要求 Node.js **22.23+**。

### npm 安装

```bash
npm install -g @z7ping/agent-lens

agent-lens doctor
agent-lens hook install all
agent-lens start
```

打开：

```text
http://127.0.0.1:56789/
```

`agent-lens start` 设计为前台运行。1.0 CLI 不伪装成跨平台 service manager；Windows 后台生命周期由桌面应用负责。

### 源码运行

```bash
npm install
npm run typecheck
npm test
npm run build:web
npm run dev
```

源码环境使用 CLI：

```bash
npm run cli -- doctor
npm run cli -- hook install all
npm run cli -- start
```

## Windows 桌面版

Windows Release Workflow 会生成 x64 NSIS 安装包：

```text
AgentLens-<version>-Setup-x64.exe
```

Electron 只承担桌面壳职责：

- 单实例；
- BrowserWindow；
- 系统托盘；
- Daemon 启停/重启；
- 日志和数据目录入口。

AgentLens Core、Source、SQLite、HTTP/SSE 不搬进 Electron 私有实现中，桌面版和 CLI/npm 版仍然使用同一个 Daemon。

卸载桌面应用不会自动删除 `~/.agent-lens/1.0` 中的观测数据。

## Web 1.0

Web 本身是独立的 Cordis Surface Plugin：`@agent-lens/web`。它通过 `ctx.http.mountStatic()` 挂载 React SPA；不开 Web 时 HTTP/API 仍可独立运行。Web 只消费 `@agent-lens/protocol` DTO，不直接依赖 Core、SQLite 或 Source 实现。

当前技术栈：React 19 + Vite + Tailwind CSS。业务状态放在 React 外的 `AgentLensClientModel` 中，React 通过 `useSyncExternalStore` 订阅，因此实时数据流不依赖组件级状态拼接。

界面采用两级顶部结构：一级是产品导航，二级是 Agent 快捷入口与当前页面筛选。Agent 快捷入口会根据本机扫描结果自动初始化，用户也可以自行 Pin 常用 Agent；是否 Pin 只影响界面展示，不控制 Source 是否启用。

### 任务复盘

采用 `Session List | Session Detail` 左右布局，以 Session / Interaction 为主要阅读结构：

- 用户与 Agent 消息以对话形式展示；
- 连续 Tool Call 归为执行过程，可展开查看结果、错误与耗时；
- Permission、Subagent、Context、Model 等生命周期事件穿插在真实执行流中；
- Codex、Claude Code、Pi 保留各自有意义的事件标签；
- Pi 可展示原生 parent/session relationship；
- Evidence 与 Raw Payload 放在临时 Inspector 中，默认不打断主阅读流。

支持按 Agent、项目、时间、错误状态和关键字筛选，不再要求用户手工输入 installationId / logicalSessionId。

### 工具分析

基于 Canonical Observation 统计真实 Tool 使用情况，包括调用次数、涉及 Session、成功/失败、总耗时与平均耗时，并支持 Agent、项目和时间范围筛选。

当前优先展示可证实事实；0.x 中的价值分、风险分、工作流候选等启发式分析不会未经重新设计直接搬回 1.0。

### Agent 概览

展示本机 Agent 的：

- 检测状态与 Installation 信息；
- Source 声明的可观测 Capability；
- 静态扫描得到的 Skill / MCP / Plugin / Extension / Hook 等能力资产；
- Asset Binding 路径、版本及 installed/configured/enabled/discoverable 等状态；
- 能够由 Evidence 可靠归因的 Skill / MCP 实际使用记录。

“装了 / 配了”和“真正用过”在模型与界面中保持分离。

### 实时更新

Web 使用 SSE 接收 Observation、Source Detection 与 Asset 变化。SSE 会在首屏 Snapshot 请求前建立，避免启动扫描期间出现 API → SSE 的事件盲区。

`AgentLensClientModel` 对高频事件做短窗口合批：任务复盘、工具统计和 Agent 资产分别按各自节奏更新；React 只消费稳定 Snapshot，不通过整页 DOM 替换制造“自动刷新页面”的体验。页面退出时主动关闭 SSE。

## CLI

```text
agent-lens start
agent-lens status [--json]
agent-lens doctor [--json]
agent-lens hook status [codex|claude|all] [--json]
agent-lens hook install [codex|claude|all]
agent-lens hook uninstall [codex|claude|all]
```

Hook 安装是幂等的，只修改 AgentLens 自己的 handler；同一个 Hook group 中的第三方 handler 会被保留。Codex trust hash 也只维护 AgentLens 对应条目。

## 一张图理解 1.0

```text
Native Source
  -> SourceRecord
  -> SourceDefinition.normalize()
  -> ObservationCandidate + EvidenceCandidate
  -> IdentityService
  -> ObservationService.commit()
  -> CanonicalObservation + Evidence
  -> SQLite repositories
  -> Projections
  -> @agent-lens/protocol
  -> HTTP / SSE
  -> @agent-lens/web / Desktop
```

Cordis 是唯一 Plugin Runtime，固定依赖 `@deepseek-ai/cordis@4.0.1`。AgentLens Core 保持框架无关；Source / Storage / Surface 等运行时扩展入口直接采用 Cordis-native Plugin，`packages/runtime-cordis` 负责共享 Context typing、元数据和兼容性测试，不再额外包一层通用 AgentLens Plugin Runtime。

详细文档：

- [1.0 架构](ARCHITECTURE.md)
- [Core Contract](docs/1.0/CORE-CONTRACT.md)
- [ADR-0001：Clean Rebuild 与 Cordis Runtime](docs/adr/0001-agentlens-1.0-clean-rebuild-and-cordis-runtime.md)
- [ADR-0002：Web Plugin 与 Client State Model](docs/adr/0002-web-plugin-and-client-state-model.md)

## Evidence 是一等公民

Canonical Observation 表达“AgentLens 认为发生了什么”，Evidence 表达“为什么这么认为”。

例如：

```text
runtime-hook + observed
native-log  + reported
static-scan + observed
```

同一个 Tool Call 如果既被 Runtime Hook 看见、又出现在历史 JSONL 中，正确结果应该是：

```text
1 个 Canonical tool.call
+ 2 条 Evidence
```

而不是两条重复事实。

## “装了”不等于“用过”

静态扫描只能证明 Skill/MCP/Plugin/Hook 已安装、已配置或可发现，不能证明实际调用。

当前 Asset Usage 只在可以可靠归因时生成，例如：

- `mcp__server__tool` -> MCP server；
- Claude `Skill` Tool 明确传入 skill 名称 -> Skill usage。

普通 Bash / Read / Write 不会因为机器上装了某个 Skill 就被强行归进去。

## 本地数据

默认数据目录：

```text
~/.agent-lens/1.0/
├── agent-lens.db
└── inbox/
    ├── codex/
    └── claude/
```

HTTP 只监听 `127.0.0.1`，默认端口 `56789`。

Runtime Hook 进程只负责轻量脱敏和原子写 Durable Inbox；真正的 Canonical Persist 由 Daemon 完成。

## 开发命令

```bash
npm install
npm run typecheck
npm test
npm run build:dist
npm pack --dry-run
npm run desktop:win        # Windows runner
```

目录：

```text
apps/
  cli/ daemon/ desktop/ hook-codex/ hook-claude/
packages/
  core/ core-services/ runtime-cordis/ protocol/
  storage-sqlite/
  source-codex/ source-claude/ source-pi/
  projection-timeline/ projection-session/ projection-usage/
  projection-review/ projection-overview/
  surface-http/ web/ hook-manager/
```

## 发布流程

创建 GitHub Release 后：

1. Linux + Windows 验证；
2. typecheck / tests / distribution build；
3. 打出唯一 npm tarball；
4. 生成 SBOM 和 SHA-256；
5. 上传 GitHub Release artifacts；
6. 发布**同一个 tarball**到 npm；
7. Windows Workflow 构建并上传 NSIS Installer。

Release tag 必须与 `package.json` version 一致，允许 `v` 前缀。

## License

MIT
