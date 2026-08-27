# AGENTS.md

本文定义 AI 编码 Agent 修改 AgentLens 1.0 时必须遵守的项目级执行规则。

## 1. 当前项目状态

AgentLens 1.0 是一次 **Clean Rebuild（彻底重建）**。

当前 `main` 处于 1.0 Alpha 稳定化阶段；Hub Alpha 长期设计已冻结，但功能尚未实现。默认原则是优先验证和实现已经确定的边界，不继续无边界扩功能，也不重新设计已经冻结的 1.0 架构。

0.x 的旧 Runtime / UI / Test 只通过 Git 历史 / Tag 作为参考。禁止恢复：

- 旧 Adapter / Importer Runtime；
- 旧 `timeline` / `overview_*` 规范表；
- 旧 Service Manager / PID 架构；
- 旧 HTTP Response Shape；
- 根目录 `server/`、`src/`、`test/` 作为 1.0 Runtime / UI / Test 入口。

## 2. 修改前阅读入口

基础修改先读：

1. `ARCHITECTURE.md`
2. `docs/1.0/CORE-CONTRACT.md`
3. `docs/adr/0001-agentlens-1.0-clean-rebuild-and-cordis-runtime.md`

按任务补读：

- npm / Desktop 生命周期：`docs/adr/0004-dual-distribution-single-runtime-lifecycle.md`
- 安装 / 卸载 / 后台 / 自启 / Hook Provider：`docs/1.0/DISTRIBUTION-OPERATIONS.md`
- Hermes / OpenCode：`docs/1.0/HERMES-OPENCODE-SOURCES.md`
- Capture / Source 隐私：`docs/1.0/CAPTURE-POLICY.md`
- Hub 关键决策原因：`docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- Hub 当前有效设计：`docs/1.0/HUB-DESIGN.md`
- Hub R1：`docs/1.0/HUB-REPLICATION-PROTOCOL.md`
- Hub 配对 / 安全 / 出站数据：`docs/1.0/HUB-PAIRING-SECURITY.md`
- Hub 用户 / 运维生命周期：`docs/1.0/HUB-OPERATIONS.md`
- 当前跨会话任务：`agent-swe/work-state.yaml`

实现与长期文档冲突时，不静默绕过；先判断是实现 Bug，还是确实需要 Contract Review / ADR。

## 3. 文档与知识治理

遵守 `agent-swe` 的知识分层：

- 同一长期事实只保留一个主要权威来源，其他文档只做摘要或链接；
- ADR 只记录关键决定为什么形成、候选方案和长期影响，不承担完整实现 Contract；
- `agent-swe/work-state.yaml` 只保存小时 / 天 / 周级当前工作，不作为长期计划、开发日志或 ADR；
- 精确 DTO、Schema、Route、Migration 等在实现后优先由代码、Schema、OpenAPI / JSON Schema 或项目实际采用的等价标准工件成为权威来源；
- 不为“知识完整”机械新增 Markdown；没有独立长期语义时不要拆新文档；
- Hub Alpha 已冻结，不要重新创建 `HUB-*-CONTRACT / PLAN / TEST-MATRIX / DESIGN-INDEX` 一类重复长期文档；只有出现新的结构性边界才判断是否修改 `HUB-DESIGN.md` 或新增 ADR。

## 4. Cordis 与 Canonical Data Flow

Cordis 是唯一 Plugin Runtime；AgentLens 1.0 是 Cordis Application。

- 精确锁定 `@deepseek-ai/cordis@4.0.1`；
- **Core is framework-agnostic; runtime extensions are Cordis-native**；
- Core Domain / Core Services / Repository / Parser / Normalizer / Protocol DTO 不依赖 Cordis；
- Source / Storage / Surface 等运行时入口可以使用 Cordis Context / inject / lifecycle；
- 不再引入第二套 DI、Plugin Loader、Lifecycle 或通用 Plugin Adapter。

Canonical Data Flow：

```text
SourceRecord
 -> SourceDefinition.normalize()
 -> ObservationCandidate + EvidenceCandidate
 -> IdentityService
 -> ObservationService.commit()
 -> CanonicalObservation + Evidence
 -> Projection
 -> Protocol DTO
 -> Surface / Web
