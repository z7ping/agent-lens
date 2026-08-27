<p align="center">
  <img src="https://raw.githubusercontent.com/z7ping/agent-lens/main/docs/brand/logo/agentlens-logo.svg" width="128" alt="AgentLens Logo" />
</p>

<h1 align="center">AgentLens | 智能体透镜</h1>

<p align="center"><strong>看清 AI 编码智能体的每一次可观察行动。</strong></p>

<p align="center">本地优先的 AI 编码智能体观测、证据回溯与任务复盘工具。</p>

<p align="center">
  <a href="README.md"><strong>简体中文</strong></a> ·
  <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@z7ping/agent-lens"><img alt="npm version" src="https://img.shields.io/npm/v/@z7ping/agent-lens?logo=npm&color=cb3837" /></a>
  <img alt="Node.js version" src="https://img.shields.io/node/v/@z7ping/agent-lens?logo=node.js&logoColor=white" />
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/npm/l/@z7ping/agent-lens" /></a>
  <img alt="Local first" src="https://img.shields.io/badge/data-local--first-005DFF" />
  <img alt="Status alpha" src="https://img.shields.io/badge/status-alpha-FF8A1F" />
</p>

> [!IMPORTANT]
> AgentLens 1.0 目前处于 Alpha 阶段。1.0 是一次 Clean Rebuild，以 Canonical Observation + Evidence 为核心；0.x 仅作为经过验证的行为和设计参考，不进入 1.0 运行时。

## 为什么需要 AgentLens

Codex、Claude Code、Pi、Hermes、OpenCode 等工具把会话、工具调用和能力配置分散在 JSONL、SQLite、Hook 与配置目录中。AgentLens 把这些**可观察事实**整理成统一、可追溯的视图，帮助你回答：

- 智能体刚才做了什么，在哪一步失败？
- 一次长任务经历了哪些轮次、工具调用和生命周期事件？
- 某条结论来自历史记录、原生尾读还是 Runtime Hook？
- 本机安装了哪些 Skill、MCP、Plugin；哪些真正被调用过？
- 哪些数据完整、哪些只有部分覆盖、哪些来源当前不可用？

AgentLens 展示的是来源能够证明的行为，不声称读取隐藏思维，也不会把推测包装成事实。

## 30 秒开始使用

### 桌面版

