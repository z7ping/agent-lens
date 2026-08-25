# ADR-0005：运行配置、会话关系与资产拓扑模型补强

状态：Accepted  
日期：2026-08-25  
范围：AgentLens 1.0 Core Contract / Identity / Asset

## 背景

ADR-0001 已经明确：当新的 Source 语义无法被现有 Core Contract 诚实表达时，应触发 Contract Review，而不是增加 Source 专用逃生口。

DeepSeek Harness（DSH）接入后，现有 Observation + Evidence 主干继续能够稳定承载用户消息、智能体消息、Turn、Step、Tool、Usage、Request Header、Workspace 等事实，但也暴露出三类通用模型缺口：

1. `AgentInstallation` 目前同时承担“软件安装”和“运行配置实例”的语义，无法自然表达同一安装下多个 Profile / Account / Environment；
2. Core 已有 `SessionRelationship`，但 Source 只能通过 `nativeParentSessionId` 暂存父会话事实，缺少标准 Relationship Candidate → Canonical Relationship 的写入链；
3. Asset 当前只有 Definition / Binding / State，能够表达“装了什么、在哪里、什么状态”，但不能表达 Bundle、Plugin、Profile Patch 等之间的组合、包含、覆盖关系。

DSH 只是触发这次审查的来源，不是本 ADR 的特殊目标。相同问题也可能出现在多账户 Codex / Claude Code、不同配置目录、插件组合、工作区分支和其他 Agent Harness 中。

## 决策

### 1. Observation + Evidence 主干保持不变

本次不推翻 1.0 的 Canonical Observation + Evidence 模型。

以下链路继续保持：

```text
Native Source
  -> SourceRecord
  -> normalize()
  -> ObservationCandidate + EvidenceCandidate
  -> Identity / Relationship Resolution
  -> Canonical Observation + Evidence
```

本次补强只发生在 Identity / Relationship / Asset Topology，不引入第二套事实模型。

### 2. 增加运行配置实体 RuntimeProfile

在 `AgentInstallation` 与 Session / Asset Binding 之间增加正式的运行配置层：

```text
Host
  -> AgentProduct
    -> AgentInstallation
      -> RuntimeProfile
        -> LogicalSession / SourceSession
        -> AssetBinding
```

`RuntimeProfile` 表达“同一软件安装下的一套独立运行配置”。它不是新的软件安装，也不是 Workspace。

建议字段：

```text
RuntimeProfile
- id
- installationId
- sourceId
- nativeProfileId?
- name?
- configRoot?
- dataRoot?
- firstSeenAt
- lastSeenAt
```

原则：

- 没有 Profile 概念的 Source 可以使用默认 RuntimeProfile；
- Source 不得仅因为配置目录不同就伪造新的 AgentInstallation；
- Workspace 继续表达代码 / 项目工作目录，不承担 Profile 语义；
- RuntimeProfile 不等于发行 / 运维层的 daemon runtime owner，不能与 ADR-0004 的 `cli / service / desktop` 生命周期所有权混淆。

DSH 的 Profile 应映射为 RuntimeProfile，而不是长期映射成多份 AgentInstallation。

### 3. 会话关系必须进入标准 Candidate 写入链

现有 `SessionRelationship` 保留，并补齐标准候选模型和持久化路径。

建议新增：

```text
SessionRelationshipCandidate
- fromNativeSessionId
- toNativeSessionId
- type
- nativeParentEventId?
- nativeParentSequence?
- confidenceHint?
- evidenceCandidates[]
```

关系类型保留现有：

```text
resume
continuation
fork
subagent
import-copy
related
```

同时允许候选阶段存在保守的“仅父子事实 / 未判定具体类型”状态；实现不应为了匹配枚举而把所有 `parentSessionId` 强行解释为 `subagent` 或 `fork`。

Canonical `SessionRelationship` 必须继续绑定 Evidence 和 Confidence。

DSH 的 `parentSessionId + parentEventSeq`、Pi 的原生 parent/session tree 等，都应通过同一关系链路写入。

### 4. `nativeParentSessionId` 继续保留，但降为原生身份事实

