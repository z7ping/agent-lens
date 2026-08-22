# AgentLens 1.0 Core Contract

> 状态：已实现的基线  
> API 版本：`1.0`

本文定义 Source、Runtime、Storage、Projection 与 Surface package 必须共同遵守的稳定语义边界。

## 1. Contract 目标

Core Contract 的目标是：新增一个 AI 编码 Agent 时，不需要重写 Storage、Identity、Projection、Protocol 或 Web。

Contract 将以下五类关注点分开：

```text
Native data
  -> SourceRecord
  -> normalization
  -> canonical identity/evidence
  -> CanonicalObservation
  -> derived projections
```

Core 必须与框架无关，不得 import Cordis、Electron、HTTP 或任何 Source 专用 package。

## 2. Plugin API

```ts
AGENT_LENS_PLUGIN_API_VERSION = '1.0'
```

Plugin Manifest 只负责元数据。Runtime 所有权属于 Cordis。

AgentLens 不得创建第二套生命周期、DI Container 或 Plugin Loader Runtime。

## 3. SourceDefinition

所有 Source 都实现同一套 Contract：

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

可选方法用于表达 Source 实际具备的能力；某个能力不存在是合法状态，不得通过伪造数据补齐。

## 4. SourceRecord

`SourceRecord` 是持久化后的原生摄取单元。

必须具备的语义：

- 稳定的 AgentLens record ID；
- `sourceId`；
- `installationId`；
- native type；
- capture time；
- parser version；
- payload；
- source locator。

来源能够提供时，还应保留：

- 来源原生 Session ID；
- 来源原生 event / call ID；
- source sequence；
- 原生 event time；
- payload fingerprint。

`SourceRecord` 不是 UI Event，也不能围绕某个当前页面的数据形状设计。

## 5. NormalizedSourceOutput

Normalization 返回语义 Candidate，而不是直接写展示表。

```text
NormalizedSourceOutput
  +-- observations[]
  +-- evidenceCandidates[]
  +-- coverage[]?
```

对于未知原生记录，如果直接丢弃会损失潜在有效 Evidence，应保留为 `unknown` Observation。

## 6. ObservationCandidate

`ObservationCandidate` 描述 Canonical Identity 解析之前的语义事件。

当前 Observation Kind 包括：

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

Source 必须把原生事件映射到最接近且可被证据支持的语义 Kind。不能为了适配某个 Projection 而凭空发明语义。

## 7. IdentityHints

Normalization 可以提供：

- native session ID；
- native parent session ID；
- workspace path；
- repository root；
- native actor ID；
- actor role；
- interaction-native ID；
- model name。

Canonicalization 由 `IdentityService` 负责。Source package 不得自行制造 Core Database ID。

## 8. Canonical Identity

Core Identity Entity 包括：

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

Projection 使用的规范任务 / 会话范围。

### SourceSession

将一个来源原生 Session ID 与某个 Installation 绑定，并可选关联到 LogicalSession。

### SessionRelationship

显式关系类型：

```text
resume
continuation
fork
subagent
import-copy
related
```

已有显式关系时，不要再用字符串命名约定承载这些语义。

## 9. EvidenceCandidate 与 Evidence

每一条 Canonical Observation 都必须能够被 Evidence 解释。

Capture Method：

```text
runtime-hook
native-log
native-db
static-scan
external-import
```

Derivation：

```text
observed
reported
derived
estimated
inferred
```

Confidence：

```text
exact
high
medium
low
unknown
```

Evidence 可以包含 source record ID、source locator、parser version、native stable ID、event time、capture time 和 missing reason。

Confidence 不得高于 capture method 与 derivation 本身能够支持的可信度。

## 10. DedupHints

首选语义身份顺序：

```text
nativeEventId
nativeCallId
sharedEventKey
sourceSequence
payloadFingerprint + eventTime
semantic fallback
```

Observation Service 的身份作用域为：

```text
sourceId
installationId
logicalSessionId
kind
```

这是刻意设计的：不同 Source 报告了表面相似的数据时，不能在没有依据的情况下自动认定为同一事实。

## 11. ObservationService.commit

`commit` 是规范写入边界。

```text
CommitObservationInput
  +-- sourceId
  +-- host
  +-- installation
  +-- candidate
  +-- evidenceCandidates
```

可能返回：

```text
created    新的规范事实
merged     既有事实新增了 Evidence
unchanged  幂等重放，没有语义变化
```

必须满足：

- Evidence 与 Observation 在事务边界内一起持久化；
- merge 时保留已有 Evidence；
- 同一个原生 call 被第二条采集路径观察到时，不得因此生成第二条规范事实；
- `unchanged` 是合法成功结果。

验收示例：

```text
Codex JSONL Tool Call(call_c1)
+ Codex Runtime Hook PreToolUse(call_c1)
= 1 CanonicalObservation(tool.call)
+ 2 Evidence records
```

如果其他 Source 同时存在 History 与 Runtime Evidence，也应具备等价的 Source 专用测试。

## 12. Source Runner

