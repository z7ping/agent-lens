## 未发布

### 修复
- 修复工具关联会话失败统计反复扫描历史、阻塞 Runtime 和页面数据加载的问题；一次查询共享工具事件物化结果，复用批量工具关联聚合，并使下钻失败数遵循当前时间筛选。
- 为工具分析与智能体概览基准增加可失败的 p95 预算，并使用兼容当前 npm 的直接 Node 参数入口。

## 1.0.0-alpha.2（2026-08-28）

### Changed
- 版本更新至 1.0.0-alpha.2，详见本次发布说明。

## 1.0.0-alpha.1（2026-08-28）

### Changed
- 任务复盘在会话间切换时保留阅读位置，并为虚拟化或尚未挂载的轮次保留稳定恢复锚点，减少长会话来回查看时的定位丢失。
- 三项关键交互收口纳入常规校验；`release/**` 发布分支也会自动执行 AgentLens 1.0 三平台 CI。
- 发版流程明确支持从独立 `release/<version>` 分支创建版本，发布分支上的通用修复在发版后同步回 `main`。
- npm 发布前新增最终 `.tgz` 成品包安装冒烟，覆盖 Windows x64、Linux x64、macOS ARM64 与 macOS Intel x64；release 分支同时预检 npm Registry 发布凭据。

### Fixed
- 修正 npm 分发过程中的本地 workspace 包发布路径，并增加防回归校验，避免发布阶段把本地包路径误解析为 Git 依赖。
- 修复 macOS / Linux 通过 npm 安装后 `.bin/agent-lens` 符号链接导致 CLI 未进入 `main()`、命令静默退出的问题；入口判断改为解析真实路径并增加跨平台回归测试。
- 切换到存在 failed / unknown 状态的 Agent 来源时自动展开采集诊断，异常不再隐藏在折叠面板中。
- 创建资产快照成功后明确显示文件数量、总容量和按安全规则排除的项目数量，避免操作完成后缺少反馈。

### Known limitations
- `1.0.0-alpha.1` 是 `alpha.0` 的稳定化修正版，不包含后续多机 Hub 架构与实现；Hub 从该版本基线之后继续开发。

# 更新日志

## 1.0.0-alpha.0（2026-08-26）

### Added
- 以 Canonical Observation + Evidence 为核心完成 1.0 Clean Rebuild，Source、Storage、Surface 统一走 Core Contract 与 Cordis 运行时，不再复用 0.x 运行架构。
- 正式支持 Codex、Claude Code、Pi、Hermes、OpenCode、DeepSeek Harness 六类 Source，统一历史采集、实时采集、资产发现与 Coverage（覆盖范围）表达。
- 新增 RuntimeProfile（运行配置）模型，区分安装实例与 Profile / Environment；DeepSeek Harness 多 Profile 不再伪装成多份安装。
- 新增 SessionRelationshipCandidate（会话关系候选）到正式 SessionRelationship 的晋升链，保留 parent / fork / resume / subagent 等原生关系事实，不做无证据强推断。
- 新增 SourceRuntimeStatus（来源运行状态）、未知事件统计、Coverage 汇总、Checkpoint 与数据库增长诊断，为长期狗粮提供来源健康与缺口可见性。
- 任务复盘、工具分析、智能体概览、资产备份统一接入真实 1.0 数据；任务复盘保留 Evidence、原始数据、生命周期、Pi / DSH 会话关系和长会话能力。
- CLI 提供 `setup`、`start`、`status`、`doctor`、`service`、`autostart` 与 Hook 管理；npm / Windows Desktop 共享同一默认数据目录与单实例 Daemon。
- 新增品牌主 SVG、小尺寸 SVG 与候选设计母版归档，并加入纯矢量、自包含和正式引用检查。

### Changed
- Web 采用冻结后的 1.0 高保真体系：冷中性灰画布、白色数据层、用户消息右侧、智能体左侧；关键交互进入表现层契约检查，CSS 不再负责隐藏业务操作。
- Source 默认只采集本机实际检测到的正式一方来源；内容仍遵守 CapturePolicy，提示词、工具、配置和环境信息按独立档位控制。
- npm 后台生命周期直接使用 Windows 当前用户计划任务、Linux `systemd --user`、macOS 用户级 `launchd`，不恢复 PID / Service Manager 体系。
- npm 预发布通过 GitHub Release 发布同一个已验证 tarball，并固定使用 npm `alpha` dist-tag，不占用 `latest`。

