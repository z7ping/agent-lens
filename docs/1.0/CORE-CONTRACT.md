# AgentLens 1.0 Core Contract

> Status: implemented baseline  
> API version: `1.0`

This document defines the stable semantic boundary that Source, Runtime, Storage, Projection, and Surface packages must obey.

## 1. Contract goals

The Core Contract exists so that adding another AI coding agent does not require rewriting storage, identity, projections, protocol, or Web code.

The contract separates five concerns:

```text
Native data
  -> SourceRecord
  -> normalization
  -> canonical identity/evidence
  -> CanonicalObservation
  -> derived projections
```

Core is framework-independent. It must not import Cordis, Electron, HTTP, or a source-specific package.

## 2. Plugin API

```ts
AGENT_LENS_PLUGIN_API_VERSION = '1.0'
```

Plugin manifests are metadata. Runtime ownership belongs to Cordis.

AgentLens must not create a second lifecycle, dependency-injection container, or plugin-loader runtime.

## 3. SourceDefinition

Every source implements the same contract shape:

```ts
interface SourceDefinition {
  manifest: SourceManifest
  detect(ctx: SourceDetectionContext): Promise<DetectedSource[]>
  declareCapabilities(detected: DetectedSource): Promise<ObservationCapability[]>
  discoverAssets?(ctx: SourceExecutionContext): AsyncIterable<DiscoveredAsset>
  ingestHistory?(ctx: SourceExecutionContext): AsyncIterable<SourceRecord>
  startCapture?(
    ctx: SourceExecutionContext,
    emitter: SourceRecordEmitter,
  ): Promise<Disposable>
  normalize(
    record: SourceRecord,
    ctx: SourceNormalizationContext,
  ): Promise<NormalizedSourceOutput>
}
```

Optional methods describe capabilities; absence is valid and must not be emulated with fake data.

## 4. SourceRecord

A SourceRecord is the persisted native ingestion unit.

Required semantics:

- stable AgentLens record ID;
- `sourceId`;
- `installationId`;
- native type;
- capture time;
- parser version;
- payload;
- source locator.

When available it should also preserve:

- source-native session ID;
- source-native event/call ID;
- source sequence;
- native event time;
- payload fingerprint.

SourceRecord is not a UI event and must not be shaped around a current Web page.

## 5. NormalizedSourceOutput

Normalization returns semantic candidates rather than directly writing presentation tables.

```text
NormalizedSourceOutput
  +-- observations[]
  +-- evidenceCandidates[]
  +-- coverage[]?
```

Unknown native records should be preserved as `unknown` observations when dropping them would erase potentially useful evidence.

## 6. ObservationCandidate

An ObservationCandidate describes the semantic event before canonical identity is resolved.

Current observation kinds include:

```text
session.lifecycle
message.user
message.assistant
message.reasoning
model.call
model.changed
tool.call
tool.progress
tool.result
permission.request
permission.response
subagent.spawn
subagent.end
context.compaction
context.summary
artifact.action
usage
unknown
```

A source must map native events to the closest defensible semantic kind. It must not invent meaning merely to fit a projection.

## 7. IdentityHints

Normalization may provide:

- native session ID;
- native parent session ID;
- workspace path;
- repository root;
- native actor ID;
- actor role;
- interaction-native ID;
- model name.

IdentityService owns canonicalization. Source packages must not manufacture Core database IDs.

## 8. Canonical identities

Core identity entities are:

```text
Host
AgentProduct
AgentInstallation
Project
Workspace
LogicalSession
SourceSession
SessionRelationship
AgentActor
Interaction
```

### LogicalSession

Canonical task/session scope for projections.

### SourceSession

Binds one source-native session ID to one installation and optionally one LogicalSession.

### SessionRelationship

Explicit relationship types:

```text
resume
continuation
fork
subagent
import-copy
related
```

Do not encode these semantics in string naming conventions when an explicit relationship is available.

## 9. EvidenceCandidate and Evidence

Every Canonical Observation must be explainable by Evidence.

Capture methods:

```text
runtime-hook
native-log
native-db
static-scan
external-import
```

Derivations:

```text
observed
reported
derived
estimated
inferred
```

Confidence:

```text
exact
high
medium
low
unknown
```

Evidence may include source record ID, source locator, parser version, native stable ID, event time, capture time, and missing reason.

Confidence cannot exceed what the capture method and derivation support.

## 10. DedupHints

Preferred semantic identity order:

```text
nativeEventId
nativeCallId
sharedEventKey
sourceSequence
payloadFingerprint + eventTime
semantic fallback
```

The Observation Service scopes identity by:

```text
sourceId
installationId
logicalSessionId
kind
```

This is intentional: two different sources reporting superficially similar data are not silently assumed to be the same fact.

## 11. ObservationService.commit

Commit is the canonical write boundary.