```

Source 不得绕过这条链直接写 Canonical Repository 或展示表。Projection 是可重建读模型，不是第二事实源。

每条规范事实必须能由 Evidence 解释；同一事实的第二条采集路径应增强 Evidence，而不是制造重复 Observation。

## 5. Source 规则

普通新增 Source 应只新增 `packages/source-<name>/` 并在 Daemon Composition Root 注册 Cordis Plugin。

稳定 `SourceDefinition`：

```text
detect
declareCapabilities
ingestHistory?
startCapture?
discoverAssets?
normalize
```

Parser / History / Normalize / Assets 尽量保持纯 TypeScript / Core Contract。通用 Source Runner 中不得出现 `if (sourceId === ...)` 一类来源业务分支。

当前已经实现并注册：

- Claude Code
- Codex
- Pi
- Hermes
- OpenCode

Hermes：`state.db` History / Native Tail + Assets；可选 Observer 只写 Durable Inbox。  
OpenCode：`opencode.db` History + Native DB Tail，不额外安装 Hook。

Cursor / OpenClaw 等只有正式按 1.0 Source Contract 实现后才属于当前 Runtime。

## 6. Hook / Observer 规则

Hook / Observer 只是被动采集 Shim。

允许：读取原生事件、清洗 / 截断、原子写 Durable Inbox、返回中性结果。

不得依赖：

- Cordis；
- SQLite；
- Core Services；
- HTTP；
- Daemon 生命周期。

只有成功完成 Canonical Ingestion 后才确认 / 删除 Inbox。

Codex / Claude Hook、Hermes Observer 都必须遵守 Source allowlist 并保持 fail-open。

Windows 共享 Hook Dispatcher 只做 Provider 选择与无窗口进程启动，不解析业务事件，不访问 Core / SQLite / HTTP，不扩展成第二套 Runtime。

## 7. Asset 规则

静态发现不等于实际使用：

- 已安装 Skill / 已配置 MCP -> Asset state；
- 有可靠 Evidence 的 Tool Call -> 才可归因 Usage；
- 普通 Bash / Read / Write 不强行归到某个 Asset。

Hub 中的 Remote Asset metadata 不表示文件存在于 Hub 本机；现有资产备份不得读取 Remote `AssetBinding.path`。

## 8. Storage / Projection / Protocol

- 使用 Core Repository Interface；业务代码不得绕过 Repository 写功能专用 SQL；
- SQLite Repository 保持 Cordis-independent；
- 不恢复旧 `timeline / overview` 事实表；
- Web / Surface 消费 `@agent-lens/protocol` DTO，浏览器不得直接 import Core / SQLite / Source；
- Hub Remote Replica 通过正式 Unified Read 给 Projection，不允许 Projection 直查 Replica 私表或用假空值填 Remote omitted 字段。

## 9. Hub Alpha 实现护栏

Hub 长期边界以 `HUB-DESIGN.md` 和 ADR-0007 为准。实现必须保持：

- Local Node 是事实 Primary，Hub 是 Replica + Aggregator；
- Hub 故障不阻塞本机 Source / Canonical Commit / SQLite / Web；
- Node / Hub 共用同一 AgentLensApplication，不拆第二套程序；
- Alpha 单 Hub 星型拓扑；
- 本机 Canonical ID 与跨机 ReplicaKey 分离；
- Project / AssetDefinition 保留 Origin + Shared Group Membership，不批量 Rewrite FK；
- Capture Policy / Replication Policy / History Scope 分离；
- Remote omitted / redacted 不伪造成 Local Canonical 值；
- Local HTTP 保持 loopback，Replication 使用独立 authenticated HTTPS；
- 不提供 Remote Control / Remote Web Login；
- Remote Import 压力不能饿死 Hub 本机 Canonical Commit。

实现过程中如果问题不改变这些长期边界，优先采用最简单实现，不再扩大设计。

## 10. UI 规则

1.0 Web 使用 Vite + React + TypeScript，只消费 `/api/v1/*`。

长期方向：

- 任务复盘保持高信息密度，目标是降噪而不是隐藏；
- 用户消息右、智能体左；
- 保留 Evidence、生命周期、工具执行、轮次和长会话 `turn-rail`；
- 工具正式图标使用 SVG；
- 普通界面文字不低于 12px；
- 会话列表与详情保持独立滚动上下文；
- 不用新增叠层补丁长期解决视觉冲突；
- `packages/web/src/tokens.css` 与 `docs/design/mockups/v2/assets/tokens.css` 基础 Token 保持一致；
- 关键前景 / 背景必须通过 `check:web-presentation` 对比度门禁；
- SSE 不得驱动整页高频重绘。

## 11. CLI / Desktop 规则

当前 CLI 包含 setup / start / status / doctor / service / autostart / hook 等入口。

`setup` 是一次性初始化，不自动启动长期 Daemon，也不默认开启登录自启。

后台生命周期属于发行 / 运维层：

- Windows：当前用户 Task Scheduler；
- Linux：`systemd --user`；
- macOS：用户级 `launchd`；
- 不维护 PID 文件；
- 不恢复 0.x Service Manager。

npm 与 Windows Desktop 可以同时安装，但同一默认数据根 / 默认端口同一时刻只允许一个有效 Daemon；Desktop 只停止自己启动的 Daemon。

源码模式注册系统托管前必须生成正式 `dist/cli.mjs`，不能登记临时 `tsx` 入口。

## 12. 常用开发命令

```bash
npm install
npm run check:web-presentation
npm run typecheck
npm test
npm run build:dist
npm pack --dry-run
```
