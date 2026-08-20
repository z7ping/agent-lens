# @agent-lens/storage-sqlite

AgentLens 1.0 SQLite storage plugin.

This package implements Core `StorageService` and domain Repository interfaces. Source Plugins, Projections, and Analyzers must not query SQLite tables directly.

The schema is a fresh 1.0 schema. Prototype / 0.x tables are not runtime dependencies; any legacy data import is a separate one-shot migration concern.
