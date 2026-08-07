# 更新日志

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
