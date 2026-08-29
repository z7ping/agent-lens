# AgentLens 1.0 架构

> 状态：1.0 Alpha 实现基线

AgentLens 是面向 AI 编码 Agent 的本地可观测与任务复盘工具。它观察已有 Agent 的运行事实，不接管 Codex、Claude Code、Pi 等工具的执行循环。

## 核心数据流

```text
Native Source
  -> SourceRecord
  -> SourceDefinition.normalize()
  -> IdentityService
  -> ObservationService.commit()
  -> Evidence + CanonicalObservation
  -> SQLite Repository
  -> Projection
  -> @agent-lens/protocol
  -> HTTP / SSE
  -> Web / Desktop
```

`CanonicalObservation` 是 AgentLens 的规范事实；`Evidence` 说明事实来自哪里以及如何得到。历史读取、实时 Hook、原生日志和静态资产发现都必须先进入同一条 Canonical Pipeline，不能各自维护第二份事实。

## 运行时

Cordis 是 AgentLens 1.0 唯一的插件运行时。Core Domain、Core Services、Repository Contract、Parser / Normalizer 和 Protocol DTO 保持框架无关；Source、Storage、Surface 等运行时扩展使用 Cordis-native Plugin 接入。

AgentLens 不在 Cordis 之外再维护第二套依赖注入、插件加载或生命周期系统。

## 主要模块

```text
apps/
  cli/            CLI 与 setup/service/autostart/hook 管理
  daemon/         组合根
  desktop/        Electron 桌面壳
  hook-codex/     Codex 被动 Hook
  hook-claude/    Claude Code 被动 Hook

packages/
  core/            领域模型与公共 Contract
  core-services/   核心服务实现
  runtime-cordis/  Cordis 运行时边界
  protocol/        对外 DTO
  storage-sqlite/  SQLite Repository
  source-*/        各来源解析、采集与资产发现
  projection-*/    只读派生模型
  surface-http/    HTTP / SSE Surface
  hook-manager/    Hook 配置管理
  web/             React Web 界面
```

稳定 Core Contract 见 [`docs/1.0/CORE-CONTRACT.md`](docs/1.0/CORE-CONTRACT.md)。

## Source 边界

所有来源都通过同一套 `SourceDefinition` Contract：

```text
detect
  -> declareCapabilities
  -> ingestHistory?
  -> startCapture?
  -> discoverAssets?
  -> normalize
```

当前主要来源包括 Codex、Claude Code 和 Pi。新增来源通常只应新增 Source package 并在组合根注册，不应要求 Runtime Runner 增加来源专用分支。

静态资产发现只说明“安装或存在了什么”，不能冒充实际 Usage。

## Storage 与 Projection

1.0 使用独立 SQLite Schema。业务功能通过 Repository Contract 访问数据，不得绕过规范仓储直接建立第二事实源。

Projection 是从 Canonical 数据派生出的只读模型。性能优化允许增加可重建 Reader、索引或缓存，但这些结果必须能够由 Canonical 数据重建。

## Protocol 与 Web

Web 只消费 `@agent-lens/protocol` 与 `/api/v1/*`，不得直接访问 SQLite、Source package 或 Core Repository。

HTTP Surface 默认监听：

```text
127.0.0.1:56789
```

实时更新通过 SSE 传递。界面不能为了性能绕过 Projection 或 Canonical Pipeline。

## npm / Desktop 共用运行时

npm/CLI 与 Desktop 是两种发行方式，不是两套产品运行时。它们共用：

- Core；
- Cordis Runtime；
- Protocol；
- Web；
- Canonical 数据模型；
- 默认数据目录 `~/.agent-lens/1.0/`；
- 默认 HTTP 地址。

同一台机器同一时刻只允许一个兼容 Daemon 占用默认运行时。Desktop、前台 CLI 或系统托管服务启动前都必须先探测已有 Daemon：兼容则复用，不兼容则明确报告冲突，不能通过换端口偷偷启动第二套事实链。

系统后台管理只属于运维层：Windows 使用当前用户计划任务，Linux 使用 `systemd --user`，macOS 使用 LaunchAgent。Hook Runner、托盘、自启动和安装器都不能成为新的 Runtime 或数据事实源。

## 架构护栏

- Web / Surface 不得绕过 Projection 直接访问 SQLite。
- Source 不得绕过 Canonical Pipeline 直接制造展示事实。
- Evidence 与 Canonical Observation 必须保持分离。
- 缓存或持久化 Projection 必须可由 Canonical 数据重建。
- npm 与 Desktop 不得形成双 Runtime、双 Schema 或重复采集链。
- Hook 必须保持被动、廉价，不承担 Daemon 生命周期。
- 真实运行诊断和 AgentLens 自身性能数据不得混入 Canonical Observation。
- 修改 Core Contract、Canonical Identity、Evidence 语义或 Runtime 所有权时，必须做明确的架构审查。

## 非目标

AgentLens 1.0 不承诺获取来源未暴露的信息，也不尝试获取隐藏思维链。未实现稳定 Source Contract 的来源不应被文档描述为已经支持。

详细设计过程、历史 ADR、原型与内部产品资料不属于公开代码仓库；公开仓库以源码、测试、CI、稳定 Contract 和本文件描述的当前实现边界为准。
