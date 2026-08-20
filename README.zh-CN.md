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
- 哪些 Skill / MCP 能够被可靠归因为“实际使用过”。

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

当前 Web 界面使用简体中文，主要提供三个视图。

### 执行轨迹

按真实事件时间展示 Canonical Observation，并显示 Evidence、capture method、derivation、confidence 和 source locator。原始 Payload 与 Evidence 默认收起，需要时再展开查看。

### 会话

基于 Canonical Observation 派生 Logical Session 和 Interaction。用户消息是主要 Interaction 边界；用户消息之前的可观察自主行为可以形成 background interaction。会话可以直接跳转到对应执行轨迹。

### 工具与能力

展示 Tool 调用/结果、成功失败、耗时、来源，以及能够可靠归因的 Skill / MCP 使用情况。

页面通过 SSE 接收实时变化。执行轨迹采用增量 DOM 协调，避免新事件到来时整页重绘、打断滚动位置和 Evidence 展开状态；会话与工具视图在不能安全增量更新时只提示有新数据，由用户显式刷新。幂等重放得到 `unchanged` 时不会制造无意义刷新。

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
  -> Web / Desktop
```

Cordis 是唯一 Plugin Runtime，固定依赖 `@deepseek-ai/cordis@4.0.1`。AgentLens Core 保持框架无关；Source / Storage / Surface 等运行时扩展入口直接采用 Cordis-native Plugin，`packages/runtime-cordis` 负责共享 Context typing、元数据和兼容性测试，不再额外包一层通用 AgentLens Plugin Runtime。

详细文档：

- [1.0 架构](ARCHITECTURE.md)
- [Core Contract](docs/1.0/CORE-CONTRACT.md)
- [ADR-0001：Clean Rebuild 与 Cordis Runtime](docs/adr/0001-agentlens-1.0-clean-rebuild-and-cordis-runtime.md)

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
  cli/ daemon/ web/ desktop/ hook-codex/ hook-claude/
packages/
  core/ core-services/ runtime-cordis/ protocol/
  storage-sqlite/
  source-codex/ source-claude/ source-pi/
  projection-timeline/ projection-session/ projection-usage/
  surface-http/ hook-manager/
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
