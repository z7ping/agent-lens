# AgentLens

多 Agent 调用的全链路可观测性工具。统计 SKILL / Tool / MCP 调用次数，实时还原每一次会话的完整执行路径。

AgentLens – End-to-end observability for multi‑agent invocations.
Aggregates call counts for SKILLs, Tools, and MCPs, and reconstructs the complete execution path of every session in real time.

> **一句话**：`npm install && npm run build && node server/cli.js start` → 打开浏览器看仪表盘。

## 特性

- **多 Agent 追踪** — 统计 SKILL / Tool / MCP 调用次数，还原完整调用链
- **调用链可视化** — 树形展示每次会话的 Agent→Tool 父子调用关系
- **分析仪表盘** — 总调用数、错误率、工具使用排行、慢调用
- **概览** — 每个 AI 工具一张卡片，展示版本、配置目录、官网/文档/GitHub、Skills / MCP / Plugins / Extensions / Hooks 等能力资产、安装路径和装配路径诊断
- **多数据源** — Hermes（SQLite 轮询）、Claude Code / Codex / Cursor / Pi（实时钩子）、OpenCode（SQLite 轮询）
- **Timeline 可观测** — 统一 timeline 表，支持跨数据源对比、role 语义分类、错误自动归类
- **实时刷新** — 3 秒增量更新，无需手动刷新
- **暗色主题** — 亮/暗一键切换

## 快速上手

```bash
git clone https://github.com/z7ping/agent-lens.git
cd agent-lens
npm install
npm run build
node server/cli.js start              # 前台启动，默认端口 56789
```

打开 **http://localhost:56789/** 即可看到仪表盘。

> `npm start` 等价于 `node server/cli.js start`。前台运行时按 Ctrl+C 停止；后台运行使用 `node server/cli.js start --daemon`。

---

## 目录结构

```
agent-lens/
├── server/                    # 后端（纯 Node.js，无构建步骤）
│   ├── server.js              # HTTP 服务（端口 56789）
│   ├── cli.js                 # CLI 入口
│   ├── routes.js              # API 路由
│   ├── agent-lens-db.js            # SQLite 存储层
│   ├── config.js              # 服务配置
│   ├── schema.sql             # 表结构定义
│   ├── overview.js            # 概览资产扫描与数据库快照
│   ├── adapters/              # 多工具适配器（Hermes / Claude Code / Cursor / Pi ...）
│   ├── hooks/                 # 实时钩子（prelog.js / log.js）
│   └── scripts/               # 工具脚本
├── src/                       # 前端（Vite + Tailwind）
│   ├── app.js                 # 主逻辑
│   ├── config.js / utils.js   # 配置与工具函数
│   ├── style.css              # 样式
│   ├── callchain/             # 调用链 Tab
│   ├── dashboard/             # 仪表盘 Tab（含 Chart.js 图表）
│   └── overview/              # 概览 Tab（工具能力资产）
├── dist/                      # 构建产物（npm run build 生成）
├── index.html                 # 入口页面
├── package.json
├── vite.config.mjs
└── tailwind.config.mjs
```

## 开发模式

```bash
npm install               # 安装依赖
npm run dev               # 同时启动后端 56789 和 Vite 5173
npm run dev:frontend      # 仅启动 Vite 5173，需另行启动后端
npm run build             # 构建生产前端到 dist/
npm test                  # 运行导入器测试和 Node.js 测试
```

`npm run dev` 已同时启动前后端，不需要再单独执行 `node server/cli.js start`。访问 **http://localhost:5173/** 进行热更新开发；Vite 会把 `/api`、`/logs`、`/states` 和 `/projects.json` 代理到后端 56789。

## 场景指南

### 场景 A：我就想看仪表盘（生产模式）

```bash
npm start            # 自动构建 + 启动，访问 http://localhost:56789/
```

### 场景 B：我要开发前端（热更新）

一条命令同时启动后端 + Vite 热更新：

```bash
npm run dev              # 后端（56789）+ Vite（5173）一起启动
```

后端和前端用不同颜色区分输出，修改 `src/` 里的代码浏览器自动刷新。

访问 **http://localhost:5173/**（Vite 代理 `/api` 到后端 56789）。

> 如果想单独启动 Vite（不启动后端），用 `npm run dev:frontend`。

**Hermes（自动）**：服务启动后自动轮询 `~/.hermes/state.db`，无需额外配置。支持 state 持久化，重启不重复导入。

### 场景 C：我要从 npm 包安装到本机

推荐使用 npm Registry 上已发布的包：

```bash
npx @z7ping/agent-lens install
```

安装命令会复制应用文件、安装运行时依赖、配置 Hooks，并按平台注册系统服务或启动 daemon。安装完成后使用短命令管理：

```bash
agent-lens status
agent-lens stop
agent-lens start --daemon
agent-lens uninstall
```

