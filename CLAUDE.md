# CLAUDE.md

Claude Code 必须遵守仓库级规则：[`AGENTS.md`](AGENTS.md)。

在修改架构或 Core Contract 之前，先阅读：

1. [`ARCHITECTURE.md`](ARCHITECTURE.md)
2. [`docs/1.0/CORE-CONTRACT.md`](docs/1.0/CORE-CONTRACT.md)
3. [`docs/adr/0001-agentlens-1.0-clean-rebuild-and-cordis-runtime.md`](docs/adr/0001-agentlens-1.0-clean-rebuild-and-cordis-runtime.md)

1.0 的关键约束：

- 1.0 是 Clean Rebuild；0.x Runtime 代码仅作为参考材料。
- Cordis 是唯一的 Plugin Runtime，并通过 `packages/runtime-cordis` 隔离。
- Source 必须走 `SourceRecord -> normalize -> ObservationService.commit`，不能自行维护展示表。
- Canonical Observation 与 Evidence 是两个独立概念。
- 静态发现 Asset 不代表 Asset 被实际使用。
- Web 只能消费 `@agent-lens/protocol`，不得直接依赖 Core / SQLite / Source package。
- 未经明确要求，不得合并到 `main`、发布 npm 或创建 Release。