`SourceSession.nativeParentSessionId` 继续允许存在，作用是保留 Source 原生血统并帮助关系解析。

但 UI / Projection 不应长期只依赖该字段表达关系。

目标语义：

```text
nativeParentSessionId   = Source 原生事实
SessionRelationship     = AgentLens 规范关系事实
```

当 Source 只能证明“有父会话”但不能证明关系类型时，规范层应保守表达，而不是丢失血统或过度推断。

### 5. `NormalizedSourceOutput.sessionRelationshipHints` 从占位 unknown[] 升级为强类型

当前 `NormalizedSourceOutput` 已经预留 `sessionRelationshipHints?: unknown[]`，但尚未建立正式类型和 commit 路径。

本 ADR 要求把它升级为明确的 `SessionRelationshipCandidate[]`，并由 Core Service 统一解析 / 幂等写入。

Source 不得直接写 `session_relationships` 表。

### 6. 增加资产关系 AssetRelationship

现有 AssetDefinition / AssetBinding / AssetStateObservation 保持不变，在其上增加关系事实：

```text
AssetRelationship
- id
- fromAssetId / fromBindingId
- toAssetId / toBindingId
- type
- evidenceRefs[]
- confidence
```

第一阶段建议关系类型保持小而稳定：

```text
contains
includes
configures
overrides
extends
provides
related
```

目标是能诚实表达：

```text
Profile
  -> includes Bundle
Bundle
  -> contains Plugin
Profile Patch
  -> overrides Bundle Config
Plugin
  -> provides Tool / Capability
```

资产关系描述“能力如何组合”，Asset Usage 仍描述“哪些能力真实被调用”。两者不得混为一谈。

### 7. Bundle 不再长期伪装成普通 Plugin

当前 DSH 首版为了复用既有 Asset Contract，把 Bundle 暂时映射成 `plugin`。该实现允许作为迁移过渡，但不能成为最终语义。

后续 Core Contract 应能够表达 Bundle / Composition Unit，具体方式优先考虑扩展 AssetType，而不是引入 DSH 专用 Asset 类型。

如果其他 Source 也存在 Pack / Bundle / Extension Pack 等组合单元，应复用相同语义。

### 8. AssetBinding 应能关联 RuntimeProfile

当前 `AssetBinding` 只绑定 `installationId`。补入 RuntimeProfile 后，应允许：

```text
AssetBinding
- installationId
- runtimeProfileId?
```

这样可以区分：

- 软件全局安装的 Skill / Plugin；
- 某个 Profile 独有的 Bundle / Plugin；
- 某套运行配置独有的 Rule / Patch。

没有 Profile 语义的 Source 仍可只绑定 Installation。

### 9. 配置层级模型先记录，不在第一批实现中展开

DSH 还暴露出配置优先级问题，例如：

```text
Bundle Patch
-> Profile Patch
-> Home Patch
-> CLI --patch
```

长期可以引入 `ConfigurationLayer / priority / overrides / effective` 一类模型，但本轮不作为 1.0 第一批实现目标。

第一批只通过 AssetRelationship 的 `configures / overrides` 保留能够被 Source 明确证明的关系，不构建通用配置求值引擎。

### 10. Capture Channel 暂不扩 Core

DSH 的 `history / native-tail`、Codex / Claude 的 `history / runtime-hook / durable-inbox` 暴露了采集通道更细粒度建模的需求。

当前继续使用：

- Evidence.captureMethod；
- Source capability captureModes；
- SourceRecord / Evidence 中的来源定位；

暂不为“传输路径 / watcher / polling / inbox”增加新的 Canonical Entity。

除非未来诊断、延迟分析或多通道去重无法诚实表达，再单独发起 Contract Review。

## 第一阶段实施顺序

本 ADR 接受后，按以下顺序落地：