### 场景 D：我要从 GitHub 源码安装到本机

从 GitHub 源码安装时，使用当前目录里的 CLI：

```bash
npm install
npm run build
node server/cli.js install          # 复制应用 + 安装依赖和 Hooks + 注册服务/daemon
```

也可以直接调用 GitHub 仓库：

```bash
npx github:z7ping/agent-lens install
```

> 仓库不跟踪 `dist/`，GitHub 直接调用需要当前环境能够安装开发依赖并完成 Vite 构建。若构建环境不确定，请使用“克隆源码 → `npm install` → `npm run build` → `node server/cli.js install`”，或使用 npm Registry 包。

安装后会自动注册为**系统服务**或 daemon，支持开机自启/自动拉起。自动检测平台：

| 平台 | 服务机制 | 配置路径 |
|------|---------|---------|
| Linux | systemd user service | `~/.config/systemd/user/agent-lens.service` |
| macOS | launchd agent | `~/Library/LaunchAgents/com.agent-lens.plist` |
| Windows | daemon + hook 自动守护 | `~/.agent-lens/`（无需管理员权限） |

> **Linux 注意**：需要 `sudo loginctl enable-linger <user>` 才能在未登录时保持服务运行。安装时会自动检测并提示。
>
> **Windows 注意**：不使用任务计划程序，也不提供系统服务安装和开机自启开关。服务以 daemon 模式运行，首次工具调用时由 Hook 自动拉起，无需管理员权限。

---

## 数据源配置

| 数据源 | 方式 | 配置 |
|--------|------|------|
| **Hermes** | 自动轮询 `~/.hermes/state.db` | 无需配置，启动即用 |
| **Claude Code** | 实时钩子 | 见下方 |
| **Codex** | 实时钩子 | 同 Claude Code |
| **Cursor** | 实时钩子 | 同 Claude Code |
| **Pi** | 实时钩子 | 同 Claude Code |
| **OpenCode** | 轮询 `~/.local/share/opencode/opencode.db` | 无需配置 |

### 概览资产扫描

“概览”页用于查看每个 AI 工具的稳定能力资产，包括工具版本、配置目录、Skills、MCP、Plugins、Extensions、Hooks、Adapters 和内置/历史调用中发现的能力。

资产卡片会显示安装路径或配置路径，并提供路径复制入口，便于定位和管理本地 Skill、MCP、插件、扩展等资源。概览页还提供“装配路径”视图，用于按工具检查配置目录、配置文件、Hook、Skills、插件缓存、会话目录或状态数据库等关键路径是否存在，并展示 SKILL 的已安装、可发现、已使用数量及本地/插件来源分布。工具卡片会展示可用的官网、GitHub、官方文档链接。

顶部工具来源 Tab 默认顺序为 Pi、Codex、Claude Code CLI、OpenCode、Hermes、OpenClaw、Cursor；也支持拖拽排序，排序保存在当前浏览器本地，并同步影响概览卡片和高频资产对照列顺序。项目下拉列表会显示项目对应的工具来源和会话数；切换顶部工具来源 Tab 时，项目列表会自动过滤为该工具存在记录的项目。

概览数据采用“数据库快照 + 后台刷新”：

1. `/api/overview` 先读取运行时数据目录中的 `agent-lens.db` 最近一次资产快照，快速返回页面。
2. 每次访问 `/api/overview` 后，服务会在后台触发一次资产扫描并更新数据库。
3. 服务启动后会按固定间隔定时扫描，避免配置变化长期不同步。
4. 调用次数、高频资产和跨工具覆盖矩阵继续从 `timeline` 聚合，不重复存储调用事实。

定时扫描间隔通过环境变量配置，单位为毫秒：

```bash
AGENT_LENS_OVERVIEW_SCAN_INTERVAL_MS=600000 node server/cli.js start
```

默认值是 `600000`（10 分钟）。设为 `0` 可关闭服务端定时扫描；访问概览时仍会触发后台刷新。

#### Codex 概览扫描规则

Codex 默认配置根目录为 `CODEX_HOME`，未设置时为 `~/.codex`。AgentLens 会扫描：

| 路径 | 类型 | 说明 |
|------|------|------|
| `~/.codex/skills` | Skill | 用户级 Skill 目录，支持递归识别 `SKILL.md` |
| `~/.codex/plugins/cache/**/.codex-plugin/plugin.json` | Plugin | 已安装插件清单，并展示插件安装路径 |
| `~/.codex/plugins/cache/**/SKILL.md` | Skill | 插件随包提供的 Skill |
| `~/.codex/plugins` | Plugin | 插件根目录中的已安装条目 |
| `~/.codex/config.toml` 中的 `[mcp_servers.*]` | MCP | Codex MCP 配置 |
| `~/.codex/config.toml` 中的 `[plugins.*]` | Plugin | Codex 插件启用配置 |
| `~/.codex/config.json` | MCP | JSON 配置格式 |

