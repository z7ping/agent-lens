# Agent Trace

多 Agent 调用的全链路可观测性工具。统计 SKILL / Tool / MCP 调用次数，实时还原每一次会话的完整执行路径。

AgentTrace – End-to-end observability for multi‑agent invocations.
Aggregates call counts for SKILLs, Tools, and MCPs, and reconstructs the complete execution path of every session in real time.

> **一句话**：`npm install && npm start` → 打开浏览器看仪表盘。

## 特性

- **多 Agent 追踪** — 统计 SKILL / Tool / MCP 调用次数，还原完整调用链
- **调用链可视化** — 树形展示每次会话的 Agent→Tool 父子调用关系
- **分析仪表盘** — 总调用数、错误率、工具使用排行、慢调用
- **概览** — 每个 AI 工具一张卡片，展示版本、配置目录、Skills / MCP / Plugins / Extensions / Hooks 等能力资产
- **多数据源** — Hermes（SQLite 轮询）、Claude Code / Codex / Cursor / Pi（实时钩子）、OpenCode（SQLite 轮询）
- **Timeline 可观测** — 统一 timeline 表，支持跨数据源对比、role 语义分类、错误自动归类
- **实时刷新** — 3 秒增量更新，无需手动刷新
- **暗色主题** — 亮/暗一键切换

## 快速上手

```bash
git clone https://github.com/z7ping/agent-trace.git
cd agent-trace
npm install
npm start              # 自动构建前端 + 启动后端，端口 56789
```

打开 **http://localhost:56789/** 即可看到仪表盘。

> `npm start` 等价于 `npx agent-trace start`，前台运行，按 Ctrl+C 停止。
> 后台运行加 `--daemon`：`npx agent-trace start --daemon`。

---

## 目录结构

```
agent-trace/
├── server/                    # 后端（纯 Node.js，无构建步骤）
│   ├── server.js              # HTTP 服务（端口 56789）
│   ├── cli.js                 # CLI 入口
│   ├── routes.js              # API 路由
│   ├── abeat-db.js            # SQLite 存储层
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

# 开发模式
npm run dev           # vite dev server（端口 5173），代理 /api 到 56789
npx agent-trace start      # 启动后端服务（端口 56789）

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

安装时会自动构建前端 + 注册系统服务，一步到位：

```bash
npx agent-trace install          # 自动 npm run build + 安装钩子 + 注册系统服务
npx agent-trace service start    # 后台启动，开机自启
```

安装后自动注册为**系统服务**，支持开机自启。自动检测平台：

| 平台 | 服务机制 | 配置路径 |
|------|---------|---------|
| Linux | systemd user service | `~/.config/systemd/user/agent-trace.service` |
| macOS | launchd agent | `~/Library/LaunchAgents/com.agent-trace.plist` |
| Windows | daemon + hook 自动守护 | `~/.agent-trace/`（无需管理员权限） |

> **Linux 注意**：需要 `sudo loginctl enable-linger <user>` 才能在未登录时保持服务运行。安装时会自动检测并提示。
>
> **Windows 注意**：不使用任务计划程序。服务以 daemon 模式运行，首次工具调用时由 hook 自动拉起，无需管理员权限。

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

概览数据采用“数据库快照 + 后台刷新”：

1. `/api/overview` 先读取 `a-beat.db` 中最近一次资产快照，快速返回页面。
2. 每次访问 `/api/overview` 后，服务会在后台触发一次资产扫描并更新数据库。
3. 服务启动后会按固定间隔定时扫描，避免配置变化长期不同步。
4. 调用次数、高频资产和跨工具覆盖矩阵继续从 `timeline` 聚合，不重复存储调用事实。

定时扫描间隔通过环境变量配置，单位为毫秒：

```bash
AGENT_TRACE_OVERVIEW_SCAN_INTERVAL_MS=600000 npx agent-trace start
```

默认值是 `600000`（10 分钟）。设为 `0` 可关闭服务端定时扫描；访问概览时仍会触发后台刷新。

### 配置 Claude Code / Codex / Cursor / Pi 钩子

运行 `npx agent-trace install` 会自动配置所有工具的 hooks。

如果需要手动配置，在 `~/.claude/settings.json` 中添加（路径指向 `~/.agent-trace/hooks/`）：

```json
{
  "hooks": {
    "PreToolUse": [{
      "hooks": [{
        "command": "node ~/.agent-trace/hooks/prelog.js",
        "type": "command",
        "timeout": 5
      }]
    }],
    "PostToolUse": [{
      "hooks": [{
        "command": "node ~/.agent-trace/hooks/log.js",
        "type": "command",
        "timeout": 10
      }]
    }]
  }
}
```

---

## CLI 参考

### 服务管理

```bash
npx agent-trace start               # 自动构建 + 前台启动（Ctrl+C 停止）
npx agent-trace start --daemon      # 自动构建 + 后台运行
npx agent-trace stop                # 停止后台服务
npx agent-trace status              # 查看运行状态
```

> `start` 命令会自动检测 `dist/` 是否存在，不存在则先执行 `npm run build`。

安装为系统服务后（见场景 C），可用 `service` 子命令：

```bash
npx agent-trace service start       # 启动系统服务
npx agent-trace service stop        # 停止
npx agent-trace service status      # 状态
npx agent-trace service enable      # 开机自启
npx agent-trace service disable     # 关闭自启
npx agent-trace service uninstall   # 卸载服务
```

### 其他

```bash
npx agent-trace install    # 安装钩子到 Claude Code + 注册系统服务
npx agent-trace package    # 打包分发
```

---

## 常见问题

### 仪表盘白屏 / 只显示后端日志？

缺少 `dist/` 目录。`src/` 里的源码需要 Vite 处理才能运行。

**解决**：
- 用 `npm start`（自动构建）或 `npx agent-trace start`（也会自动构建）
- 如果安装了系统服务，重新运行 `npx agent-trace install` 会自动构建

### 端口 56789 被占了？

```bash
npx agent-trace start 8080       # 指定其他端口
```

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

### SQLite 表（a-beat.db）

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

## TODO

- [ ] 发布到 npm
- [ ] 简化 install 流程：去掉文件复制，只做 hooks 配置 + 服务注册（用户直接从源码目录运行即可）

## 许可证

MIT License
