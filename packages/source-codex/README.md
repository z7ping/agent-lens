# @agent-lens/source-codex

AgentLens 1.0 Codex Source Plugin.

Initial scope:

- detect Codex from `CODEX_HOME`, session data, and executable evidence;
- declare currently implemented observation capabilities;
- incrementally ingest rollout JSONL with byte-offset checkpoints;
- normalize known records into Canonical Observation candidates;
- preserve unrecognized native records as `unknown` instead of dropping them;
- redact known injected developer/environment context before SourceRecord persistence.

Prototype / 0.x importer code is not imported or wrapped. Its verified parsing behavior and sanitized fixture are used only as implementation reference and regression material.
