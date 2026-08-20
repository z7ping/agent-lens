# ADR-0001：AgentLens 1.0 Clean Rebuild 与 Cordis Runtime 所有权

- 状态：Accepted
- 日期：2026-08-20
- 更新：2026-08-21
- 范围：AgentLens 1.0

## 背景

AgentLens 0.x 已经验证了多个产品方向：多来源本地观测、任务回放、Hook 采集、History Import、Asset Discovery，以及浏览器 UI。

与此同时，0.x 也积累了大量与早期实现强绑定的架构：Adapter / Importer Class、面向展示设计的 SQLite 表、自定义 Server Lifecycle、Hook 安装逻辑，以及由 UI 反向塑造的数据结构。

在 1.0 设计过程中，我们同时研究了 DeepSeek Harness（DSH）、Cordis 与 Alibaba LoongSuite Pilot 作为架构参考。核心问题是：AgentLens 应继续演进 0.x Runtime，还是基于 DSH 构建，或围绕更小、更稳定的 Contract 重建，并让 Cordis 承担 Runtime 基础设施职责。

在实现后期又进一步明确了一个边界问题：Cordis 应只是藏在 `runtime-cordis` 后面的实现细节，还是 AgentLens 1.0 正式的运行时 / 插件模型。

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

### 2. Cordis 是唯一的 Plugin Runtime，并且 Runtime Extension 采用 Cordis-native

AgentLens 精确锁定：

```text
@deepseek-ai/cordis@4.0.1
```

AgentLens 1.0 把 Cordis 视为正式运行时模型，而不是可替换的隐藏实现。

运行时扩展直接作为 Cordis Plugin 参与生命周期与依赖注入，包括：

- Source Plugin；
- Storage Plugin；
- Surface Plugin；
- 未来需要运行时生命周期的 Analyzer / Exporter 等扩展。

不再为这些类别额外维护 `defineSourcePlugin()`、`defineStoragePlugin()`、`defineSurfacePlugin()` 之类的通用适配层。

AgentLens 不会在 Cordis 之外再实现第二套 Lifecycle / DI / Plugin Loader Runtime。

### 3. Core 保持框架无关，但不是所有 Package 都必须与 Cordis 隔离

必须保持 Cordis-independent：

- Core Domain；
- Canonical Observation / Evidence / Identity 等模型；
- Repository Contract；
- Parser / Normalizer 等可纯化算法；
- Protocol DTO。

允许直接依赖 Cordis Runtime 边界：

- `packages/source-*` 的插件入口；
- `packages/storage-*` 的插件入口；
- `packages/surface-*` 的插件入口；
- `packages/runtime-cordis` 中的 Context Service typing、Application 与 Compatibility Test。

推荐结构：

```text
source-codex/
  parser / history / normalize / assets   # 纯 TypeScript / Core Contract
  plugin entry                            # Cordis-native
```

原则是：

> AgentLens Core is framework-agnostic; AgentLens runtime extensions are Cordis-native.

Cordis 决定组件如何运行；AgentLens Core Contract 决定组件能表达什么事实。

### 4. AgentLens 直接使用 Cordis，而不是依赖 DSH

DSH 对可替换组件、Harness Composition 与 Cordis-native Plugin Tree 具有很高的架构与产品化参考价值，但 AgentLens 是职责不同的同级应用。

因此 AgentLens 学习 DSH 的 Cordis 使用方式，但不依赖 DSH Application / Runtime Stack。

### 5. Canonical Observation + Evidence 是核心数据模型

原生数据首先进入 `SourceRecord`。Source 将其 Normalize 为语义 Candidate 与 Evidence，`ObservationService.commit` 负责 Canonical Identity 与 Deduplication。

所有展示视图都应建立在 Canonical Data 的 Projection 之上。

Cordis-native 不代表 Source 可以绕过这条 Pipeline。Source Plugin 的职责是注册 / 启动 Source 能力，不得直接绕过 Contract 写 Canonical Repository 或展示表。

### 6. Source 通过同一 Contract 独立实现

Codex、Claude Code、Pi 以及未来 Source，都必须实现相同的 `SourceDefinition` Shape。通用 History / Runtime / Asset Runner 不得按 Source Name 分支。

