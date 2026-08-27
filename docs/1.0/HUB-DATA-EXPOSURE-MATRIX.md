# AgentLens 1.0 Hub 数据暴露矩阵

更新日期：2026-08-27  
状态：Alpha 隐私设计冻结，尚未实现  
相关文档：
- `docs/1.0/CAPTURE-POLICY.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-STATE-CONTRACT.md`
- `docs/1.0/HUB-REPLICA-STORAGE-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-PROTOCOL.md`
- `docs/1.0/HUB-PAIRING-SECURITY.md`

本文定义 `metadata-only / redacted / full` 三档 Replication Policy 的字段级暴露边界，并定义 `from-now` Dependency Closure 的最小化规则。

## 1. 总原则

```text
Capture Policy
  -> 本机最多拥有什么

Replication Policy
  -> 本机已有信息中什么允许离开本机

History Scope
  -> Boundary 前已有历史是否允许补传
```

Replication 不能恢复 Capture 已删除 / 未采集的内容，也不能通过 Dependency Closure 绕过 History Boundary。

无论哪档：

- Token / API Key / Password / Authorization / Cookie 等明确凭据禁止出站；
- Pairing Secret、Node / Hub Private Key、TLS Private Key 永不属于 Replication Data；
- Runtime diagnostics / retry internals 不进入 Canonical Replication Batch；
- Hub 汇聚数据按“多设备敏感信息集合”处理。

## 2. 字段敏感度

### A. 结构身份

```text
node / entity identity
sourceId
productId
entity type
session / observation / evidence refs
tool canonical name
kind / status / timing / duration
```

通常是 Hub 形成可解释图所必需。

### B. Portable Identity

```text
normalized repository identity
portable asset upstream identity
identity algorithm version
```

用于 Shared Group，但可能泄露私有 Git Host、Organization、Repository 或资产包名。

因此 metadata-only 仍可能发送，UI 必须明确披露。

### C. 本机路径 / 环境

```text
Workspace.path
AgentInstallation.executable
configRoot / dataRoot
AssetBinding.path
SourceLocator.path
```

可能泄露用户名、客户名、项目名和目录结构。

### D. 业务正文

```text
Prompt
Assistant message
来源可观察的 Reasoning fragment
Tool input / output
SourceRecord payload
Context summary
Artifact content fragments
```

### E. 运维 / 安全状态

```text
private keys
pair secret
nonce cache
raw signature
replication retry internals
```

不属于 Canonical Replication Data。

## 3. Alpha Policy 矩阵

| 数据 | metadata-only | redacted | full |
| --- | --- | --- | --- |
| Node / Entity identity / Typed Ref | 发送 | 发送 | 发送 |
| Agent Product / Source / Kind | 发送 | 发送 | 发送 |
| 时间、状态、耗时、序列 | 发送 | 发送 | 发送 |
| Tool canonicalName / sourceType | 发送 | 发送 | 发送 |
| Shared Project Repository Identity | 发送规范化且去凭据身份 | 同左 | 同左 |
| Portable Asset Identity | 发送规范化身份 | 同左 | 同左 |
| Workspace 完整本机路径 | 默认 omitted(policy) | 脱敏 / 归一化后按必要性发送 | 允许发送本机已保存普通路径 |
| executable / configRoot / dataRoot | omitted(policy) | 脱敏后按必要性发送 | 允许按必要性发送 |
| AssetBinding.path | 默认 omitted(policy) | 脱敏后发送 | 允许发送 |
| SourceLocator.kind | 发送 | 发送 | 发送 |
| SourceLocator.path | omitted(policy) | 脱敏后按必要性发送 | 允许发送 |
| Prompt / Message 正文 | omitted(policy) | 脱敏后发送 | 发送本机已允许正文 |
| Tool input / output 正文 | omitted(policy) | 脱敏后发送 | 发送本机已允许正文 |
| SourceRecord.payload | omitted(policy) | 脱敏 / 限长后发送 | 发送本机已允许 payload |
| Evidence 文本 / parser detail | 最小结构，敏感文本清洗 | 清洗后发送 | 普通文本可发送，凭据仍遮蔽 |
| Runtime Diagnostics / Retry Stack | 不进 Canonical Batch | 不进 Canonical Batch | 不进 Canonical Batch |
| Private Key / Pair Secret / Raw Signature | 永不发送 | 永不发送 | 永不发送 |

## 4. Availability 是正式数据语义

Wire / Remote Replica 必须区分：

```text
value
redacted
omitted(policy)
omitted(not-captured)
omitted(history-boundary)
omitted(dependency-minimized)
real null
```

真实 null 必须表达成 `value(null)`，不能与 omitted 混用。

Remote Replica Storage 不得用：

```text
''
{}
[hidden]
null
```

作为“没有获得这个字段”的假 Canonical 值。

## 5. metadata-only 不是匿名模式

它的目标是：

> 不上传 Prompt / Tool 等业务正文和不必要本机路径，同时保留 Session、Agent、Tool、Usage、Project 聚合能力。

它仍可能暴露：

- Repository / Project identity；
- Agent / Tool 使用模式；
- 时间结构；
- Session 结构；
- 私有 Git Host / Organization 名称。

UI 禁止写“不会上传敏感信息”。

## 6. Repository Identity 规范化前先去凭据

Git Remote 可能包含：

