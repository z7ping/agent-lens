# ADR-0001: AgentLens 1.0 Clean Rebuild and Cordis Runtime Ownership

- Status: Accepted
- Date: 2026-08-20
- Scope: AgentLens 1.0

## Context

AgentLens 0.x proved several product ideas: multi-source local observation, task replay, Hook capture, history import, asset discovery, and a browser UI. It also accumulated architecture tied to its original implementation: Adapter/Importer classes, presentation-oriented SQLite tables, a custom server lifecycle, Hook installation logic, and UI-driven data shapes.

During the 1.0 design work we also evaluated DeepSeek Harness (DSH), Cordis, and Alibaba LoongSuite Pilot as architecture references. The key question was whether AgentLens should keep evolving its 0.x runtime, build on DSH, or rebuild around a smaller stable contract with Cordis as runtime infrastructure.

## Decision

### 1. AgentLens 1.0 is a clean rebuild

0.x is reference material, not a compatibility runtime.

Allowed reuse:

- parsing algorithms;
- fixtures/tests;
- validated product behavior;
- UI ideas;
- one-shot migration/import rules.

Not allowed:

- wrapping old Adapter/Importer classes behind a new facade;
- retaining the old timeline/overview tables as canonical models;
- long-lived dual schemas;
- LegacyTimelineProjection;
- a compatibility server that keeps old API semantics alive indefinitely.

### 2. Cordis is the sole Plugin Runtime

AgentLens pins:

```text
@deepseek-ai/cordis@4.0.1
```

All Cordis coupling is isolated in:

```text
packages/runtime-cordis
```

Core Domain, Core Services, Sources, Protocol, and Storage contracts remain Cordis-independent wherever possible.

AgentLens will not implement a second lifecycle/DI/plugin-loader runtime beside Cordis.

### 3. AgentLens uses Cordis directly, not DSH as a dependency

DSH is useful as an architectural/productization reference, especially for replaceable components and harness composition, but AgentLens is a peer application with a different product responsibility.

AgentLens therefore does not depend on the DSH application/runtime stack.

### 4. Canonical Observation + Evidence is the primary data model

Native data enters as `SourceRecord`. Sources normalize into semantic candidates and evidence. `ObservationService.commit` owns canonical identity/deduplication.

Presentation views are projections over canonical data.

### 5. Source implementations are independent plugins against one contract

Codex, Claude Code, Pi, and future Sources must implement the same SourceDefinition shape. Generic history/runtime/asset runners must not branch by source name.

A new source-specific semantic requirement that cannot be expressed honestly triggers Contract Review rather than an escape hatch.

### 6. 0.x Sources do not automatically define the 1.0 support list

1.0 initially implements only Sources proven against the new contract.

Current baseline:

- Codex
- Claude Code
- Pi

Hermes, OpenCode, Cursor, OpenClaw, or others may return later only through the 1.0 Source Contract.

## Consequences

### Positive

- The domain model is no longer constrained by the 0.x UI/schema.
- History and runtime capture converge on one canonical path.
- Evidence provenance becomes first-class rather than presentation metadata.
- Source support can be tested as a real contract rather than an Adapter inheritance convention.
- Cordis provides lifecycle/DI/plugin composition without leaking into Core.
- Web/Desktop/HTTP can evolve without becoming canonical data owners.

### Negative

- 0.x runtime compatibility is intentionally broken.
- Some 0.x integrations are temporarily absent from 1.0.
- A clean schema means migration must be explicit rather than accidental.
- Initial implementation cost is higher than wrapping existing Adapters.

## Rejected alternatives

### Continue evolving the 0.x Adapter architecture

Rejected because it would preserve the very coupling 1.0 is intended to remove: source-specific runtime conventions, presentation tables as facts, and custom lifecycle ownership.

### Build AgentLens on top of DSH

Rejected because DSH solves a broader harness/application-composition problem. AgentLens needs a plugin runtime and a domain contract, not another product layer between AgentLens and its Sources.

### Fork/vendor Cordis immediately

Rejected because no demonstrated requirement justifies owning a fork at the start. The dependency is pinned and isolated; compatibility tests provide an earlier warning boundary.

If an unavoidable bug appears, the preferred escalation order is:

1. minimal compatibility wrapper in `runtime-cordis`;
2. minimal `pnpm/npm patch` style patch if required;
3. fork/vendor only when sustained upstream divergence is proven.

### Keep both old and new schemas until later

Rejected because dual canonical models would make every feature, test, and migration ambiguous and would turn a temporary bridge into permanent architecture.

## Validation

This decision is considered validated when:

- at least three materially different Sources use the same contract without Core source branches;
- history/runtime evidence can merge into one Canonical Observation;
- projections consume canonical repositories only;
- Web consumes Protocol DTOs only;
- Cordis remains isolated behind `runtime-cordis`;
- no 0.x Adapter/Importer/timeline runtime is required to start AgentLens 1.0.

The current 1.0 alpha baseline satisfies these conditions with Codex, Claude Code, and Pi.
