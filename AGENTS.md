# AGENTS.md

本文定义 AI 编码 Agent 修改 AgentLens 1.0 时必须遵守的工作规则。

## 1. 当前项目状态

AgentLens 1.0 是一次 **Clean Rebuild（彻底重建）**。

当前 `main` 已进入 **v2.1 表现层收敛 + 1.0 稳定化** 阶段。默认目标是整理现有实现、修复缺陷、提高数据与运行稳定性，不继续扩功能，不重新设计已经确定的 1.0 架构。

0.x 的旧 Runtime / UI / Test 已从 1.0 工作树移除，不再作为可直接复用的实现存在。需要参考 0.x 的解析行为、fixture、UI 思路或迁移逻辑时，请通过 Git 历史 / Tag 查阅，并重新按 1.0 Contract 验证后再选择性迁移。

禁止为了“兼容旧实现”重新恢复以下架构：

- 旧 Adapter / Importer Runtime；
- 旧 `timeline` / `overview_*` 规范表；
- 旧 service manager / PID 架构；
- 旧 HTTP Response Shape；
- 根目录 `server/`、`src/`、`test/` 作为 1.0 Runtime / UI / Test 入口。

## 2. 修改架构前必须阅读

依次阅读：

1. `ARCHITECTURE.md`
2. `docs/1.0/CORE-CONTRACT.md`
3. `docs/adr/0001-agentlens-1.0-clean-rebuild-and-cordis-runtime.md`
4. 涉及 npm / Desktop 生命周期时阅读 `docs/adr/0004-dual-distribution-single-runtime-lifecycle.md`

如果实现与这些文档冲突，不要静默绕过 Contract。要么修复实现 Bug，要么明确发起 Contract Review / ADR。

## 3. 架构规则

### Cordis

- 精确锁定 `@deepseek-ai/cordis@4.0.1`。
- Cordis 是唯一的 Plugin Runtime；AgentLens 1.0 本身是 Cordis Application。
- **Core is framework-agnostic; runtime extensions are Cordis-native.**
- Core Domain / Core Services、Repository Contract、Parser / Normalizer、Protocol DTO 必须保持与 Cordis 无关。
- Source / Storage / Surface 等需要运行时生命周期的插件入口可以直接依赖 Cordis / `runtime-cordis` Context typing，并使用 `ctx`、`inject`、dispose 生命周期。
- 不得再引入 `defineSourcePlugin()`、`defineStoragePlugin()`、`defineSurfacePlugin()` 之类通用适配层，把 Cordis Plugin 再包装成第二套 AgentLens Runtime Model。
- `defineAgentLensPlugin()` 仅允许作为 metadata / API-version compatibility helper，不得扩展成第二套 Lifecycle / DI / Plugin Loader。
- 不得再引入第二套 DI Container、Plugin Loader 或 Lifecycle Runtime。

### Canonical Data Flow

```text
SourceRecord
-> SourceDefinition.normalize()
-> ObservationCandidate + EvidenceCandidate
-> IdentityService
-> ObservationService.commit()
-> CanonicalObservation + Evidence
-> Projection
-> Protocol DTO
-> Surface/Web
```

Cordis-native 不意味着插件可以绕过这条链路。Source 不得直接写 Canonical Repository 或展示表；Storage / Surface 也不得反向拥有 Canonical Domain。

### Evidence

每一条规范事实都必须能由 Evidence 解释。

同一事实的第二条采集路径应该增强 Evidence，而不是创建重复 Observation。

### Projections

Projection 是可重建的读模型，不是额外的规范写入路径。

### Protocol

Web / Surface 消费 `@agent-lens/protocol` DTO。浏览器代码不得直接 import Core、SQLite 或 Source package。

## 4. 新增 Source

正常情况下，一个 Source 只需要新增：

```text
packages/source-<name>/
```

并在 Daemon Composition Root 中注册它导出的 Cordis Plugin。

推荐结构：

