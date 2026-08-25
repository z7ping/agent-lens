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
| Hermes | 原生 SQLite 会话历史 | SQLite 原生尾读 + 可选 Runtime Hook | Skill、MCP、Plugin、Memory 等 |
| OpenCode | 原生会话/运行数据 | 原生运行数据增量采集 | 按 1.0 Source Contract 发现可识别资产 |
| DeepSeek Harness | Profile Session JSONL / JSONL.ZST，保留 Turn、Step、Tool、Usage、Request Header 与会话血统 | 监听发生变化的会话文件并按事件序号增量采集 | Profile Bundle、树外 Plugin、Profile 配置覆盖 |

DeepSeek Harness 的 `SessionHeader.cwd` 会映射为 AgentLens Workspace；`parentSessionId` 会作为原生父会话事实进入 `SourceSession.nativeParentSessionId`。AgentLens 保留这条血统，但不会仅凭“存在父会话”就把关系强行判定为子智能体。

DSH Profile 的 Bundle / Plugin 发现依据 Profile 自身 `package.json` 的 `dsh.profile.bundles` 与依赖声明；`cordis.patch.yml` 作为 Profile 配置覆盖记录。当前不会展开压缩 reasoning chunk，也不会在缺乏可靠事实时推断隐藏思维、权限事件或资产调用归因。

## 快速开始

要求 Node.js **22.23+**。

### npm 安装

```bash
npm install -g @z7ping/agent-lens

agent-lens setup
```

`agent-lens setup` 会完成一次性初始化：检查 Node.js 与数据目录，识别本机可用 Source，并只为需要 Hook 的来源补齐 AgentLens 自己的 Hook。原生 History / Runtime Tail 来源不会为了接入 AgentLens 强行修改第三方工具配置。

初始化完成后可以选择前台或后台运行：

```bash
# 前台运行，适合调试
agent-lens start

# 后台常驻，适合长期使用
agent-lens service start

# 可选：登录系统后自动运行
agent-lens autostart enable
```

查看状态：

```bash
agent-lens status
agent-lens service status
agent-lens autostart status
agent-lens doctor
```

`setup` 只负责初始化，不会自动替用户开启后台常驻或登录自启。`service` 负责“现在是否后台运行”，`autostart` 只负责“下次登录是否自动启动”，两者互相独立。

npm 后台生命周期直接使用操作系统原生的用户级托管能力：

- Windows：当前用户计划任务；
- Linux：`systemd --user`；
- macOS：用户级 `launchd`。

AgentLens 不恢复 0.x 的 PID / Service Manager 架构，也不会因为后台方式不同创建第二套 Runtime 或数据库。

打开：

```text
http://127.0.0.1:56789/
```

`agent-lens start` 设计为前台运行；启动前会先探测已有 AgentLens Daemon，兼容时直接复用，不启动第二套。npm 与 Windows Desktop 可以同时安装，但共享同一个默认数据根与默认运行时。

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
npm run cli -- setup
npm run cli -- doctor
npm run cli -- start
```

需要测试 `service` / `autostart` 时，先生成正式发行入口，避免把临时 `tsx` 开发命令注册进系统启动项：

```bash
npm run build:dist
npm run cli -- service status
npm run cli -- autostart status
```

## Windows 桌面版

Windows Release Workflow 会生成 x64 NSIS 安装包：

```text
AgentLens-<version>-Setup-x64.exe
```

### 本地构建 Windows 安装包

要求：

- Windows x64；
- Node.js **>= 22.23.0**；
- 已安装 npm 依赖。

在仓库根目录执行：

```powershell
node -v
npm install
npm run desktop:win
```

`npm run desktop:win` 会依次执行：

```text
Web 表现层收敛检查
-> Electron 主进程语法检查
-> 构建正式 dist
-> 准备桌面运行时
-> electron-builder
-> NSIS x64 安装包
```

生成的安装包位于：

```text
release/windows/
```

例如当前版本会生成类似：

```text
AgentLens-1.0.0-alpha.0-Setup-x64.exe
```

NSIS 安装器允许选择安装目录，并创建桌面快捷方式和开始菜单快捷方式。卸载 AgentLens 不会自动删除用户观测数据。

### 使用 GitHub Actions 构建

也可以不在本机准备 Windows 打包环境，直接在 GitHub 仓库中手动执行：

```text
Actions
-> Windows Installer
-> Run workflow
```

工作流会在 `windows-latest` 上完成依赖安装、表现层检查、桌面主进程检查、类型检查、测试和安装包构建，并上传：

```text
AgentLens-<version>-Setup-x64.exe
SHA256SUMS.txt
```

手动执行时可以从该次 Actions 运行的 Artifacts 下载；正式发布 GitHub Release 时，安装包和校验文件会自动附加到 Release。