#### Pi 概览扫描规则

Pi 的默认配置根目录来自 `PI_CODING_AGENT_DIR`，未设置时为 `~/.pi/agent`。AgentLens 会优先识别真正的 Pi agent 根目录，再扫描该目录下的能力资产，而不是只按某一台机器的 `~/.pi` 布局处理。

Pi agent 根目录候选包括：

- 环境变量：`PI_CODING_AGENT_DIR`（Pi 官方配置根）、`PI_HOME`、`PI_AGENT_HOME`、`PI_CONFIG_HOME`、`PI_DATA_HOME`
- 通用默认：`~/.pi/agent`、`~/.pi`
- Linux：`~/.config/pi`、`~/.local/share/pi`
- Windows：`%APPDATA%\Pi`、`%APPDATA%\pi`、`%LOCALAPPDATA%\Pi`、`%LOCALAPPDATA%\pi`
- macOS：`~/Library/Application Support/Pi`、`~/Library/Application Support/pi`

识别到 Pi agent 根目录后，会扫描：

Skill 目录会识别根目录下的 `.md` 文件，并递归识别包含 `SKILL.md` 的子目录；Extension 目录会识别子目录以及 `.js` / `.ts` / `.mjs` / `.cjs` 文件。

| 路径 | 类型 | 说明 |
|------|------|------|
| `<agentDir>/skills` | Skill | Pi 用户级默认 Skill 目录 |
| `~/.agents/skills` | Skill | Pi / Agent Skills 共享的用户级 Skill 目录 |
| `<agentDir>/settings.json` 中的 `skills` | Skill | Pi 配置显式加载的 Skill 目录 |
| `<agentDir>/settings.json` 中的 `extensions` | Extension | Pi 配置显式加载的 Extension 路径 |
| `<agentDir>/settings.json` 中的 `packages` | Plugin / Skill / Extension | Pi 配置显式安装的 package，支持 `npm:<package>` |
| `<agentDir>/npm/package.json` + `<agentDir>/npm/node_modules/<package>` | Plugin | Pi npm 插件依赖，识别 `pi-*`、`*/pi-*`、`keywords` 或 `pkg.pi` 标记 |
| `<agentDir>/npm/node_modules/<package>/skills` | Skill | Pi npm 插件随包提供的传统 Skill 目录 |
| `<agentDir>/npm/node_modules/<package>/package.json` 中的 `pi.skills` / `skills` | Skill | Pi package 声明的 Skill 资源 |
| `<agentDir>/extensions` | Extension | Pi extension 目录 |
| `<agentDir>/npm/node_modules/<package>/extensions` | Extension | Pi npm 插件随包提供的传统 Extension 目录 |
| `<agentDir>/npm/node_modules/<package>/package.json` 中的 `pi.extensions` / `extensions` | Extension | Pi package 声明的 Extension 资源 |
| `<agentDir>/pi-hermes-memory/skills` | Skill | Pi Hermes Memory 的全局/过程记忆 Skill |
| `<agentDir>/projects-memory/<project>/skills` | Skill | Pi 项目级记忆 Skill |

### 配置 Claude Code / Codex / Cursor / Pi 钩子

运行 `node server/cli.js install` 会自动配置所有工具的 hooks。发布到 npm 后，也可以使用 `npx @z7ping/agent-lens install`。

如果需要手动配置，在 `~/.claude/settings.json` 中添加（路径指向 `~/.agent-lens/hooks/`）：

```json
{
  "hooks": {
    "PreToolUse": [{
      "hooks": [{
        "command": "node ~/.agent-lens/hooks/prelog.js",
        "type": "command",
        "timeout": 5
      }]
    }],
    "PostToolUse": [{
      "hooks": [{
        "command": "node ~/.agent-lens/hooks/log.js",
        "type": "command",
        "timeout": 10
      }]
    }]
  }
}
```

---

## CLI 参考

源码仓库中使用 `node server/cli.js`；完成安装后可将它替换为 `agent-lens`。例如，`node server/cli.js status` 和 `agent-lens status` 的含义相同。

### 完整命令

```bash
node server/cli.js install                       # 安装应用、依赖和 Hooks，并启动服务
node server/cli.js start                         # 默认端口 56789，前台启动
node server/cli.js start --daemon                # 后台启动
node server/cli.js start -d                      # 后台启动的短参数
node server/cli.js start 8080                    # 使用位置参数指定端口
node server/cli.js start --port 8080             # 使用选项指定端口
node server/cli.js start --port 8080 --open      # 启动后自动打开浏览器
node server/cli.js stop                          # 停止后台服务
node server/cli.js status                        # 查看默认服务状态
node server/cli.js package                       # 构建并生成 npm 兼容的 .tgz
node server/cli.js package --output ./release    # 指定分发包输出目录
node server/cli.js uninstall                     # 卸载并删除配置及运行数据
node server/cli.js help                          # 显示帮助
node server/cli.js --help                        # 显示帮助
node server/cli.js -h                            # 显示帮助
```