Source package 的插件入口可以直接使用 Cordis `ctx` / `inject`，但 Parser、Normalizer 与 SourceDefinition 仍应保持可独立测试。

如果某个 Source 的特殊语义无法通过现有 Contract 诚实表达，应触发 Contract Review，而不是增加 Source 专用 Escape Hatch。

### 7. 0.x Source 不自动等于 1.0 支持列表

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
- Cordis 原生承担 Lifecycle / DI / Plugin Composition，不再额外包一层 AgentLens Runtime Adapter。
- Parser / Normalizer / Domain 仍可脱离 Cordis 独立测试。
- 第三方运行时扩展的心智模型更直接：AgentLens 是一个 Cordis Application。

### 负面影响

- Source / Storage / Surface 的插件入口会显式依赖 Cordis Runtime typing。
- Cordis 大版本升级可能影响多个运行时插件入口，而不只影响 `runtime-cordis`。
- 必须通过编码规则防止 Cordis Context 成为绕过 Canonical Pipeline 的 Escape Hatch。
- 有意放弃 0.x Runtime Compatibility。

## 被拒绝的替代方案

### 继续演进 0.x Adapter Architecture

拒绝原因：这会保留 1.0 本来就是要消除的耦合，包括 Source 专用 Runtime Convention、把展示表当事实，以及自定义 Lifecycle 所有权。

### 在 Cordis 前再维护一套通用 AgentLens Runtime Adapter

典型形式：

```text
SourceDefinition -> defineSourcePlugin() -> Cordis Plugin
StorageFactory   -> defineStoragePlugin() -> Cordis Plugin
SurfaceFactory   -> defineSurfacePlugin() -> Cordis Plugin
```

拒绝原因：在 Cordis 已经被确定为唯一正式 Plugin Runtime 的前提下，这层抽象没有当前多 Runtime 需求支撑，并容易继续扩张为第二套 Plugin API / 生命周期模型。

允许保留非常薄的 metadata / compatibility helper，例如 Plugin API Version 校验，但这些 helper 不得重新抽象 Cordis 的 Lifecycle、DI、Service 与 Plugin 类别。

### 所有代码都 Cordis 化

拒绝原因：Observation、Evidence、Identity、Parser、Normalizer、Repository Contract 等是 AgentLens 自身长期稳定的领域资产，不应该被某个 Runtime Framework 的 Context / Fiber / Plugin 类型塑造。

### 在 DSH 之上构建 AgentLens

拒绝原因：DSH 解决的是更广泛的 Harness / Application Composition 问题。AgentLens 借鉴其 Cordis-native 架构，但不需要 DSH Runtime 本身。

### 一开始就 Fork / Vendor Cordis

拒绝原因：当前没有足够证据证明必须维护 Fork。依赖已经被精确锁定，Compatibility Test 可以更早暴露升级风险。

如果出现无法绕过的问题，优先级为：

1. 增加最小 Compatibility Wrapper；
2. 必要时使用最小 `pnpm/npm patch` 风格 Patch；
3. 只有长期、明确的上游分歧得到证实后，才考虑 Fork / Vendor。

### 暂时同时保留旧、新 Schema

拒绝原因：双 Canonical Model 会让所有 Feature、Test 与 Migration 都产生歧义，并极易把临时桥接变成永久架构。

## 验证标准

以下条件满足时，可以认为本决策得到验证：

- 至少三个有明显差异的 Source 使用同一 `SourceDefinition` Contract，而 Core 不增加 Source 分支；
- Source / Storage / Surface 的运行时入口直接是 Cordis Plugin；
- 不存在 `defineSourcePlugin / defineStoragePlugin / defineSurfacePlugin` 这一类通用 Runtime Adapter；
- Parser / Normalizer / Domain / Repository Contract 不依赖 Cordis；
- History / Runtime Evidence 能合并到同一条 Canonical Observation；
- Projection 只消费 Canonical Repository；
- Web 只消费 Protocol DTO；
- 启动 AgentLens 1.0 不需要任何 0.x Adapter / Importer / timeline Runtime。