### Fixed
- 移除品牌 SVG 裁剪层外的纯黑底和 Windows 派生图标的深色外描边；应用 ICO、窗口 PNG 与托盘 ICO 保持透明圆角，并增加黑角 / 黑边回归门禁。
- Windows 交互安装完成后默认运行 AgentLens，普通双击立即显示“AgentLens · 智能体透镜”启动窗口；首次历史同步期间合并并发 Health 探测并延长就绪等待，避免把仍在工作的 Daemon 误判为失败后强制终止。
- Electron bootstrap 与 Daemon 日志统一到同一目录；打包版优先写入 `<安装目录>\logs`，支持 `AGENT_LENS_LOG_DIR` 覆盖，只在目录不可写时回退 `%APPDATA%\AgentLens\logs`。

### Security
- HTTP 默认仅监听 `127.0.0.1`；敏感键在 SourceRecord、Normalize Output、Raw Payload 与 Evidence 持久化前统一脱敏。
- DSH request/header、MCP 配置、环境变量、API Key / Token 等新增端到端隐私回归，默认不把凭据写入观测数据库。

### Known limitations
- `1.0.0-alpha.0` 主要用于真实狗粮与模型/Source 稳定化；部分来源能力可能显示为 partial / unavailable / unknown，应以 Coverage 与 Evidence 为准。
- Windows Desktop 仍处于实机安装、覆盖升级和启动诊断验收阶段；npm/CLI 是本次 alpha 的主要发布入口。

## 0.7.0（未发布）

### Added
- 概览新增“配置透镜”视图，按来源展示配置覆盖链、能力证据、运行时状态和运行时/历史对账摘要。
- `/api/overview` 为每个来源返回配置证据、配置链、运行状态、来源能力矩阵和对账摘要，区分静态发现、运行时 Hook、原生日志与本地数据库证据。
- Codex 与 Pi 的概览扫描补充模型、审批策略、沙箱模式等运行边界配置；Pi settings 中的 MCP 配置也会进入能力资产。
- Claude Code CLI 的概览扫描补充 `settings.json`、`.claude.json`、Commands、MCP、模型、权限模式和 AgentLens Hook 覆盖诊断。
- Hermes 的概览扫描补充 `config.yaml` 中的模型、模型提供方、权限模式和沙箱模式等运行边界配置。
- `/api/sources/status` 新增 AgentLens 自身安装诊断，检查应用目录、前端产物、Hook 脚本、运行目录、Hook token、PID 文件和 Windows Hook Runner。
- `/api/hook` 新增 Pi 只观察运行时事件接收路径，可将 Pi runtime 事件按 `runtime_hook` 证据写入 timeline，并参与运行时/历史对账。
- 发布包新增可被 Pi 宿主加载的只观察运行时扩展入口，注册 Session、Turn、工具和压缩相关原生事件并上报到 AgentLens；`/api/sources/status` 可诊断该扩展是否已随 AgentLens 打包、是否被 Pi settings 引用，以及缺失原因。
- CLI 新增 `pi-extension status/install/upgrade/uninstall`，显式管理 AgentLens 自己的 Pi 只观察扩展配置；写入前备份 `settings.json`，并在配置损坏或 `extensions` schema 不确定时停止修改。
- 配置透镜新增 Pi 工具调用级 runtime/native 对账摘要，按稳定 `call_id` 展示已对账、仅运行时、仅历史和冲突数量。
- 任务复盘中的 Pi 工具事件新增逐调用对账徽标，显示“已对账”“仅运行时”“仅历史”和“对账冲突”等状态，并保留对账键与事件数量说明。
- 主功能 Tab、来源和项目切换新增轻遮罩加载反馈；会话列表、会话详情分页、工具栈评分和概览刷新统一显示局部加载动画。

### Changed
- 配置透镜不再把磁盘发现等同于本次运行加载；同一能力可以同时显示“静态发现”和“本次调用”两类证据。
- Pi 缺少可用运行时扩展时会明确标记为历史模式，并显示原生 JSONL 降级原因。
- Claude Code CLI 的 Hook 配置状态改为按 AgentLens Pre/Post 工具 Hook 覆盖诊断，不再仅因 `settings.json` 存在就标记为已配置。
- Pi 运行时工具结果会通过稳定 `tool_call_id` 关联到运行时 `tool_use`；缺少调用标识时保留事件但标记为部分可信。
- Pi 工具事件会写入 `reconciliation_key` 元数据，便于解释同一工具调用在运行时事件和原生 JSONL 中的对应关系。

## 0.6.2（2026-08-14）

