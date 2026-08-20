# ADR-0001：AgentLens 1.0 Clean Rebuild 与 Cordis Runtime 所有权

- 状态：Accepted
- 日期：2026-08-20
- 范围：AgentLens 1.0

## 背景

AgentLens 0.x 已经验证了多个产品方向：多来源本地观测、任务回放、Hook 采集、History Import、Asset Discovery，以及浏览器 UI。

与此同时，0.x 也积累了大量与早期实现强绑定的架构：Adapter / Importer Class、面向展示设计的 SQLite 表、自定义 Server Lifecycle、Hook 安装逻辑，以及由 UI 反向塑造的数据结构。

在 1.0 设计过程中，我们同时研究了 DeepSeek Harness（DSH）、Cordis 与 Alibaba LoongSuite Pilot 作为架构参考。核心问题是：AgentLens 应继续演进 0.x Runtime，还是基于 DSH 构建，或围绕更小、更稳定的 Contract 重建，并让 Cordis 承担 Runtime 基础设施职责。

## 决策

### 1. AgentLens 1.0 采用 Clean Rebuild

0.x 是参考材料，不是 Compatibility Runtime。

允许复用：

- 解析算法；
- fixture / test；
- 已验证的产品行为；
- UI 思路；
- 一次性迁移 / 导入规则。

不允许：

- 在新 Facade 后面继续包装旧 Adapter / Importer Class；
- 继续把旧 timeline / overview 表当作 Canonical Model；
- 长期保留双 Schema；
- 引入 `LegacyTimelineProjection`；
- 通过 Compatibility Server 无限期保留旧 API 语义。

### 2. Cordis 是唯一的 Plugin Runtime

AgentLens 精确锁定：

```text
@deepseek-ai/cordis@4.0.1
```

所有 Cordis 耦合统一隔离在：

```text
packages/runtime-cordis
```

Core Domain、Core Services、Source、Protocol 与 Storage Contract 尽可能保持与 Cordis 无关。

AgentLens 不会在 Cordis 之外再实现第二套 Lifecycle / DI / Plugin Loader Runtime。

### 3. AgentLens 直接使用 Cordis，而不是依赖 DSH

DSH 对可替换组件、Harness Composition 等方面具有很高的架构与产品化参考价值，但 AgentLens 是一个职责不同的同级应用。

因此 AgentLens 不依赖 DSH Application / Runtime Stack。

### 4. Canonical Observation + Evidence 是核心数据模型

原生数据首先进入 `SourceRecord`。Source 将其 Normalize 为语义 Candidate 与 Evidence，`ObservationService.commit` 负责 Canonical Identity 与 Deduplication。

所有展示视图都应建立在 Canonical Data 的 Projection 之上。

### 5. Source 通过同一 Contract 独立实现

Codex、Claude Code、Pi 以及未来 Source，都必须实现相同的 `SourceDefinition` Shape。通用 History / Runtime / Asset Runner 不得按 Source Name 分支。

如果某个 Source 的特殊语义无法通过现有 Contract 诚实表达，应触发 Contract Review，而不是增加 Source 专用 Escape Hatch。

### 6. 0.x Source 不自动等于 1.0 支持列表

1.0 初始阶段只实现经过新 Contract 验证的 Source。

当前基线：

- Codex
- Claude Code
- Pi

Hermes、OpenCode、Cursor、OpenClaw 或其他 Source，未来如果重新加入，也必须通过 1.0 Source Contract 实现。

## 影响

### 正面影响

- Domain Model 不再受 0.x UI / Schema 约束。
- History 与 Runtime Capture 汇入同一条 Canonical Path。
- Evidence Provenance 成为一等公民，而不是展示元数据。
- Source Support 可以通过真正的 Contract 验证，而不是 Adapter 继承约定。
- Cordis 提供 Lifecycle / DI / Plugin Composition，同时不污染 Core。
- Web / Desktop / HTTP 可以独立演进，而不会成为 Canonical Data Owner。

### 负面影响

- 有意放弃 0.x Runtime Compatibility。
- 部分 0.x Integration 暂时不会出现在 1.0 中。
- 全新 Schema 意味着 Migration 必须显式设计，不能依赖隐式兼容。
- 初始实现成本高于简单包装现有 Adapter。

## 被拒绝的替代方案

### 继续演进 0.x Adapter Architecture

拒绝原因：这会保留 1.0 本来就是要消除的耦合，包括 Source 专用 Runtime Convention、把展示表当事实，以及自定义 Lifecycle 所有权。

### 在 DSH 之上构建 AgentLens

拒绝原因：DSH 解决的是更广泛的 Harness / Application Composition 问题。AgentLens 需要的是 Plugin Runtime 与 Domain Contract，而不是在 AgentLens 与 Source 之间再增加一层产品 Runtime。

### 一开始就 Fork / Vendor Cordis

拒绝原因：当前没有足够证据证明必须维护 Fork。依赖已经被精确锁定并隔离，Compatibility Test 可以更早暴露升级风险。

如果出现无法绕过的问题，优先级为：

1. 在 `runtime-cordis` 中增加最小 Compatibility Wrapper；
2. 必要时使用最小 `pnpm/npm patch` 风格 Patch；
3. 只有长期、明确的上游分歧得到证实后，才考虑 Fork / Vendor。

### 暂时同时保留旧、新 Schema

拒绝原因：双 Canonical Model 会让所有 Feature、Test 与 Migration 都产生歧义，并极易把临时桥接变成永久架构。

## 验证标准

以下条件满足时，可以认为本决策得到验证：

- 至少三个有明显差异的 Source 能使用同一 Contract，而 Core 不需要增加 Source 分支；
- History / Runtime Evidence 能合并到同一条 Canonical Observation；
- Projection 只消费 Canonical Repository；
- Web 只消费 Protocol DTO；
- Cordis 始终隔离在 `runtime-cordis` 后面；
- 启动 AgentLens 1.0 不需要任何 0.x Adapter / Importer / timeline Runtime。

当前 1.0 Alpha 基线通过 Codex、Claude Code 与 Pi 已经满足这些条件。
