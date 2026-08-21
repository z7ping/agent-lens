# @agent-lens/storage-sqlite

AgentLens 1.0 的 SQLite Storage 实现与 Cordis-native Storage Plugin 入口。

SQLite Repository 实现 Core `StorageService` 与领域 Repository Interface；Repository 本身保持与 Cordis 无关，插件入口负责通过 Cordis 生命周期提供 `ctx.storage`。

Source Plugin、Projection 和 Analyzer 不得直接查询 SQLite 表。

Schema 是全新的 1.0 Schema。Prototype / 0.x 表不属于运行时依赖；如需迁移旧数据，应作为一次性迁移流程单独处理。
