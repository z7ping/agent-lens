# @agent-lens/source-codex

AgentLens 1.0 的 Codex Source。

当前能力：

- 通过 `CODEX_HOME`、Session 数据和可执行文件证据检测 Codex；
- 声明当前已实现的 Observation Capability；
- 使用字节偏移 Checkpoint 增量读取 Rollout JSONL；
- 将已知原生记录 Normalize 为 Canonical Observation Candidate；
- 对无法识别的原生记录保留为 `unknown`，而不是静默丢弃；
- 在 SourceRecord 持久化前清理已知注入的 Developer / Environment Context；
- 通过 Cordis-native Plugin 入口把 `SourceDefinition` 注册到 `ctx.sources`。

Parser、History、Normalize、Asset Discovery 等实现保持基于 Core Contract，不依赖 Cordis 生命周期；只有插件入口负责运行时注册。

Prototype / 0.x Importer 不会被直接导入或包装。经过验证的解析行为和脱敏 Fixture 只作为实现参考与回归材料。
