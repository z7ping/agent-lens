# 更新日志

## 未发布

## 0.5.0 (2026-08-12)

### Added
- 新增 Codex 生命周期透镜，实时采集 Session、提示词提交、权限请求、Compact、Subagent 和 Stop 事件，并在任务复盘中按 Turn / Agent 展示独立轨迹。
- 新增 Codex 当前指令链静态发现，遵循 `AGENTS.override.md`、`AGENTS.md` 和 fallback 文件优先级，并明确标记为当前环境证据。
- Timeline Schema v5 新增 `attributes_json`，保存模型、权限模式、启动来源、压缩触发方式和子 Agent 类型等结构化生命周期属性。
- 概览装配路径与顶部来源状态新增 Codex Hook 覆盖诊断，可识别旧安装缺少的生命周期 Hook。

### Changed
- Codex 安装由 2 类工具 Hook 扩展为 11 类生命周期 Hook；`SessionEnd` 使用官方允许的 3 秒超时。
- Codex 并行工具结果优先使用原生 `tool_use_id` 配对，不再依赖严格 LIFO；缺少 Agent 归属时明确标记缺失原因，不按时间猜测。
- 生命周期 Hook 保持被动观察，`Stop` / `SubagentStop` 返回中性 JSON，不修改 Codex 控制流或上下文。

### Security
- 生命周期事件沿用提示词、工具与配置分级采集策略，结构化属性始终递归脱敏，默认不持久化 transcript 路径。

### Fixed
- 安装应用暂存清单补齐数据库迁移、隐私、安全、事件模型和 Codex 生命周期运行模块，避免源码安装后的运行时缺少依赖。
- Windows 安装完成后直接启动已安装的服务程序，避免 CLI、VBScript 与 cmd 多层转发导致新服务无法通过就绪检查。
- 升级失败回滚旧版程序时同步恢复旧版 Hooks 配置，避免旧程序继续引用新版本才提供的 Hook 脚本。

## 0.4.0 (2026-08-11)

### Added
- 新增稳定事件标识、来源命名空间 Session、Agent/Turn/父事件字段，以及采集方式、可见性、可信度和缺失原因。
- 新增来源数据完整度矩阵和采集策略面板，任务复盘中的对话与工具结果会显示证据类型。
- 新增提示词、工具数据、配置和环境信息的采集档位；默认脱敏提示词与工具数据，默认关闭环境信息采集。
- 新增版本化数据库迁移和旧库备份，迁移过程使用事务、行数校验和失败回滚。
- Tool Use 与 Tool Result 改为独立关联事件，历史导入器和数据库轮询来源均可表达工具生命周期。

### Security
- HTTP 服务默认只监听 `127.0.0.1`，拒绝非回环 Host、远程连接和未允许的 Origin。
- 移除通配 CORS，API 按路由限制 HTTP 方法并增加安全响应头。
- `/api/hook` 写入要求安装级本机令牌、JSON Content-Type 和请求体大小限制。
- Timeline 与 JSONL 持久化统一执行递归凭据脱敏和内容长度限制。
- 静态资源和运行时文件回退使用真实目录边界校验，阻止相似路径前缀绕过。

### Changed
- Session 主键改为 `source + session_id`，避免不同 Agent 使用相同原生 Session ID 时互相覆盖。
- Timeline 去重改用稳定事件身份，不再以时间戳和角色作为唯一键；同一时刻发生的并行事件可以完整保留。
- 工具调用标识限定在来源与 Session 内，避免不同来源复用调用 ID 时发生冲突。
- 统计只计算 Tool Result / Tool Error，拆分 Tool Use 后不会重复计数。

### Fixed
- 旧版 Timeline 约束迁移不再删除原表，升级前自动备份并保留全部历史记录。
- Claude Code 历史数据只由统一增量导入器写入，避免旧轮询器和导入器双路径重复入库。
- Codex 与 Hermes 耗时统一按毫秒保存；按天平均耗时改为按调用数加权计算，Session 总数按来源正确统计。

## 0.3.4 (2026-08-11)

### Added
- 新增贡献指南、安全策略和 GitHub Issue/PR 模板。
- 安装器新增当前平铺布局和历史 AppData/XDG 布局检测，支持缺失运行数据迁移、冲突保留和程序暂存切换。