1. Core 增加 `RuntimeProfileId / RuntimeProfile / RuntimeProfileIdentityHint`；
2. Storage 增加 `runtime_profiles`，现有 Source 默认迁移到默认 Profile；
3. LogicalSession / SourceSession / AssetBinding 增加可选 `runtimeProfileId`；
4. `DetectedSource` / Source Runner 支持 Source 返回原生 Profile 身份，而不是通过多 Installation 代替；
5. `SessionRelationshipCandidate` 强类型化，并接入 Observation commit 事务；
6. DSH / Pi 迁移到正式 Relationship Candidate；
7. 增加 `AssetRelationship`、Repository 与 Asset Service 写入链；
8. DSH Bundle / Plugin / Profile Patch 从平铺清单升级为资产拓扑；
9. Projection / Protocol 按需暴露 Profile、关系与资产拓扑，不要求所有页面立即展示。

### 兼容原则

- 现有 1.0 数据允许通过 SQLite migration 就地升级，不建立第二套数据库；
- 没有 Profile 语义的旧数据统一关联默认 RuntimeProfile；
- `nativeParentSessionId` 不删除，避免迁移过程中丢失原生事实；
- Protocol 新字段优先采用向后兼容的可选字段；
- 不因为新增关系模型改变 Canonical Observation 的现有 ID / Dedup 语义。

## 被拒绝的方案

### 每个 DSH Profile 都算一份 AgentInstallation

拒绝。Profile 是运行配置，不是软件安装。继续这样做会污染安装统计、资产归属和后续多账户 / 多环境模型。

### 只把 parentSessionId 留在 payload

拒绝。这样关系只能由 DSH 专用 UI / Projection 解析，违背统一 Core Contract。

### parentSessionId 一律映射为 subagent

拒绝。父会话只能证明血统，不一定能证明子智能体语义。

### Bundle 永久作为 Plugin 展示

拒绝。Bundle 是组合单元，长期扁平化会丢失“能力如何装配”的关键事实。

### 为 DSH 增加 Source 专用 Core 字段

拒绝。新实体和关系必须能被其他具有相同语义的 Source 复用。

### 现在直接建立通用配置求值引擎

拒绝。当前证据只支持先补关系事实，完整配置求值属于更大的后续问题。

## 影响

### 正面

- 同一安装下多个 Profile / Account / Environment 可以被诚实表达；
- Session Tree 不再依赖 Source 专用 payload 或字符串约定；
- 父子、恢复、分叉、子智能体等关系继续保持证据与置信度；
- Bundle / Plugin / Rule / Patch 从平铺清单升级为可解释的能力装配图；
- DSH、Pi 以及未来多配置 Agent 可以复用同一 Contract；
- 保持 ADR-0001 的原则：特殊 Source 推动通用 Contract Review，而不是产生逃生口。

### 代价

- IdentityService、Storage Schema、Source Runner、Asset Service 与 Protocol 都需要一次有计划的迁移；
- Existing Installation-centric 查询需要增加默认 Profile 兼容层；
- Asset 拓扑会增加 Projection 与 UI 的表达复杂度；
- 关系候选的幂等与 Evidence 合并需要新增测试。

## 验证标准

本决策完成第一阶段落地后，应满足：

- DSH 多 Profile 不再制造多份软件安装语义；
- Codex / Claude / Pi / Hermes / OpenCode 在没有原生 Profile 时仍能通过默认 RuntimeProfile 工作；
- DSH / Pi 的原生父会话事实可以通过统一 Candidate 生成 `SessionRelationship`；
- 没有足够证据时不会错误标记为 `subagent` / `fork`；
- Bundle / Plugin / Profile Patch 可以通过通用 AssetRelationship 表达；
- Source Runner、Storage 和 Projection 中不出现 `if sourceId === 'dsh'` 的 Core 特判；
- 新实体仍完全遵循 Repository / Service / Projection / Protocol 边界。

## 与其他 ADR 的关系

- 延续 ADR-0001：Clean Rebuild、统一 Source Contract、Contract Review 而非 Source 专用逃生口；
- 不改变 ADR-0002：Web 继续只消费 Projection / Protocol；
- 不改变 ADR-0003：备份索引仍是 Vault 运维数据，不因为 RuntimeProfile / AssetRelationship 进入 Canonical Observation；
- 不改变 ADR-0004：RuntimeProfile 是第三方 Agent 的运行配置实体，与 AgentLens Daemon 的 cli / service / desktop 生命周期所有权无关。
