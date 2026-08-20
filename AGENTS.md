# AGENTS.md

本文定义 AI 编码 Agent 修改 AgentLens 1.0 时必须遵守的工作规则。

## 1. 当前项目状态

AgentLens 1.0 是一次 **Clean Rebuild（彻底重建）**。

0.x 实现仅作为参考材料。不要通过包装或复用以下内容，把旧 Runtime Architecture 带回 1.0：

- `server/adapters/*` 的 Runtime 所有权；
- 旧 Importer 编排方式；
- 旧 `timeline` / `overview_*` 规范表；
- 旧 service manager / PID 架构；
- 旧 HTTP Response Shape。

0.x 代码仍可以用于参考解析行为、fixture、UI 思路和迁移逻辑。

## 2. 修改架构前必须阅读

依次阅读：

1. `ARCHITECTURE.md`
2. `docs/1.0/CORE-CONTRACT.md`
3. `docs/adr/0001-agentlens-1.0-clean-rebuild-and-cordis-runtime.md`

如果实现与这些文档冲突，不要静默绕过 Contract。要么修复实现 Bug，要么明确发起 Contract Review / ADR。

## 3. 架构规则

### Cordis

- 精确锁定 `@deepseek-ai/cordis@4.0.1`。
- Cordis 是唯一的 Plugin Runtime。
- Cordis 耦合必须放在 `packages/runtime-cordis`。
- Core Domain / Core Services 必须保持与框架无关。
- 不得再引入第二套 DI Container、Plugin Loader 或 Lifecycle Runtime。

### Canonical Data Flow

```text
SourceRecord
-> SourceDefinition.normalize()
-> ObservationCandidate + EvidenceCandidate
-> IdentityService
-> ObservationService.commit()
-> CanonicalObservation + Evidence
-> Projection
-> Protocol DTO
-> Surface/Web
```

Source 不得直接写展示表。

### Evidence

每一条规范事实都必须能由 Evidence 解释。

同一事实的第二条采集路径应该增强 Evidence，而不是创建重复 Observation。

### Projections

Projection 是可重建的读模型，不是额外的规范写入路径。

### Protocol

Web / Surface 消费 `@agent-lens/protocol` DTO。浏览器代码不得直接 import Core、SQLite 或 Source package。

## 4. 新增 Source

正常情况下，一个 Source 只需要新增：

```text
packages/source-<name>/
```

并在 Daemon Composition Root 中注册。

它应实现稳定的 `SourceDefinition` Contract：

```text
detect
declareCapabilities
ingestHistory? / startCapture? / discoverAssets?
normalize
```

通用 Source Runner 中不得出现 `if (sourceId === ...)` 之类的来源分支。

如果某个新 Source 无法在不歪曲事实的前提下适配现有 Contract，应停止普通接入流程，按 Contract Review 处理。

## 5. 当前 1.0 Source

已实现：

- Codex
- Claude Code
- Pi

不能因为 0.x 曾经支持过，就视为已经属于 1.0 Runtime：

- Hermes
- OpenCode
- Cursor
- OpenClaw

## 6. Hook 规则

Hook 子进程只是被动采集 Shim。

允许做：

- 读取 stdin / 原生事件数据；
- 清洗 / 截断敏感字段；
- 原子写入 durable inbox；
- 返回中性结果。

不得依赖：

- Cordis；
- SQLite；
- Core Services；
- HTTP；
- Daemon 生命周期。

Inbox 条目只有在成功完成 Canonical Ingestion 后才能确认并删除。

## 7. Asset 规则

绝不能把“静态发现”直接等同于“实际调用”。

例如：

- 已安装 Skill -> Asset state；
- 已配置 MCP -> Asset state；
- 调用 `mcp__server__tool` -> 可归因的 MCP Usage；
- 普通 Bash 调用 -> 仅算 Tool Usage，除非有明确 Evidence 能证明对应 Asset。

## 8. Storage 规则

使用 Core Repository Interface。

除了 storage package 自己在实现 Repository，不得绕过 `StorageService` 在业务代码里直接写功能专用 SQL。

不得重新引入旧 `timeline` / `overview` 表作为 1.0 规范事实。

## 9. UI 规则

1.0 Web 使用 Vite + 原生 TypeScript。

当前视图：

- Timeline
- Sessions / Interactions
- Tools & Assets

只使用 `/api/v1/*`。

实时更新使用 SSE。除非有明确的性能数据和正式决策，不要改回短间隔轮询。

## 10. CLI / Desktop 规则

CLI：

```text
agent-lens start
agent-lens status
agent-lens doctor
agent-lens hook ...
```

`start` 明确以前台方式运行。

Electron 只负责 Windows Desktop Lifecycle。不要把 Core / Source 逻辑搬进 `apps/desktop`。

## 11. 常用开发命令

```bash
npm install
npm run typecheck
npm test
npm run build:dist
npm pack --dry-run
npm run build:web
npm run cli -- doctor
npm run desktop:win      # Windows runner
```

Node.js 要求：`>=22.12.0`。

## 12. 语义变更必须覆盖的测试

修改以下内容时需要新增 / 更新测试：

- normalization mapping；
- dedup key；
- identity resolution；
- history / runtime reconciliation；
- checkpoint 行为；
- Asset 归因；
- Projection 排序 / 分组；
- Hook install / uninstall 安全性；
- Protocol / API 行为；
- Cordis compatibility。

关键不变量：

```text
same native semantic event from multiple evidence paths
=> one CanonicalObservation + multiple Evidence records
```

即：同一原生语义事件来自多条 Evidence Path 时，只产生一条 `CanonicalObservation`，但保留多份 `Evidence`。

## 13. 文档纪律

任何改变架构所有权 / 边界的决策，都必须同步更新：

- `ARCHITECTURE.md`；
- Contract 变化时更新 `docs/1.0/CORE-CONTRACT.md`；
- 对长期、难以逆转的决策补充 ADR。

不要把“计划能力”写成“已实现能力”。

## 14. 分支 / 发布安全

1.0 重建在明确合并前始终开发于 `refactor/1.0-foundation`。

未经仓库所有者明确要求，不得合并到 `main`、发布 npm、创建 GitHub Release 或修改 Release Secret。
