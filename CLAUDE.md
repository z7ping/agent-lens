# CLAUDE.md

Claude Code must follow the repository-wide rules in [`AGENTS.md`](AGENTS.md).

Before making architecture or contract changes, read:

1. [`ARCHITECTURE.md`](ARCHITECTURE.md)
2. [`docs/1.0/CORE-CONTRACT.md`](docs/1.0/CORE-CONTRACT.md)
3. [`docs/adr/0001-agentlens-1.0-clean-rebuild-and-cordis-runtime.md`](docs/adr/0001-agentlens-1.0-clean-rebuild-and-cordis-runtime.md)

Important 1.0 constraints:

- 1.0 is a Clean Rebuild; 0.x runtime code is reference material only.
- Cordis is the sole Plugin Runtime and is isolated behind `packages/runtime-cordis`.
- Sources write through `SourceRecord -> normalize -> ObservationService.commit`; they do not own presentation tables.
- Canonical Observation and Evidence are separate concepts.
- Static Asset discovery does not prove Asset usage.
- Web consumes `@agent-lens/protocol`, never Core/SQLite/Source packages directly.
- Do not merge to `main`, publish, or create a Release unless explicitly requested.