前往 [GitHub Releases](https://github.com/z7ping/agent-lens/releases) 下载与你的平台和架构匹配的安装包：

- Windows x64：`AgentLens-<version>-Setup-x64.exe`
- macOS：Apple Silicon / Intel 对应的 DMG
- Linux：x64 / arm64 对应的 AppImage 或 DEB

桌面版和 npm 版共用同一套 Runtime、默认数据目录与数据模型；同时安装也不会创建第二套数据库。

### npm / CLI

需要 Node.js 22.23.0 或更高版本：

```bash
npm install -g @z7ping/agent-lens
agent-lens setup
agent-lens service start
```

然后打开 <http://127.0.0.1:56789>。

`setup` 只完成一次性初始化，不会自动启动长期 Daemon，也不会默认开启登录自启。需要前台调试时使用 `agent-lens start`。

检查运行状态：

```bash
agent-lens status
agent-lens doctor
```

## 你会看到什么

| 页面 | 用途 |
| --- | --- |
| **任务复盘** | 按会话与轮次还原用户消息、智能体消息、工具执行、错误、Evidence 与生命周期事件；长会话保留轮次导航。 |
| **工具分析** | 查看工具调用量、成功/失败、来源分布与可可靠归因的能力使用。 |
| **使用洞察** | 从时间、来源与活动趋势观察使用情况，不把缺失数据误当成零。 |
| **智能体概览** | 查看本机智能体的检测状态、采集方式、安装信息、资产清单与真实调用。 |
| **资产备份** | 管理可识别资产的本地备份与恢复边界。 |

界面默认使用简体中文，并保留 Evidence、覆盖范围、错误与来源状态等 Agent 特有信息。实时更新使用 SSE；任务复盘优先增量协调，避免刷新整页破坏当前阅读位置。

## 当前支持的来源

| Source | History | Runtime | Assets |
| --- | --- | --- | --- |
| Codex | 原生 Session JSONL | Runtime Hook + Durable Inbox | Skill、MCP、Plugin、Hook、Rule |
| Claude Code | Project / Session JSONL | Runtime Hook + Durable Inbox | Skill、MCP、Plugin、Hook、Command |
| Pi | 原生 Session JSONL | 持续尾读原生 JSONL | Skill、Extension、MCP、Memory 类资产 |
| Hermes | 原生 SQLite 会话历史 | SQLite 原生尾读 + 可选 Runtime Hook | Skill、MCP、Plugin、Memory 等 |
| OpenCode | 原生会话 / 运行数据 | 原生运行数据增量采集 | 按 1.0 Source Contract 发现可识别资产 |
| DeepSeek Harness | Profile Session JSONL / JSONL.ZST | 按事件序号增量采集 | Profile Bundle、树外 Plugin、配置覆盖 |

不同来源能提供的事实并不完全相同。AgentLens 会明确区分完整、部分可用、来源不可用与未知，不会用合成数据填补空白。

## Evidence：每条事实都应能解释

AgentLens 1.0 的规范数据流：

```text
SourceRecord
  -> SourceDefinition.normalize()
  -> ObservationCandidate + EvidenceCandidate
  -> IdentityService
  -> ObservationService.commit()
  -> CanonicalObservation + Evidence
  -> Projection
  -> Protocol DTO
  -> Web / Surface
```

同一事实的第二条采集路径用于增强 Evidence，而不是制造重复 Observation。来源报告的原生 ID、原生类型、序号、时间戳、文件或表定位信息会尽可能保留，便于回查。

## “装了”不等于“用过”

AgentLens 把资产状态和真实使用分开：

```text
安装 / 配置 / 启用 / 可发现
            ≠
        有证据的调用
```

例如，发现某个 MCP 配置只能证明它存在；只有观察到可归因的 `mcp__server__tool` 调用，才会记为 MCP Usage。普通 Bash、Read 或 Write 不会因为机器上安装了某个 Skill 就被强行归因。

## 本地优先与隐私边界

- 默认数据目录：`~/.agent-lens/1.0/`
- 默认数据库：`~/.agent-lens/1.0/agent-lens.db`
- HTTP 默认仅监听：`127.0.0.1:56789`
- Hook 只负责轻量清洗、脱敏和原子写入 Durable Inbox
- Canonical Persist 由 Daemon 完成；Inbox 只有在成功入库后才确认删除
- Prompt、Tool、Config、Environment 使用独立采集档位；敏感字段在持久化前统一脱敏

AgentLens 不会为了接入而静默启用第三方 Hermes Plugin，也不会把“静态发现”直接等同于“实际调用”。

## 常用命令

```bash
# 一次性初始化
agent-lens setup [--json]

# 前台运行
agent-lens start

# 状态与诊断
agent-lens status [--json]
agent-lens doctor [--json]

# 系统托管的后台运行时
agent-lens service start|stop|restart|status [--json]

# 登录自启
agent-lens autostart enable|disable|status [--json]

# AgentLens 自己维护的 Native Hook
agent-lens hook status [codex|claude|all] [--json]
agent-lens hook install [codex|claude|all]
agent-lens hook uninstall [codex|claude|all]
```

Windows 后台使用当前用户计划任务，Linux 使用 `systemd --user`，macOS 使用用户级 `launchd`。AgentLens 不维护 PID 文件，也不会恢复 0.x Service Manager。

## 常见问题

<details>
<summary><strong>安装后为什么没有自动开始采集？</strong></summary>

`agent-lens setup` 只负责初始化。npm 版请运行 `agent-lens service start`，或使用 `agent-lens start` 前台调试；桌面版会在启动时探测并复用兼容的现有 Daemon。

</details>

<details>
<summary><strong>npm 版和桌面版可以同时安装吗？</strong></summary>

可以。它们共用默认数据根与端口，同一时刻只允许一个有效 Daemon。桌面版退出时也只停止自己启动的 Daemon，不会误杀 npm / service 管理的外部运行时。

</details>

<details>
<summary><strong>为什么某个资产显示“已安装”，却没有使用次数？</strong></summary>

因为存在不等于使用。只有得到明确 Evidence 支撑的调用才会计入使用次数。

</details>

<details>
<summary><strong>为什么有些来源只显示部分数据？</strong></summary>

不同工具暴露的原生事实不同，采集权限和内容策略也可能限制覆盖范围。AgentLens 会显示真实覆盖状态，而不是猜测缺失内容。

</details>

<details>
<summary><strong>Windows 安装后双击没有界面怎么办？</strong></summary>

先确认系统托盘是否已有 AgentLens，并查看 `<安装目录>\logs\desktop.log`。如果安装目录不可写，日志会回退到 `%APPDATA%\AgentLens\logs`；也可以用 `AGENT_LENS_LOG_DIR` 显式指定位置。如果同时安装了 npm / CLI，可再运行 `agent-lens status` 与 `agent-lens doctor` 检查 Daemon、存储和托管状态。若问题仍存在，请在 [GitHub Issues](https://github.com/z7ping/agent-lens/issues) 附上版本号、Windows 版本和日志中已脱敏的相关片段。

</details>

## 架构与开发

AgentLens 1.0 是 Cordis Application，精确使用 `@deepseek-ai/cordis@4.0.1` 作为唯一 Plugin Runtime。Core 保持框架无关；Source、Storage 与 Surface 通过 Cordis 生命周期组合，但不能绕过 Canonical Data Flow。

深入阅读：

- [架构总览](ARCHITECTURE.md)
- [1.0 Core Contract](docs/1.0/CORE-CONTRACT.md)
- [发行与运维](docs/1.0/DISTRIBUTION-OPERATIONS.md)
- [桌面发行矩阵](docs/1.0/DESKTOP-RELEASES.md)
- [贡献指南](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

本地开发：

```bash
npm install
npm run check:web-presentation
npm run typecheck
npm test
npm run build:dist
```

## License

[MIT](LICENSE)