注意：

- `start` 检测不到 `dist/` 时会先执行 `npm run build`。
- `status` 当前固定检查并显示默认端口 56789。使用自定义端口启动时，应直接访问对应地址确认服务；PID 存在时仍可识别进程。
- `uninstall` 会要求确认，并删除 AgentLens 安装目录、Hooks 配置和全部运行数据。

### npm scripts

```bash
npm run dev                                  # 后端 + Vite 联调
npm run dev:frontend                         # 仅 Vite
npm run build                                # 构建前端
npm start                                    # 前台启动
npm start -- --daemon                        # 后台启动并向 CLI 透传参数
npm stop                                     # 停止服务
npm run status                               # 查看状态
npm run install-hooks                        # 执行完整 install 命令
npm run package -- --output ./release        # 打包并透传输出目录
npm test                                     # 运行全部测试
```

> `install-hooks` 是历史脚本名，当前实际执行完整安装流程，不只是写入 Hooks。

### 系统服务与后台守护

Linux 使用 systemd user service，macOS 使用 launchd agent，两者支持完整的 `service` 子命令：

```bash
agent-lens service install       # 注册系统服务并启用自启
agent-lens service start         # 启动系统服务
agent-lens service stop          # 停止系统服务
agent-lens service status        # 查看系统服务和自启状态
agent-lens service enable        # 启用开机自启
agent-lens service disable       # 关闭开机自启
agent-lens service uninstall     # 停止并移除系统服务
```

Windows 不注册系统服务，使用 daemon + Hook 自动守护：

```bash
agent-lens start --daemon      # 后台启动
agent-lens stop                # 停止服务
agent-lens status              # 查看状态
```

Windows 下 `service start`、`service stop`、`service status` 会映射到上述 daemon 命令；`service install`、`service uninstall`、`service enable`、`service disable` 不可用。

---

## 常见问题

### 仪表盘白屏 / 只显示后端日志？

缺少 `dist/` 目录。`src/` 里的源码需要 Vite 处理才能运行。

**解决**：
- 用 `npm start` 或 `node server/cli.js start`（会自动构建）
- 如果安装了系统服务，重新运行 `node server/cli.js install` 会自动构建

### 端口 56789 被占了？

```bash
node server/cli.js start 8080          # 位置参数
node server/cli.js start --port 8080   # 等价写法
```

当前 `status` 固定检查默认端口 56789；自定义端口启动后请访问 `http://localhost:8080/` 确认服务。

---

## 数据模型

### Timeline 表（核心）

| 字段 | 说明 |
|------|------|
| source | 数据来源：`hermes` / `claude-code` |
| session_id | 会话标识 |
| timestamp | 事件时间戳 |
| role | 事件角色：`user` / `assistant` / `tool_result` / `tool_error` |
| tool_name | 工具名称 |
| error_type | 错误分类：`windows_command` / `path_not_found` / `permission` / `timeout` / `syntax` / `unknown` |
| error_detail | 错误详情 JSON |

### SQLite 表（agent-lens.db）

开发模式运行数据统一保存在项目根目录 `.agent-lens/` 下：

```text
.agent-lens/
├── data/      # agent-lens.db, projects.json
├── logs/      # JSONL 调用日志与调试日志
├── state/     # 调用栈和导入水位线
└── run/       # server.pid
```

安装后，所有平台都统一使用用户主目录下的 `~/.agent-lens/`，不使用 `%LOCALAPPDATA%`、XDG 或迁移兼容目录：

```text
~/.agent-lens/
├── cli.js, server.js, package.json  # 程序文件直接放在根目录
├── dist/                            # 前端构建产物
├── hooks/                           # Hooks
├── adapters/                        # 工具适配器
├── importers/                       # 历史数据导入器
├── data/                            # agent-lens.db, projects.json
├── logs/                            # JSONL 和服务日志
├── state/                           # 调用栈和导入水位线
└── run/                             # server.pid
```

Windows 对应路径为 `C:\Users\<用户名>\.agent-lens\`。

| 表名 | 用途 |
|------|------|
| sessions | 会话摘要（按 source 聚合） |
| daily_stats | 按天+工具聚合统计 |
| recent_errors | 最近错误（滚动保留 50 条） |
| timeline | 原始调用记录（role 语义分类） |
| overview_tools | 概览页工具身份与运行环境快照 |
| overview_assets | 概览页能力资产快照 |
| overview_scan_runs | 概览资产扫描记录、状态与错误信息 |

---

## 许可证

MIT License
