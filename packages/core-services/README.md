# @agent-lens/core-services

Framework-independent default implementations of the AgentLens 1.0 Core Service contracts.

This package owns cross-source semantics such as identity resolution, evidence confidence, observation deduplication/merge, coverage evaluation, capability registration, and basic Asset/Tool/Projection services.

It depends on `@agent-lens/core`, not on Cordis or SQLite. Runtime wiring belongs to `@agent-lens/runtime-cordis`; persistence belongs to StorageService implementations.