```text
packages/source-<name>/
  parser / history / normalize / assets   # 纯 TypeScript / Core Contract
  plugin entry                            # Cordis-native
```

它仍应实现稳定的 `SourceDefinition` Contract：

```text
detect
declareCapabilities
ingestHistory? / startCapture? / discoverAssets?
normalize
```

插件入口负责把 `SourceDefinition` 注册到 `ctx.sources`，不得自行复制 History / Runtime Runner、Identity、Observation Commit 或 Dedup 流程。

通用 Source Runner 中不得出现 `if (sourceId === ...)` 之类的来源分支。

如果某个新 Source 无法在不歪曲事实的前提下适配现有 Contract，应停止普通接入流程，按 Contract Review 处理。

## 5. 当前 1.0 Source

已实现：

- Codex
- Claude Code
- Pi

不能因为 0.x 曾经支持过，就视为已经属于 1.0 Runtime：

- Hermes
- OpenCode
- Cursor
- OpenClaw

## 6. Hook 规则

Hook 子进程只是被动采集 Shim。

允许做：

- 读取 stdin / 原生事件数据；
- 清洗 / 截断敏感字段；
- 原子写入 durable inbox；
- 返回中性结果。

不得依赖：

- Cordis；
- SQLite；
- Core Services；
- HTTP；
- Daemon 生命周期。

Inbox 条目只有在成功完成 Canonical Ingestion 后才能确认并删除。

## 7. Asset 规则

绝不能把“静态发现”直接等同于“实际调用”。

例如：

- 已安装 Skill -> Asset state；
- 已配置 MCP -> Asset state；
- 调用 `mcp__server__tool` -> 可归因的 MCP Usage；
- 普通 Bash 调用 -> 仅算 Tool Usage，除非有明确 Evidence 能证明对应 Asset。

## 8. Storage 规则

使用 Core Repository Interface。

除了 storage package 自己在实现 Repository，不得绕过 `StorageService` 在业务代码里直接写功能专用 SQL。

Storage Plugin 可以直接使用 Cordis 生命周期提供 `ctx.storage`，但 SQLite Repository 实现本身不应依赖 Cordis。

不得重新引入旧 `timeline` / `overview` 表作为 1.0 规范事实。

## 9. UI 规则

1.0 Web 使用 Vite + React + TypeScript，只消费 `/api/v1/*`。

当前面向用户的主视图使用简体中文：

- 执行轨迹；
- 会话；
- 工具与能力。

当前表现层收敛遵循以下固定方向：

- 任务复盘保持高信息密度，目标是降低视觉噪音，不是隐藏信息；
- 用户消息气泡在右侧，智能体消息气泡在左侧；
- 保留长会话 `turn-rail`，不得为了“简化”删除；
- 工具类型使用 SVG 徽章，不使用字符占位作为正式图标；
- Evidence、生命周期、工具执行、轮次等 Agent 特有信息必须保留；
- 字体与字号统一由正式语义字号系统收口，普通界面文字不得回退到 12px 以下；
- 会话列表与会话详情在桌面端必须保持独立滚动上下文；
- 不通过新增叠层补丁长期解决视觉冲突；新增样式前先确认现有收口层职责和加载顺序。

实时更新使用 SSE，但 SSE 事件不得直接触发整页 / 整个内容区反复重绘。

- 执行轨迹应优先做增量 DOM 协调，保留滚动位置、Evidence 展开状态和当前阅读上下文；
- 会话 / 工具与能力如果暂时无法安全增量更新，应只提示“有新数据”，由用户显式刷新；
- 除非有明确性能数据和正式决策，不要改回短间隔轮询。

## 10. CLI / Desktop 规则

CLI：

```text
agent-lens setup
agent-lens start
agent-lens status
agent-lens doctor
agent-lens service start|stop|restart|status
agent-lens autostart enable|disable|status
agent-lens hook ...
```