### Added
- 任务复盘的会话详情支持 timeline 游标分页，展开会话时先加载首屏事件，并可按需继续加载后续事件，避免长会话一次性渲染导致卡顿。
- 任务复盘的会话列表支持 cursor 分页，首屏减少为 20 个会话，并可按需继续加载更多会话。
- Windows Hook Runner 发布链路改为由 GitHub Actions 在 Windows runner 上从源码构建，并作为发布 job 的输入产物使用。
- 发布流程新增基础校验材料，包括 Windows Hook Runner、npm 包和关键清单文件的 SHA-256 摘要，以及 npm SBOM。

### Changed
- `/api/timeline` 返回 `has_more` 和 `next_cursor`，前端“展开全部”不再把单个超长会话的全部事件一次性拉到浏览器。
- 会话卡片启用渲染隔离并减少滚动时的阴影和全属性过渡开销，降低长列表滑动卡顿。
- Windows 源码安装在缺少无窗口 Hook Runner 时会尝试本机构建；无法构建时明确提示改用 npm 发布包。
- npm 包和 GitHub Release 分发包使用 CI 构建出的 Windows Hook Runner，避免依赖维护者本机手工二进制。

## 0.6.1（2026-08-14）

### Changed
- 任务复盘中的用户与 AI 对话气泡统一在超过 5 行时默认折叠，并支持展开后再次折叠；Markdown 渲染、源码视图和窄屏换行会按实际高度重新判断。
- 产品标题更新为“AgentLens | 智能体透镜”，采用“看清智能体的每一次行动”作为 Slogan；README 默认简体中文，并提供英文版本。

### Fixed
- Windows 升级切换程序目录时会阻止 Hook 自动拉起服务，并清理仍从已安装目录运行的服务与 Hook 进程；短暂文件占用会有限重试，避免 `EBUSY` 导致安装失败。
- 任务复盘中的用户气泡恢复为原型使用的黑灰配色，并同步校正暗色主题及气泡内 Markdown 内容的对比度。

## 0.6.0 (2026-08-13)

### Added
- Pi 原生 Session JSONL 现在按 entry ID、`parentId` 和 `parentSession` 重建稳定事件身份、树形父子关系与派生 Session 证据，并导入模型切换、thinking level、压缩和分支摘要事件。
- 任务复盘改为来源无关的统一执行流，按 Turn 将用户与 AI 对话气泡、思考信号、生命周期事件和工具调用依发生顺序展示，同时继续区分运行时、原生日志和静态发现证据。

### Changed
- Pi 历史采集改为按文件字节偏移增量读取，保留未完整写入的尾行并在文件截断时安全重扫，不再以轮询时间戳筛选事件。
- Pi 并行工具调用与结果只使用原生 `toolCallId` 配对；普通回复不混入来源可见的 thinking 正文，只记录是否存在及块数量。
- `agent-lens service status` 增加当前命令、已安装应用和运行中服务版本，并展示 Node.js、服务管理方式、默认地址和安装目录；版本不一致时明确告警。

### Security
- Pi 用户消息、压缩摘要和分支摘要统一遵守提示词采集策略；工具参数继续按类型摘要并在入库前递归脱敏。
- 升级 PostCSS、Nano ID、Concurrently 与 shell-quote 的开发依赖锁定版本，清除构建工具链中的已知高危漏洞。

## 0.5.2 (2026-08-13)

### Fixed
- Windows 上的 Claude Code、Codex 和 Cursor Hook 改由 PATH 中的 GUI 子系统启动器同步执行 Node 脚本，无空格命令名兼容 PowerShell 与 `cmd.exe`，避免高频生命周期与工具事件反复创建可见控制台窗口。
- 无窗口启动器按原始字节透传 Hook 的标准输入、标准输出和错误输出，并保留退出码，避免中文 JSON、`Stop` / `SubagentStop` 中性响应或错误状态在隐藏窗口时丢失。
- 安装暂存和 npm 分发包纳入可审计的启动器源码与已编译文件，并增加 Windows PE 子系统、路径空格、标准流和退出码回归测试。

## 0.5.1 (2026-08-12)

### Fixed
- Windows 安装、升级、PATH 更新、原生依赖处理和服务管理涉及的子进程统一隐藏窗口，避免安装过程中反复闪现控制台。
- 概览定时扫描调用 Codex、Claude Code、Hermes、Pi、Cursor 和 OpenCode CLI 获取版本时隐藏子进程窗口，避免服务运行过程中周期性连续弹出黑窗。
- 服务完成核心数据库初始化后先监听 HTTP 并写入 PID，再延迟启动历史 JSONL 导入、概览扫描和适配器轮询，避免大量历史数据阻塞就绪检查。
- 安装与回滚的服务就绪上限由 30 秒提高到 120 秒，并校验 HTTP 返回的实际安装版本，避免慢启动误报成功或错误回滚。

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
