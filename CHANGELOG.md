# 更新日志

## 1.9.1 (2026-08-09)

### Added
- 任务复盘对话气泡默认使用 Markdown 渲染，并支持一键切换查看源码。

### Fixed
- Windows 安装流程改用 daemon 管理提示，并等待服务 HTTP 就绪后再报告启动成功。
- Windows 重新安装时会重启已安装 daemon，避免界面版本号停留在旧进程缓存。
- 修复安装目录漏复制 `app-info.js`、安装布局读取 `package.json` 错误，以及从源码目录安装时 daemon 启动目录错误。
- Windows PATH 写入改用用户环境变量 API，避免 `setx` 在长 PATH 下失败或截断。
- Pi 概览扫描改为按 `PI_CODING_AGENT_DIR` 默认根 `~/.pi/agent` 发现资产，并兼容环境变量、XDG、Windows AppData、macOS Application Support 等候选目录。
- Pi 概览现在会扫描 `<agentDir>/skills`、npm 插件及插件内 `skills`、`extensions`、`pi-hermes-memory/skills`、`projects-memory/<project>/skills`。

## 1.9.0 (2026-08-07)

### Added
- 新增“概览”页：按 AI 工具展示版本、配置目录和 Skills / MCP / Plugins / Extensions / Hooks / Adapters 等能力资产。
- 新增概览资产数据库快照表：`overview_tools`、`overview_assets`、`overview_scan_runs`。
- `/api/overview` 优先读取数据库快照，并在访问后后台刷新资产扫描。
- 服务启动后定时扫描概览资产，支持通过 `AGENT_TRACE_OVERVIEW_SCAN_INTERVAL_MS` 配置间隔，设为 `0` 可关闭。
- 概览页使用本地缓存和稳定工具骨架先渲染，再后台更新真实数据。

### Changed
- 概览页资产列表从长条改为紧凑资产卡片网格。
- 高频资产按调用频率判定，并在跨工具覆盖矩阵中展示其他工具是否已有。

## 1.8.1 (2026-07-08)

### Fixed
- `cli.js` 前台模式路径错误（`server.js` → `server/server.js`）
- `server.js` 安装模式下 dist/ 路径解析错误导致 404
- `server.js` PID 文件路径解析错误
- `cli.js` VERSION require 在安装目录下找不到 package.json
- install 未复制 `routes.js` 导致服务启动失败
- hermes 适配器轮询无防并发 + 全表扫描导致 CPU 100%

### Changed
- install 目录从 `~/.claude/agent-trace/` 改为 `~/.agent-trace/`
- install 自动创建 `~/.local/bin/agent-trace` 符号链接
- hermes 轮询间隔从 5 分钟改为 30 分钟，查询加 LIMIT 5000
- VERSION 改为按需读取，install 不再复制 package.json

## 1.8.0 (2026-07-04)

### Added
- 跨工具对比 API（`/api/compare`）
- 报错分析 API（`/api/errors`）
- timeline 表 role 语义扩展 + error_type 自动分类
- dedup 索引防重复导入

### Changed
- 后端文件统一移到 `server/` 目录
- API 路由拆分到 `routes.js`

## 1.7.0 (2026-07-02)

### Added
- Pi 适配器（轮询 `~/.pi/agent/sessions/`）
- 跨平台系统服务管理（systemd / launchd / schtasks）
- 仪表盘重写

### Fixed
- MCP 工具合并 + 排行显示
- 来源过滤 tab 交互逻辑

## 1.6.0 (2026-06-30)

### Added
- Cursor 适配器
- Hermes timeline 收集（state.db 轮询 → timeline 表）
- Hermes poll state 持久化，重启不重复导入

## 1.5.0 (2026-06-28)

### Added
- OpenCode 适配器（轮询 `opencode.db`）
- Codex 适配器（钩子机制）
- 项目更名为 Agent Trace

## 1.2.0 (2026-06-20)

### Added
- 初始版本：Claude Code 工具追踪
- 调用链可视化
- 分析仪表盘
- 暗色主题
