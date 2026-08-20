# AGENTS.md

This file defines the working rules for AI coding agents modifying AgentLens 1.0.

## 1. Current project state

AgentLens 1.0 is a **Clean Rebuild**.

The 0.x implementation is reference material only. Do not restore old runtime architecture by wrapping or reusing:

- `server/adapters/*` runtime ownership;
- old Importer orchestration;
- legacy `timeline` / `overview_*` canonical tables;
- old service manager / PID architecture;
- legacy HTTP response shapes.

0.x code may still be consulted for parser behavior, fixtures, UI ideas, and migration logic.

## 2. Required reading before architecture changes

Read:

1. `ARCHITECTURE.md`
2. `docs/1.0/CORE-CONTRACT.md`
3. `docs/adr/0001-agentlens-1.0-clean-rebuild-and-cordis-runtime.md`

If implementation conflicts with these documents, do not silently work around the contract. Either fix an implementation bug or record a deliberate Contract Review/ADR.

## 3. Architecture rules

### Cordis

- `@deepseek-ai/cordis@4.0.1` is pinned exactly.
- Cordis is the sole Plugin Runtime.
- Cordis coupling belongs in `packages/runtime-cordis`.
- Core Domain/Core Services must stay framework-independent.
- Do not add a second DI container, plugin loader, or lifecycle runtime.

### Canonical data flow

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

Do not write presentation tables directly from a Source.

### Evidence

Every canonical fact must remain explainable by Evidence.

A second capture path should strengthen evidence for the same fact instead of creating a duplicate observation.

### Projections

Projections are rebuildable read models. They are not additional canonical write paths.

### Protocol

Web/surfaces consume `@agent-lens/protocol` DTOs. Browser code must not import Core, SQLite, or Source packages.

## 4. Adding a Source

A Source normally needs:

```text
packages/source-<name>/
```

and registration in the daemon composition root.

It should implement the stable SourceDefinition contract:

```text
detect
declareCapabilities
ingestHistory? / startCapture? / discoverAssets?
normalize
```

Generic Source runners must not gain `if (sourceId === ...)` branches.

If a new Source cannot be represented honestly without changing canonical semantics, stop and treat that as Contract Review.

## 5. Current 1.0 Sources

Implemented:

- Codex
- Claude Code
- Pi

Not yet considered 1.0 runtime support merely because 0.x had code for them:

- Hermes
- OpenCode
- Cursor
- OpenClaw

## 6. Hook rules

Hook subprocesses are passive capture shims.

They may:

- read stdin/native event data;
- sanitize/truncate sensitive fields;
- atomically write a durable inbox record;
- return a neutral result.

They must not depend on:

- Cordis;
- SQLite;
- Core Services;
- HTTP;
- daemon lifecycle.

Inbox entries are acknowledged only after successful canonical ingestion.

## 7. Asset rules

Never equate static discovery with invocation.

Examples:

- installed Skill -> Asset state;
- configured MCP -> Asset state;
- `mcp__server__tool` call -> attributable MCP usage;
- generic Bash call -> Tool usage only unless there is explicit evidence for an Asset.

## 8. Storage rules

Use Core repository interfaces.

Do not reach around StorageService with feature-specific direct SQL unless the storage package is implementing a repository itself.

Do not reintroduce old `timeline`/`overview` tables as canonical 1.0 facts.

## 9. UI rules

1.0 Web is Vite + native TypeScript.

Current views:

- Timeline
- Sessions / Interactions
- Tools & Assets

Use `/api/v1/*` only.

SSE is the live-update mechanism. Do not replace it with short-interval polling unless there is a measured reason and an explicit decision.

## 10. CLI/Desktop rules

CLI:

```text
agent-lens start
agent-lens status
agent-lens doctor
agent-lens hook ...
```

`start` is foreground by design.

Electron owns Windows desktop lifecycle only. Do not move Core/Source logic into `apps/desktop`.

## 11. Common development commands

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

Node.js requirement: `>=22.12.0`.

## 12. Tests expected for semantic changes

Add/update tests when changing:

- normalization mappings;
- dedup keys;
- identity resolution;
- history/runtime reconciliation;
- checkpoint behavior;
- Asset attribution;
- Projection ordering/grouping;
- Hook install/uninstall safety;
- Protocol/API behavior;
- Cordis compatibility.

Key invariant:

```text
same native semantic event from multiple evidence paths
=> one CanonicalObservation + multiple Evidence records
```

## 13. Documentation discipline

Architecture decisions that change ownership/boundaries must update:

- `ARCHITECTURE.md`;
- `docs/1.0/CORE-CONTRACT.md` when the contract changes;
- an ADR when the decision is durable and costly to reverse.

Do not document a planned capability as implemented.

## 14. Branch/release safety

The 1.0 rebuild is developed on `refactor/1.0-foundation` until deliberately merged.

Do not merge to `main`, publish npm, create a GitHub Release, or alter release secrets unless explicitly requested by the repository owner.
