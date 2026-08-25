# AgentLens 1.0 狗粮准备基线

> 状态：可开始长期狗粮  
> 日期：2026-08-25

本文记录 AgentLens 1.0 进入长期真实使用前的准备项。目标不是继续扩展 P1/P2 功能，而是确保多来源采集在长期运行中可解释、可诊断、可验证。

## 目标

狗粮阶段必须能够回答：

1. 哪些 Source 正在正常采集；
2. 哪个阶段失败了，最近一次成功/失败是什么时候；
3. 一个 Session / Asset 属于哪一个运行配置（Runtime Profile）；
4. 原生父子 / 恢复 / 分叉关系是否有证据，哪些只是候选；
5. 某类数据没有出现时，是“没有发生”“来源不提供”还是“AgentLens 尚未支持”；
6. 数据库、备份索引和 Hook 运行链是否健康，数据增长是否可控。

## 批次一：核心模型与来源诊断

### Runtime Profile

已落地：

- `RuntimeProfile` / `RuntimeProfileId`；
- SQLite `runtime_profiles`；
- `logical_sessions`、`source_sessions`、`asset_bindings` 增加可选 `runtime_profile_id`；
- Source Detection / Execution / Normalization Context 支持 Runtime Profile；
- History / Runtime / Asset / Checkpoint / Coverage 按 Profile 隔离；
- Canonical Observation / Asset Service 在规范写入后维护 Session / Asset 与 Profile 的关联；
- DSH Profile 不再作为独立 Installation 身份；同一安装下的 Profile 共享 Installation。

兼容原则：

- 旧数据可以没有 Runtime Profile；
- 非 Profile Source 行为不变；
- 不通过 Source ID 分支修改 Core Contract。

### Session Relationship Candidate

已落地：

- `SessionRelationshipCandidate`；
- `NormalizedSourceOutput.sessionRelationshipHints` 使用正式类型；
- SQLite `session_relationship_candidates`；
- 原生 `nativeParentSessionId` 可以保守生成 `related / parent` 候选；
- 只有父子双方都已解析到 Logical Session 后才晋升正式 `SessionRelationship`；
- 父会话晚于子会话出现时，会在相关 Session 生命周期事件上重试晋升。

约束：

- 父会话不等于子智能体；
- 缺乏证据时不得自动标记为 `fork / resume / subagent`；
- Source 能提供更精确关系时，以显式 Candidate 为准。

### Source Runtime Status

已落地：

- SQLite `source_runtime_status`；
- History / Runtime / Assets 三个阶段分别记录状态；
- `running / healthy / failed`；
- 最近开始、成功、失败时间；
- 最近错误摘要；
- 错误次数跨运行累计；
- 恢复健康不会抹掉最近错误；
- `/api/v1/health` 的 `storage.details.sourceRuntime` 暴露当前诊断摘要。

### 默认来源启用

正式 Runtime 默认允许当前一方 Source：

- Codex
- Claude Code
- Pi
- Hermes
- OpenCode
- DSH（DeepSeek Harness）

实际采集仍要求 Source 在本机被检测到。`AGENT_LENS_ENABLED_SOURCES` 一旦显式配置，继续严格使用用户指定 allowlist。

Prompt / Tool / Config / Environment 的隐私策略保持独立，默认仍按脱敏 / 关闭策略保护内容。

## 批次二：狗粮诊断闭环

已落地：

1. Unknown Observation 按 Source / native type 聚合，并通过 `/api/v1/health` 暴露“待适配原生事件”统计；
2. Coverage 进入健康诊断，保留完整 / 部分 / 来源不可用 / 未知状态、时间窗口与原因；
3. 顶部运行状态显示来源异常、待适配事件与 Coverage 摘要；
4. 智能体概览增加“采集诊断”面板，按来源展示运行阶段、未知事件与能力覆盖语义；
5. UI 明确区分：
   - 当前没有发生：采集链路健康、能力可用，但当前没有形成对应覆盖记录；
   - 来源不提供：来源明确声明能力不可用或不适用；
   - AgentLens 尚未支持：已经捕获原生事件，但当前尚未完成规范适配；
   - 尚未确认：当前证据不足，不把缺失数据误判为 0；
6. 隐私端到端回归覆盖：
   - DSH `request/header`；
   - MCP 配置；
   - 环境变量；
   - API Key / Token；
   - Raw Payload / Canonical Payload。

后续只根据真实狗粮数据校准 Coverage 语义和 Unknown 分组，不再为此扩新的诊断页面。

## 批次三：长期运行

已落地：

1. `/api/v1/health` 暴露 SQLite 主库、WAL 和逻辑页大小；
2. 统计 SourceRecord / Observation / Evidence / Session 当前总量；
3. 统计最近 7 天上述核心数据的新增量，用于观察真实增长趋势；
4. 暴露 Source Checkpoint 数量和最近更新时间；
5. 智能体概览“采集诊断”面板展示数据规模、7 天增量和 Checkpoint 健康；
6. 诊断 UI 保持正式设计约束：无毛玻璃，正常文字不低于 12px；
7. 资产备份页继续以 `backup-local` 的真实索引状态展示“索引就绪 / 后台更新中”、最近索引时间、Vault 路径和快照数量，不复制第二套备份健康模型；
8. 最近 Session 按最后真实事件时间倒序，新事件会把旧会话重新带回顶部；实时 Review 事件会刷新列表，但不会强制切走用户正在查看的会话；
9. 增加最近 Session 排序回归测试，锁定长期狗粮时“刚发生的任务必须容易找到”。

### Hook 运行链边界

Hook 安装、事件完整性和 Codex 信任状态已经由 Hook Manager 与 `agent-lens doctor` 提供真实诊断。当前不在 Daemon / Storage 中复制 Hook 配置解析逻辑，也不为了一个 UI 状态引入未同步的 workspace 依赖。

因此狗粮阶段的 Hook 真相源保持：

```text
agent-lens doctor
agent-lens hook status all
```

后续在可以正常重生成 workspace lockfile 的开发环境中，再把同一份 Hook Manager 状态接入 Web 采集诊断；这属于表现层收口，不阻塞长期狗粮。

## 狗粮阶段执行原则

从现在开始，优先通过真实日常使用发现问题：

1. 发现 Source 失败，先看顶部运行状态和“采集诊断”；
2. 发现事件缺失，先判断 Coverage 和 Unknown，而不是直接认定 Source 没数据；
3. 每周观察数据库 / WAL / 7 天增长，暂不自动清理；
4. Hook 异常使用 `agent-lens doctor` / `agent-lens hook status all` 确认；
5. 备份问题优先看资产备份页的真实索引时间、Vault 和快照状态；
6. 所有真实狗粮问题再进入修复清单，不继续凭假设扩 P1/P2。

## 暂不做

狗粮准备阶段暂不扩展：

- 第三方 Agent 原始数据自动清理；
- 通用配置最终求值引擎；
- 自动删除历史 Observation / Evidence；
- 与当前狗粮诊断无关的 P1/P2 分析能力。

数据清理、保留策略和自动维护必须先基于真实狗粮增长数据再决策。
