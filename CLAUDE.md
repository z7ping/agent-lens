# CLAUDE.md

Claude Code 必须遵守仓库级规则：[`AGENTS.md`](AGENTS.md)。

在修改架构或 Core Contract 之前，先阅读：

1. [`ARCHITECTURE.md`](ARCHITECTURE.md)
2. [`docs/1.0/CORE-CONTRACT.md`](docs/1.0/CORE-CONTRACT.md)
3. [`docs/adr/0001-agentlens-1.0-clean-rebuild-and-cordis-runtime.md`](docs/adr/0001-agentlens-1.0-clean-rebuild-and-cordis-runtime.md)

1.0 的关键约束：

- 1.0 是 Clean Rebuild；0.x Runtime 代码仅作为历史参考材料。
- Cordis 是唯一 Plugin Runtime；AgentLens 1.0 本身是 Cordis Application。
- Core Domain、Core Services、Repository Contract、Parser / Normalizer、Protocol DTO 保持框架无关。
- Source / Storage / Surface 等运行时扩展入口直接采用 Cordis-native Plugin，不再增加通用 Adapter 二次包装。
- Source 必须走 `SourceRecord -> normalize -> ObservationService.commit`，不能绕过 Canonical Pipeline 自行维护事实或展示表。
- Canonical Observation 与 Evidence 是两个独立概念。
- 静态发现 Asset 不代表 Asset 被实际使用。
- Web 只能消费 `@agent-lens/protocol` / `/api/v1/*`，不得直接依赖 Core / SQLite / Source package。
- 提交信息、Pull Request 标题和正文使用中文。
- 未经明确要求，不得合并到 `main`、发布 npm 或创建 Release。