### Changed
- README 新增公开协作入口与文档导航。
- 更新架构及 Agent 开发说明，使数据源采集方式与当前 Hook、JSONL 导入和数据库轮询实现保持一致。
- 安装目录恢复程序与运行数据分层：程序和生产依赖位于 `~/.agent-lens/app/`，Windows 命令入口位于 `bin/`，数据库、日志、状态和 PID 保留在根目录独立子目录。
- 已安装应用改为省略 Vite、Tailwind 等开发依赖，只安装生产运行依赖。
- 仓库锁文件、发布配置和安装器运行依赖下载统一使用 npm 官方 Registry。

### Fixed
- 重新安装会停止并识别历史目录中的旧 daemon，服务启动成功必须同时通过新 PID 文件和 HTTP 就绪检查，避免把占用端口的旧实例误判为新版本。
- 当前平铺布局升级成功后按白名单清理根目录旧程序和旧 `node_modules`，不删除数据库、日志或导入状态。
- 新版本服务启动失败时自动恢复并重启上一版程序，成功安装后清理历史回滚目录，避免失败升级持续占用磁盘空间。
- 卸载时同步清理 Claude Code、Codex 和 Cursor Hooks，并重建 Codex 信任状态，避免残留命令继续引用已删除文件。
- Hook 脚本路径增加引号，兼容用户主目录包含空格的环境。
- README 的界面图片及协作文档改用 GitHub 绝对链接，避免 npm 包和安装目录中的相对链接失效。
- 发布工作流在测试前显式构建前端，安装布局测试使用独立夹具，不再依赖本机被忽略的 `dist/` 目录。

## 0.3.3 (2026-08-11)

### Added
- README 新增概览能力资产、装配路径、工具栈地图和任务复盘的界面预览。

### Changed
- npm 发布工作流升级到支持 Node.js 24 运行时的 `actions/checkout@v7` 和 `actions/setup-node@v7`，并通过仓库密钥 `NPM_TOKEN` 发布公开包。

### Fixed
- 应用信息测试改为读取 `package.json` 的当前版本，避免提升 npm 包版本后因硬编码旧版本导致发布流程失败。
- Windows 安装现在会在当前用户的“启动”目录注册隐藏启动脚本，支持登录后自启及完整的 `service` 管理命令，无需管理员权限；重新安装时会重启旧 daemon，避免网页继续运行旧版本代码。

## 0.3.0 (2026-08-10)

### Added
- 概览页新增“装配路径”视图，按工具展示配置目录、配置文件、Hook 配置、Skills、插件缓存、会话目录/状态数据库等关键路径状态。
- `/api/overview` 返回路径诊断与 SKILL 加载摘要，支持区分本地 Skills、插件随包 Skills，并统计已安装、可发现、已使用数量。
- 新增 `/api/projects` 项目索引 API，从会话表按项目和工具来源聚合项目、来源、会话数、工具调用数与最近活跃时间。
- 项目下拉列表现在显示工具来源信息，并会跟随顶部工具来源 Tab 自动过滤项目。

### Fixed
- 修复部分新版 npm 阻止 `better-sqlite3` / `esbuild` 安装脚本后仍报告安装成功的问题；安装器现在会验证原生 SQLite 并自动批准、重建依赖。
- 修复 GitHub `npx github:z7ping/agent-lens install` 安装时包文件白名单缺少前端源码，导致无法临时构建 `dist/` 的问题。
- 修复 npm/GitHub 分发包会包含 `server/projects.json`、`server/states/` 等本机运行状态文件的问题。
- 修复 `agent-lens package` 使用过期手写打包清单导致 Release 包缺少当前运行必需文件的问题，现在改为复用 `npm pack` 生成 npm 兼容 `.tgz`。
- 修复概览调用统计中 `call_count: 0` 被误计为 1 的问题，避免 SKILL “已使用”数量虚高。

### Changed
- 项目展示名、npm 包名和 CLI 命令使用 AgentLens / `@z7ping/agent-lens` / `agent-lens`。
- SQLite 数据库文件名使用 `agent-lens.db`，与产品名保持一致。
- 开发运行数据写入项目根目录 `.agent-lens/`；安装后所有程序和运行数据统一放在用户主目录 `~/.agent-lens/`，不使用 AppData 或 XDG 分散目录。
- README 和 AGENTS 文档区分源码安装、GitHub 分发和 npm 发布后的命令路径，避免未发布 npm 时误用 registry 旧包。

## 0.1.7 (2026-08-09)

