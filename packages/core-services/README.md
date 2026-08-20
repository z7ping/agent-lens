# @agent-lens/core-services

AgentLens 1.0 Core Service Contract 的框架无关默认实现。

本包负责跨 Source 的统一语义，包括 Identity Resolution、Evidence Confidence、Observation 去重/合并、Coverage、Capability Registration，以及基础 Asset / Tool / Projection Service。

本包只依赖 `@agent-lens/core`，不依赖 Cordis 或 SQLite。运行时装配由 Cordis Application 负责；持久化由 `StorageService` 实现负责。