```text
CommitObservationInput
  +-- sourceId
  +-- host
  +-- installation
  +-- candidate
  +-- evidenceCandidates
```

Possible results:

```text
created    new canonical fact
merged     existing fact gained evidence
unchanged  idempotent replay; no semantic change
```

Required behavior:

- persist Evidence before/with Observation transactionally;
- preserve existing evidence when merging;
- never create a second canonical fact only because a second capture path observed the same native call;
- `unchanged` is a valid success result.

Acceptance example:

```text
Codex JSONL Tool Call(call_c1)
+ Codex Runtime Hook PreToolUse(call_c1)
= 1 CanonicalObservation(tool.call)
+ 2 Evidence records
```

Equivalent source-specific tests should exist when another source exposes both history and runtime evidence.

## 12. Source runners

`core-services/source-runner` provides generic orchestration:

```text
SourceHistoryRunner
SourceRuntimeRunner
SourceAssetRunner
```

Rules:

- runners receive SourceDefinition, Host, DetectedSource and AbortSignal;
- runners own installation resolution and capability registration;
- history/runtime both call the same `processSourceRecord` pipeline;
- runtime emit is serialized;
- Source-specific branching is forbidden in generic runners.

## 13. Checkpoints

Checkpoints are scoped by source and installation.

They are for ingestion position/state, not business facts.

Examples:

- JSONL byte offset;
- file path and size;
- parser sequence.

If a file shrinks or its identity changes, the source may reset its checkpoint deliberately.

## 14. Runtime capture durability

Runtime Hook delivery is at-least-once at the inbox boundary.

Required flow:

```text
Hook -> atomic inbox file -> daemon emit -> canonical commit -> ack/delete file
```

A failed canonical commit must leave the inbox entry available for retry.

Idempotence is therefore mandatory.

## 15. Asset contract

Asset discovery returns explicit structures:

```text
DiscoveredAsset
  +-- definition
  +-- binding
  +-- states[]
       +-- state
       +-- value
       +-- observedAt
       +-- evidenceCandidates[]
```

AssetDefinition represents capability identity such as Skill, MCP, Plugin, Hook, Rule, Extension, or other supported type.

AssetBinding represents that asset in a particular installation/path/source.

AssetStateObservation may state that a binding is installed/configured/enabled/discoverable.

Static discovery does **not** prove invocation.

## 16. Tool and Asset usage

Tool invocation is derived from Canonical `tool.call` / `tool.result` observations.

Asset usage is a separate projection concern.

Only defensible attribution is allowed. Current examples:

- `mcp__server__tool` -> MCP server `server`;
- Claude `Skill` tool with explicit skill name -> Skill usage.

A generic filesystem or shell tool must not be labelled as a Skill/Plugin/MCP merely because such assets are installed.

## 17. Coverage and Capability

Capability declaration describes what a Source can observe.

Coverage describes what AgentLens actually knows for a subject/time range.

Coverage statuses:

```text
complete
partial
unknown
unavailable
```

An unavailable source capability must not be reported as complete coverage.

## 18. StorageService

Core depends on repository interfaces, not SQLite directly.

RepositorySet currently exposes:

```text
hosts
installations
sessions
sourceRecords
observations
evidence
coverage
assets
tools
```

Storage also exposes scoped checkpoints and transactions.

SQLite is one implementation of this contract.

## 19. Projection contract

Projection output is rebuildable from canonical data.

Current projections:

```text
TimelineProjection
SessionProjection
ToolAssetUsageProjection
```

No projection may become a second canonical write path.

Projection-specific caching/materialization can be added later only if rebuild/invalidation semantics remain explicit.

## 20. Protocol boundary

`@agent-lens/protocol` owns public DTOs.

Surface/Web code should consume protocol DTOs rather than Core domain models.

This keeps storage and domain refactors from becoming browser API changes accidentally.

## 21. Runtime event bridge

Core event names include:

```text
source/registered
source/detected
source-record/received
observation/committed
coverage/changed
asset/changed
projection/invalidated
projection/rebuilt
```

Cordis adapts these events to runtime consumers.

`observation/committed` is emitted only when a canonical observation is created or gains new evidence; unchanged replays do not produce live-update noise.

## 22. Contract-change rule

Adding a new Source is ordinary feature work when the existing contract can express its data honestly.

A Contract Review is required when implementation would need to change any of these:

- canonical identity semantics;
- Observation kind meaning;
- Evidence semantics;
- Source lifecycle contract;
- Plugin Runtime ownership;
- transaction/dedup guarantees;
- public protocol semantics.

Do not weaken the contract with source-specific escape hatches merely to land one adapter faster.

## 23. Compatibility rule

1.0 does not promise runtime compatibility with 0.x adapters or persistence tables.

Any legacy migration must be one-shot import into the 1.0 contract. It must not keep the 0.x runtime model alive indefinitely.