### Added
- 任务复盘对话气泡默认使用 Markdown 渲染，并支持一键切换查看源码。
- 概览页新增工具官网、GitHub、官方文档链接展示。
- 概览资产卡片新增安装路径/配置路径展示和复制入口，便于管理 Skills、MCP、插件、扩展等资源。
- 顶部工具来源 Tab 默认顺序调整为 Pi、Codex、Claude Code CLI、OpenCode、Hermes、OpenClaw、Cursor，并支持拖拽调整顺序，顺序保存在当前浏览器本地，并同步影响概览卡片与高频资产对照列。
- Codex 概览扫描新增递归 Skill、插件清单、插件内 Skill、`config.toml` MCP 与插件配置路径展示。

### Fixed
- Windows 安装流程改用 daemon 管理提示，并等待服务 HTTP 就绪后再报告启动成功。
- Windows 重新安装时会重启已安装 daemon，避免界面版本号停留在旧进程缓存。
- 修复安装目录漏复制 `app-info.js`、安装布局读取 `package.json` 错误，以及从源码目录安装时 daemon 启动目录错误。
- Windows PATH 写入改用用户环境变量 API，避免 `setx` 在长 PATH 下失败或截断。
- Pi 概览扫描改为按 `PI_CODING_AGENT_DIR` 默认根 `~/.pi/agent` 发现资产，并兼容环境变量、XDG、Windows AppData、macOS Application Support 等候选目录。
- Pi 概览现在会扫描 `<agentDir>/skills`、`~/.agents/skills`、`settings.json.skills`、npm package 声明/传统目录中的 `skills` 与 `extensions`、`pi-hermes-memory/skills`、`projects-memory/<project>/skills`。
- Pi Skill 扫描改为识别根 `.md` 与递归 `SKILL.md`，Extension 扫描支持目录和 JS/TS 文件，贴近 Pi 官方资源发现规则。
- Codex 历史对话导入保留用户/助手长文本，重新导入时会更新同一条消息。

## 0.1.6 (2026-08-07)

### Added
- 新增“概览”页：按 AI 工具展示版本、配置目录和 Skills / MCP / Plugins / Extensions / Hooks / Adapters 等能力资产。
- 新增概览资产数据库快照表：`overview_tools`、`overview_assets`、`overview_scan_runs`。
- `/api/overview` 优先读取数据库快照，并在访问后后台刷新资产扫描。
- 服务启动后定时扫描概览资产，支持通过 `AGENT_LENS_OVERVIEW_SCAN_INTERVAL_MS` 配置间隔，设为 `0` 可关闭。
- 概览页使用本地缓存和稳定工具骨架先渲染，再后台更新真实数据。

### Changed
- 概览页资产列表从长条改为紧凑资产卡片网格。
- 高频资产按调用频率判定，并在跨工具覆盖矩阵中展示其他工具是否已有。

## 0.1.5 (2026-07-08)

### Fixed
- `cli.js` 前台模式路径错误（`server.js` → `server/server.js`）
- `server.js` 安装模式下 dist/ 路径解析错误导致 404
- `server.js` PID 文件路径解析错误
- `cli.js` VERSION require 在安装目录下找不到 package.json
- install 未复制 `routes.js` 导致服务启动失败
- hermes 适配器轮询无防并发 + 全表扫描导致 CPU 100%

### Changed
- install 目录使用 `~/.agent-lens/`
- install 自动创建 `~/.local/bin/agent-lens` 符号链接
- hermes 轮询间隔从 5 分钟改为 30 分钟，查询加 LIMIT 5000
- VERSION 改为按需读取，install 不再复制 package.json

## 0.1.4 (2026-07-04)

### Added
- 跨工具对比 API（`/api/compare`）
- 报错分析 API（`/api/errors`）
- timeline 表 role 语义扩展 + error_type 自动分类
- dedup 索引防重复导入

### Changed
- 后端文件统一移到 `server/` 目录
- API 路由拆分到 `routes.js`

## 0.1.3 (2026-07-02)

### Added
- Pi 适配器（轮询 `~/.pi/agent/sessions/`）
- 跨平台系统服务管理（systemd / launchd / schtasks）
- 仪表盘重写

### Fixed
- MCP 工具合并 + 排行显示
- 来源过滤 tab 交互逻辑

## 0.1.2 (2026-06-30)

### Added
- Cursor 适配器
- Hermes timeline 收集（state.db 轮询 → timeline 表）
- Hermes poll state 持久化，重启不重复导入

## 0.1.1 (2026-06-28)

### Added
- OpenCode 适配器（轮询 `opencode.db`）
- Codex 适配器（钩子机制）
- 项目命名为 AgentLens

## 0.1.0 (2026-06-20)

### Added
- 初始版本：Claude Code 工具追踪
- 调用链可视化
- 分析仪表盘
- 暗色主题
