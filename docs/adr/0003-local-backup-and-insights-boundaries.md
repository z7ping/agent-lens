# ADR-0003：本地资产备份与使用洞察边界

状态：Accepted  
日期：2026-08-22

## 背景

AgentLens 已经能通过 Source 静态发现 Skill、MCP、Plugin、Extension、Hook、Memory、Rule 等资产，并通过 `dataRoot` 与历史采集保留各 Agent 的原始 Session 来源位置。长期产品方向还要求两类能力：

1. 把用户自己的 AI 资产可靠保存、导出、导入和恢复；
2. 基于真实使用事实形成趋势、模式和洞察。

如果直接为这两类能力新增第二套 Source Adapter、第二套事实表或独立插件生命周期，会破坏 1.0 已经确定的 Cordis Runtime 与 Canonical Observation / Evidence 边界。

## 决策

### 1. 资产备份是运维资产，不是新的观测事实

本地快照存放在独立 Vault 中，默认路径为：

```text
~/.agent-lens/1.0/vault
```

快照文件、Manifest（清单）和 Hash（哈希）不写入 Canonical Observation、Evidence、Asset State 等事实表。

SQLite 仍然只承担 AgentLens 的规范事实与索引数据；Vault 承担用户原始 AI 资产的不可变快照。

### 2. 第一阶段不扩 Source Contract

第一阶段直接复用现有 Source 契约：

- `DetectedSource.dataRoot`：作为原始 Session / History 的保护根目录；
- `SourceDefinition.discoverAssets()`：由各 Source 自己指出可识别的 Skill、MCP、Plugin、Extension、Hook、Memory、Rule 等资产绑定路径。

因此备份服务不写 `if sourceId === 'codex'` 之类的来源特判，也不新增第二套 Source Adapter。

如果未来确实存在“需要备份但既不是 dataRoot、也无法通过 discoverAssets 表达”的原始资产，再单独发起 Source Contract Review，而不是提前扩接口。

### 3. 本地备份服务是 Cordis 原生运行时服务

`@agent-lens/backup-local` 作为 first-party Cordis runtime composition plugin 提供 `BackupService`。

它不引入新的 DI、Plugin Loader 或生命周期模型；生命周期仍由 Cordis 管理。

### 4. 快照格式以原始文件为主

每个文件记录：

- Source / Product / Installation；
- 来源范围（config / data）；
- 相对来源路径；
- 原始路径（仅用于诊断展示）；
- 资产类型；
- 文件大小；
- SHA-256。

Manifest 自身再计算 SHA-256。导出包导入时必须同时验证 Manifest 与每个文件的 Hash。

Canonical Observation / Projection 可以辅助索引，但不能成为原始 Session 的唯一备份内容。

### 5. 默认拒绝保存可识别的秘密

第一阶段没有“关闭敏感信息保护”的入口。

备份服务会排除：

- 明确的凭据 / Token / Auth / 私钥文件名；
- 高置信度的私钥、Bearer Token、常见 API Token 内容；
- 配置类文件中可识别的 secret / token / api key / password 等赋值。

Manifest 只记录排除原因与原路径，不记录秘密原值。

这是保守策略：宁可少备份一个混合配置文件，也不默认把凭据打进可携带备份包。

### 6. 导入不等于恢复，恢复先做预演

导入只把经过校验的快照放入本地 Vault，不直接修改 Agent 文件。

恢复目标根据“当前机器重新检测出的 Source 根目录 + 快照中的相对路径”计算，不信任导入包里的绝对 `originalPath`。

第一阶段先提供恢复预演，标记：

- unchanged：当前文件与快照一致；
- missing：当前缺失；
- modified：当前存在但内容不同；
- blocked：目标不安全、Source 未检测到、符号链接等原因阻止恢复。

真正写回恢复必须在预演与冲突策略稳定后再开放。

### 7. 跨 Agent 迁移与备份分离

备份追求“原样、安全、可验证”。

跨 Agent 迁移需要语义映射、格式转换、兼容检查和人工确认，不属于第一阶段备份实现，也不能修改快照原始内容。

### 8. 使用洞察只做可重建 Projection

使用洞察必须从现有 Canonical Observation、Evidence、Asset Usage、Session 等事实计算，不创建新的事实来源。

允许：

- 时间趋势；
- Agent 使用结构对比；
- 已发现资产与真实使用资产差异；
- 基于明确规则和最小样本量的工具序列模式；
- 工作方式随时间的可验证变化。

第一阶段的模式识别采用确定性规则，而不是模型解释：

- 将原生工具名按固定规则归类为读取文件、修改文件、搜索定位、命令执行、网络访问、Skill 调用、具体 MCP 等类别；
- 同一会话内连续相同类别先折叠，再统计长度为 2 或 3 的连续类别序列；
- 只有同一序列至少出现在 **5 个不同会话** 中才进入正式洞察；
- 每个模式保留样本 Session ID 与 Observation ID；
- 模式只表达“重复共同出现”，不表达因果关系、效率高低或最佳实践。

周期比较只在当前会话样本完整时生成。当前优化读取器一次最多安全读取最近 500 个会话；超过该上限时必须显式标记 `sampled`，关闭上一周期百分比比较，并在界面说明哪些统计基于最近样本。不得使用可能不完整的上一周期数据制造增长/下降结论。

禁止：

- Agent 综合评分；
- “最佳 Agent”排名；
- 把会话时长直接解释为效率；
- 把错误率直接解释为 Agent 能力；
- 无 Evidence / 样本范围的模型主观结论。

### 9. “明确失败”与“失败率”分开

当前 Session Summary 能可靠提供的是 `tool.result.success === false` 的明确失败数量，并不能证明每一次工具调用都有可判定结果。

因此第一阶段界面展示“明确失败”数量，不使用“明确失败数 / 全部工具调用数”包装成已知失败率。未来若要展示失败率，必须先拥有明确的“可判定结果数”分母，并在协议中公开该统计口径。

## 后果

### 正面

- 复用现有 Source 资产发现能力，不复制 Agent 私有目录知识；
- 备份与观测事实彻底分离，避免事实层被运维状态污染；
- 导入包不能通过绝对路径任意写文件；
- 洞察天然可以重建，不需要第二套持久化事实模型；
- 未来增加 Source 时，只要原有 `dataRoot + discoverAssets` 足够表达，就自动具备第一阶段备份能力；
- 模式统计与周期比较都有明确样本门槛和失效条件，不把数据缺口包装成结论。

### 代价

- 第一阶段无法覆盖 Source 尚未通过 `discoverAssets` 暴露、又不在 `dataRoot` 内的特殊文件；
- 保守敏感信息策略可能排除含凭据的混合配置文件；
- 当前只开放恢复预演，不直接写回；
- 大型 Session 导出仍是本地文件型实现，暂不解决云同步与增量快照；
- 超过 500 个会话时部分洞察以最近样本为准，周期比较主动关闭；
- 规则型工作流模式不会尝试解释“为什么有效”，只保留可验证重复结构。

## 明确不在本 ADR 范围

- 云同步 / WebDAV / NAS / Git 同步；
- 增量快照；
- 凭据加密托管；
- 跨设备自动迁移；
- 跨 Agent Skill / MCP / Session 语义转换；
- AI 自动生成主观推荐或 Agent 评分。