`setup` 是一次性初始化入口：检查 Node.js 与数据目录，识别 Codex / Claude Code / Pi，本机存在 Codex / Claude Code 时只补齐 AgentLens 自己缺失的 Hook，并报告已有运行时。Pi 使用原生 History / Runtime Tail，不安装 Hook。

`setup` 不自动启动长期 Daemon，也不默认打开 npm 登录自启；后台生命周期通过独立 `service` / `autostart` 命令管理。不得把 `setup` 扩展成 0.x service manager 的新包装。

`start` 明确以前台方式运行。启动前必须先探测默认运行时；已有兼容 Daemon 时直接复用，不启动第二套。

npm 后台生命周期只属于发行 / 运维层：

- Windows：当前用户计划任务；
- Linux：`systemd --user`；
- macOS：用户级 `launchd`；
- 不维护 PID 文件，不恢复 0.x Service Manager；
- 系统托管入口统一执行 `service run`，由 Daemon Health 报告 `owner=service`、`mode=managed`；
- `service restart` 遇到 Desktop / 前台 CLI 所有的现有运行时不得强行接管；
- `autostart` 只控制登录后是否自动启动，不等同于“当前是否运行”。

源码模式注册 `service` / `autostart` 前必须先生成正式 `dist/cli.mjs`，不要把临时 `tsx` 开发入口注册到系统启动项。

npm 与 Windows Desktop 可以同时安装，但同一默认数据根 / 默认端口同一时刻只允许一个有效 Daemon。Desktop 只能停止自己启动的 Daemon，不得误杀 npm / service 管理的外部运行时。

Electron 只负责 Windows Desktop Lifecycle。不要把 Core / Source 逻辑搬进 `apps/desktop`。

## 11. 常用开发命令

```bash
npm install
npm run typecheck
npm test
npm run build:dist
npm pack --dry-run
npm run build:web
npm run cli -- setup
npm run cli -- doctor
npm run cli -- service status
npm run cli -- autostart status
npm run desktop:win      # Windows runner
```

Node.js 要求：`>=22.23.0`。

## 12. 语义变更必须覆盖的测试

修改以下内容时需要新增 / 更新测试：

- normalization mapping；
- dedup key；
- identity resolution；
- history / runtime reconciliation；
- checkpoint 行为；
- Asset 归因；
- Projection 排序 / 分组；
- Hook install / uninstall 安全性；
- CLI 初始化目标选择与幂等性；
- Windows / systemd / launchd 生命周期定义生成；
- 运行时所有权与互斥接管规则；
- Protocol / API 行为；
- Cordis compatibility。

关键不变量：

```text
same native semantic event from multiple evidence paths
=> one CanonicalObservation + multiple Evidence records
```

即：同一原生语义事件来自多条 Evidence Path 时，只产生一条 `CanonicalObservation`，但保留多份 `Evidence`。

## 13. 文档与协作纪律

任何改变架构所有权 / 边界的决策，都必须同步更新：

- `ARCHITECTURE.md`；
- `docs/1.0/IMPLEMENTATION-STATUS.md`；
- Contract 变化时更新 `docs/1.0/CORE-CONTRACT.md`；
- 对长期、难以逆转的决策补充 ADR。

不要把“计划能力”写成“已实现能力”。不要让已删除的 0.x 路径继续出现在当前开发说明中，除非明确标注为 Git 历史参考。

提交信息统一使用中文；Pull Request 的标题和正文也统一使用中文。代码标识符、API、类型名、命令保持英文即可。

## 14. 分支 / 发布安全

当前 1.0 已在 `main` 进入表现层收敛和稳定化阶段。仓库所有者明确要求直接在 `main` 收敛时，可以在核对最新 HEAD 后提交；不得依据旧文档自动切回已完成使命的历史工作分支。

默认不新增功能、不改大版本架构、不发布。

未经仓库所有者明确要求，不得发布 npm、创建 GitHub Release、修改 Release Secret 或执行其它发布动作。
