# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## 项目概述

AgentLens 是一个实时监控和可视化 AI 编码工具调用的工具。通过钩入 Codex/Cursor 等工具的 PreToolUse 和 PostToolUse 生命周期事件，记录每次工具调用，并在浏览器仪表盘中展示。支持多工具适配器架构（Claude Code、Codex、Hermes、OpenCode、Cursor、Pi）。

**主要运行时依赖：better-sqlite3（原生 SQLite 模块，可选依赖中安装）。**

## 常用命令

```bash
# GitHub 源码安装（推荐的 GitHub 使用方式）
npm install && npm run build && node server/cli.js install

# npm Registry 安装
npx @z7ping/agent-lens install

# 源码运行与管理
node server/cli.js start              # 前台启动（开发调试用）
node server/cli.js start --daemon     # 后台守护进程
node server/cli.js start -d           # 后台守护进程（短参数）
node server/cli.js start 8080         # 指定端口（位置参数）
node server/cli.js start --port 8080  # 指定端口（选项）
node server/cli.js start --open       # 启动后打开浏览器
node server/cli.js stop               # 停止服务
node server/cli.js status             # 查看默认端口 56789 的状态
node server/cli.js package --output ./release  # 生成 .tgz 分发包
node server/cli.js help               # 完整帮助
node server/cli.js uninstall          # 卸载并清理

# Linux（systemd user service）/ macOS（launchd agent）
node server/cli.js service install    # 注册系统服务（开机自启）
node server/cli.js service start      # 启动服务
node server/cli.js service stop       # 停止服务
node server/cli.js service enable     # 启用开机自启
node server/cli.js service disable    # 关闭开机自启
node server/cli.js service status     # 查看状态
node server/cli.js service uninstall  # 移除系统服务

# Windows 使用当前用户启动目录 + daemon
agent-lens service install
agent-lens service start
agent-lens service status
```

安装完成后可把 `node server/cli.js` 替换为 `agent-lens`。Windows 支持全部 `service` 子命令，自启入口位于当前用户的“启动”目录，无需管理员权限。自定义端口启动时，当前 `status` 仍固定检查默认端口 56789。

前端需要 Vite 构建，测试使用 Node.js 内置 test runner。

### 开发模式

```bash
# 前后端联调（推荐）
npm run dev           # 同时启动后端 56789 和 Vite 5173
npm run dev:frontend  # 仅 vite dev server

# 构建生产版本
npm run build         # vite build → dist/
npm test              # 导入器测试 + Node.js test runner
```

Vite dev server 会代理 `/api`、`/logs`、`/states`、`/projects.json` 到后端 server.js。

### 自动守护（核心特性）

安装后，**无需手动启动服务器**：
- `hooks/prelog.js` 在每次工具调用时检测服务是否运行
- 如果服务未运行，自动通过已安装的 `agent-lens start --daemon` 在后台启动
- 服务写入运行时 `run/server.pid` 管理生命周期
- 服务挂掉后，下次工具调用会自动拉起

## 多工具支持

支持追踪以下 AI 编码工具：
- Codex（实时钩子）
- Hermes（定时轮询 state.db）
- Codex（实时钩子）
- OpenCode（定时轮询 opencode.db）
- Cursor（实时钩子）
- Pi（实时钩子）
- OpenClaw（骨架，待实现）

## 架构

系统是**基于钩子的四阶段管道 + 多工具适配器**：

### 管道阶段

1. **PreToolUse 钩子** (`hooks/prelog.js`) — 在每次工具调用前触发。从 stdin 读取 JSON，委托给默认适配器的 `pre()` 方法。将记录推入持久化调用栈 (`states/<projectKey>.json`)，附带顺序 `seq` 和 `parent_seq`（当前栈顶）。

2. **PostToolUse 钩子** (`hooks/log.js`) — 在每次工具调用后触发。从调用栈弹出，构建包含耗时/成功/错误的日志记录，以 JSONL 格式追加到 `logs/<projectKey>.jsonl`，并更新 `projects.json`。

3. **HTTP 服务器** (`server/server.js`) — 最小化静态文件服务器，端口 56789（定义在 `config.js`）。支持守护进程模式（`--daemon`），通过运行时 `run/server.pid` 管理生命周期。优先从 `dist/` 提供构建后的文件，否则从应用目录提供。

4. **浏览器可视化** (`index.html`) — 单页面 Tab 切换（调用链 / 仪表盘），通过 `fetch()` 在客户端解析 JSONL。

### 适配器架构

适配器定义在 `server/adapters/` 目录，继承 `BaseAdapter`（`server/adapters/base.js`）：

```
server/adapters/
├── base.js          # 基类：getProjectKey()、日志写入、状态管理
├── Codex.js   # 实时钩子（stdin JSON）
├── hermes.js        # 定时轮询 ~/.hermes/state.db
├── codex.js         # 实时钩子
├── opencode.js      # 定时轮询 ~/.local/share/opencode/opencode.db
├── cursor.js        # 实时钩子
├── pi.js            # 实时钩子
├── openclaw.js      # 骨架
└── index.js         # 注册表：getAdapter()、getAllAdapters()、stopAll()
```

**添加新适配器**：
1. 继承 `BaseAdapter`，实现 `name` getter、`pre(data)`、`post(data)`、`getRecords(filter)` 方法
2. 在 `server/adapters/index.js` 中注册：`adapters.set('name', new MyAdapter())`
3. 钩子（`server/hooks/prelog.js`、`server/hooks/log.js`）通过 `getDefaultAdapter()` 自动委托

## 核心设计模式

- **多项目隔离**：项目键 = 工作目录路径 MD5 的前 12 位。所有状态/日志文件按此键命名空间隔离。
- **调用链重建**：基于栈 — `prelog` 推入 `seq`/`parent_seq`，`log` 弹出。构建将代理链接到其子工具的树形结构。
- **输入摘要**：钩子按工具类型摘要工具输入（Bash → 命令，文件工具 → 路径，MCP → 服务器名称）。保持日志文件小巧。
- **增量渲染**：`index.html` 跟踪已渲染的 `seq` 值，自动刷新时仅追加新条目。
- **双钩子实现**：Node.js 钩子为主/推荐。

## 运行时数据

源码运行时使用项目根目录 `.agent-lens/`；安装后程序和运行数据全部统一放在用户主目录 `~/.agent-lens/`，程序文件直接位于根目录，不使用 AppData 或 XDG 目录。

- `.agent-lens/data/projects.json` — 项目注册表：映射 `projectKey` 到 `{cwd, name, last_seen}`
- `.agent-lens/logs/<projectKey>.jsonl` — 仅追加日志文件，每个工具调用一个 JSON 对象
- `.agent-lens/state/<projectKey>.json` — 临时调用栈状态（执行期间活跃读写）
- `dist/` — Vite 构建输出（生产环境使用）
- `.agent-lens/run/server.pid` — 服务进程 PID 文件
- `.agent-lens/data/agent-lens.db` — SQLite 数据库，存储 sessions、daily_stats、recent_errors、timeline 表

## 约定

- **UI 文本为中文 (zh-CN)** — HTML 文件中所有面向用户的字符串
- **无框架** — 原生 HTML/CSS/JS + Vite，CSS 变量用于主题（亮/暗）
- **钩子输入格式**：钩子从 stdin 接收 JSON，包含 `tool_name`、`cwd`、`session_id`、`tool_response`、`duration_ms` 等字段
- **错误检测**：结构化工具检查 `success`/`exit_code`；Bash 模式匹配 stdout 中的已知错误字符串