`core-services/source-runner` 提供通用编排：

```text
SourceHistoryRunner
SourceRuntimeRunner
SourceAssetRunner
```

规则：

- Runner 接收 `SourceDefinition`、Host、DetectedSource 与 AbortSignal；
- Runner 负责 Installation Resolution 与 Capability Registration；
- History / Runtime 都必须进入同一个 `processSourceRecord` Pipeline；
- Runtime Emit 必须串行化；
- 通用 Runner 中禁止出现 Source 专用分支。

## 13. Checkpoint

Checkpoint 按 Source 与 Installation 隔离。

它只记录摄取位置 / 状态，不是业务事实。

例如：

- JSONL byte offset；
- file path 与 size；
- parser sequence。

如果文件缩小或身份发生变化，Source 可以有意识地重置 Checkpoint。

## 14. Runtime Capture Durability

Runtime Hook 在 Inbox 边界采用 at-least-once 交付语义。

必须遵循：

```text
Hook -> atomic inbox file -> daemon emit -> canonical commit -> ack/delete file
```

Canonical Commit 失败时，Inbox Entry 必须保留，以便重试。

因此幂等性是强制要求。

## 15. Asset Contract

Asset Discovery 返回显式结构：

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

`AssetDefinition` 表达能力身份，例如 Skill、MCP、Plugin、Hook、Rule、Extension 或其他支持类型。

`AssetBinding` 表达该 Asset 在某个 Installation / Path / Source 中的具体绑定。

`AssetStateObservation` 可以表达该 Binding 是否 installed / configured / enabled / discoverable。

静态发现 **不等于** 实际调用。

## 16. Tool 与 Asset Usage

Tool Invocation 从 Canonical `tool.call` / `tool.result` Observation 派生。

Asset Usage 是独立的 Projection Concern。

只有能够可靠归因时才允许生成 Asset Usage。目前示例：

- `mcp__server__tool` -> MCP Server `server`；
- Claude `Skill` Tool 且明确给出 Skill 名称 -> Skill Usage。

普通文件系统或 Shell Tool 不能仅因为机器上安装了某个 Skill / Plugin / MCP，就被标记为对应 Asset Usage。

## 17. Coverage 与 Capability

Capability Declaration 表达某个 Source 能观测什么。

Coverage 表达 AgentLens 对某个 Subject / 时间范围实际掌握了多少。

Coverage Status：

```text
complete
partial
unknown
unavailable
```

Source 不具备某项能力时，不能报告为 complete coverage。

## 18. StorageService

Core 依赖 Repository Interface，而不是直接依赖 SQLite。

当前 `RepositorySet` 暴露：

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

Storage 还提供带作用域的 Checkpoint 与 Transaction。

SQLite 只是该 Contract 的一种实现。

Storage 可以提供只读的 Projection 优化能力，例如按会话聚合规范 Observation 的 `SessionSummaryReader`。这类能力只能返回可由 Canonical Repository 重建的结果，不得成为新的写入路径；缺少优化能力时 Projection 必须仍可从基础 Repository 正确重建。

## 19. Projection Contract

Projection Output 必须能够从 Canonical Data 重建。

当前 Projection：

```text
TimelineProjection
SessionProjection
ReviewProjection
ToolAssetUsageProjection
FacetProjection
AgentOverviewProjection
SessionRelationshipProjection
```

任何 Projection 都不得成为第二条 Canonical Write Path。

未来允许增加 Projection Cache / Materialization，但前提是 Rebuild / Invalidation 语义仍然明确。

当前 Projection 按请求直接读取 Canonical Repository，不提供无实际物化行为的 Runtime 注册项。`ProjectionService` 只在未来确实存在可重建、可失效的物化读模型时进入 Cordis Context。

## 20. Protocol 边界

`@agent-lens/protocol` 负责公共 DTO。

Surface / Web 应消费 Protocol DTO，而不是 Core Domain Model。

这样 Storage / Domain 重构时，不会意外变成 Browser API Breaking Change。

## 21. Runtime Event Bridge

Core Event Name 包括：

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

Cordis 负责把这些 Event 适配给 Runtime Consumer。

只有 Canonical Observation 新建或新增 Evidence 时才发送 `observation/committed`；`unchanged` 重放不产生实时更新噪声。

## 22. Contract 变更规则

如果现有 Contract 能够诚实表达一个新 Source 的数据，那么新增 Source 属于普通 Feature Work。

如果实现必须修改以下任意内容，就需要 Contract Review：

- Canonical Identity 语义；
- Observation Kind 含义；
- Evidence 语义；
- Source Lifecycle Contract；
- Plugin Runtime 所有权；
- Transaction / Dedup 保证；
- Public Protocol 语义。

不要为了更快接入某一个 Adapter，就给 Contract 增加 Source 专用逃生口。

## 23. 兼容性规则

1.0 不承诺兼容 0.x Adapter Runtime 或持久化表。

任何 Legacy Migration 都必须是一次性导入到 1.0 Contract，而不是无限期保留 0.x Runtime Model。