```text
https://user:token@example.com/org/repo.git
https://token@example.com/org/repo.git
```

Shared Identity Normalizer 在计算、发送和记录前必须：

- 去掉 userinfo；
- 去掉 query / fragment；
- 不让 credential 参与 SharedKey；
- 不在普通 log / diagnostics 打印原始带凭据 URL。

这是所有 Policy 的强制门禁。

## 7. Shared Identity 可验证性要求

Hub 要重算 `project-repository-v1 / asset-upstream-v1` SharedKey，因此当 Node 提交 Shared Identity Assertion 时，必须发送：

```text
identityAlgorithm
normalized portable identity
claimedSharedKey
```

Portable Identity 经过凭据清洗后，在三档 Policy 中均允许出站；否则 Hub 不允许建立“只信 sharedKey、不见 identity”的盲 Membership。

若用户未来要求完全隐藏 Repository Identity，则该 Entity 不能进入 Shared Project Group，只能保留 Node-scoped Origin；这是能力降级，不允许伪造不可验证 SharedKey。

## 8. 本机路径

### metadata-only

完整路径默认 omitted(policy)。Hub 可依靠 Workspace Replica ID + Project Group + Node 区分工作区。

### redacted

统一脱敏，例如：

```text
C:\Users\alice\code\agent-lens -> ~\code\agent-lens
/home/alice/code/agent-lens -> ~/code/agent-lens
```

脱敏必须在 Replication Serializer 完成，不由 Web 临时遮挡。

### full

可以发送 Capture Policy 已允许的普通路径；明确凭据仍强制清洗。

## 9. `from-now` Dependency Closure 字段最小化

`from-now` 允许 Boundary 后的新事实引用 Boundary 前已存在的身份实体，但不授权“顺便补一遍旧 Metadata”。

例如新 Observation 引用旧 LogicalSession：

允许：

```text
origin identity
必要 Installation / Project / Workspace refs
形成 FK 图所需最小结构字段
```

默认不允许因此补：

```text
旧 Session title
非必要 startedAt / endedAt
旧 Workspace full path
旧 Prompt / Tool body
旧 SourceRecord payload
```

这些字段使用：

```text
omitted(history-boundary)
omitted(dependency-minimized)
```

具体 Minimum Dependency Shape 按 Entity Type 在 Replication Serializer Contract 中固定并测试。

## 10. Policy 收紧与 retained prior value

`full -> metadata-only` 后，新 Batch 必须立即遵守新规则，但 Hub 之前已经保存的 full 内容不会自动删除。

Storage / Read Model 必须区分：

```text
current availability = omitted(policy)
retained prior value = 旧授权时期获得
```

旧值不能被标记成“当前 Policy 下刚重新确认”。

普通 UI 可以继续展示已同步历史，但必须在需要时能够解释其来源和 freshness；清理旧 full 内容需要独立 Purge / Delete 操作。

## 11. Policy 放宽

用户明确放宽 Policy / History Scope 后：

```text
omitted -> redacted/value
```

允许在同一个 ReplicaKey 上补齐字段，不创建第二个 Remote Entity。

Policy 放宽不自动意味着允许 Boundary 前历史，是否补旧内容仍由 History Scope 决定。

## 12. Hub 落盘安全

Hub SQLite 可能汇聚多台设备的项目、Session、Prompt、Tool、路径和资产信息。

Alpha 至少要求：

- 默认数据根仅当前 OS 用户可访问；
- DB / Backup / Diagnostics 按高敏感本地数据处理；
- 不自动上传云服务；
- 不提交 Git；
- full 数据建议使用系统磁盘加密 / 受保护账户；
- 不宣称 SQLite 自带透明加密；
- 普通资产备份不包含 Hub / Node Private Key。

## 13. 资源限制也是数据安全边界

Replication Surface 至少限制：

- HTTP Body bytes；
- maxEntitiesPerBatch；
- 单 Entity bytes；
- 每 Node 速率；
- 并发；
- Hub 磁盘低水位。

R1 基础协议不要求压缩；未来若支持压缩必须同时限制解压后大小。

## 14. 稳定资源错误

至少：

```text
BATCH_TOO_LARGE
ENTITY_TOO_LARGE
SERVER_BUSY
SERVER_STORAGE_PRESSURE
```

这些只影响 Replication，不影响 Node 本机 Canonical Pipeline。

## 15. 验收不变量

- metadata-only 不发送 Prompt / Tool 正文；
- metadata-only 默认不发送 Workspace 完整路径；
- metadata-only 仍可完成 Session / Tool / Project 聚合；
- credential 不进入 SharedKey / Wire / Log；
- Shared Identity Assertion 可以被 Hub 重算验证；
- 如果 Portable Identity 不允许出站，则不建立 Shared Group；
- redacted 路径在 Windows / macOS / Linux 规则一致；
- full 仍不会发送明确凭据；
- real null / omitted / not-captured / history-boundary / dependency-minimized / redacted 可区分；
- from-now Dependency Closure 不泄露旧非必要字段；
- full -> metadata-only 后不生成新的 full 请求；
- retained prior value 不冒充当前重新确认值；
- Hub 存储压力不导致 Node Local Capture 中断；
- 超大 Batch / Entity 在网络入口安全拒绝；
- 普通 Backup 不包含 Hub / Node Private Key。
