# AgentLens 1.0 Hub 数据暴露矩阵

更新日期：2026-08-27  
状态：Alpha 隐私设计，尚未实现  
相关文档：
- `docs/1.0/CAPTURE-POLICY.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-STATE-CONTRACT.md`
- `docs/1.0/HUB-PAIRING-SECURITY.md`

本文补齐 `metadata-only / redacted / full` 三档 Replication Policy 在字段级别的暴露边界。三档名称不能只停留在 Prompt / Tool 正文层面，因为路径、仓库标识、Source Locator、资产名等元数据本身也可能敏感。

## 1. 总原则

```text
Capture Policy
  -> 决定本机最多拥有什么

Replication Policy
  -> 决定本机已有信息中，什么允许离开本机
```

Replication 永远不能恢复 Capture 已经删除 / 脱敏的信息。

无论哪一档：

- 已识别 Token / API Key / Password / Authorization / Cookie 等明确凭据都禁止出站；
- Pairing Secret、Node / Hub Private Key、TLS Private Key 永不属于 Replication Data；
- 诊断内部字段不得因为 `full` 自动进入 Canonical Batch；
- Hub 中汇聚的数据应按“多台机器敏感信息集合”看待，风险高于单机数据库。

## 2. 字段敏感度分类

### A. 结构身份

用于维持 Canonical Graph / Replica Graph：

```text
node / entity identity
sourceId
productId
entity type
session / observation / evidence refs
tool canonical name
status / kind / timing / duration
```

这些通常必须复制，否则 Hub 无法完成聚合。

### B. 可移植项目 / 资产身份

例如：

```text
normalized repository identity
portable asset upstream identity
```

它们是跨机聚合的重要依据，但也可能泄露：

- 私有 Git host；
- organization / repository name；
- 私有资产包名。

因此 `metadata-only` 仍可能包含此类标识，UI 必须明确披露“仅元数据仍会同步项目 / 仓库 / 工具等身份信息”。

### C. 本机路径

例如：

```text
Workspace.path
AgentInstallation.executable
configRoot / dataRoot
AssetBinding.path
SourceLocator.path
```

路径可能包含用户名、项目名、客户名或目录结构，不能因为它不是 Prompt 就默认视为无敏感性。

### D. 业务正文

例如：

```text
Prompt
Assistant message
Reasoning fragment（来源可观察部分）
Tool input / output
SourceRecord payload
Context summary
Artifact content fragments
```

### E. 运维 / 安全状态

例如：

```text
private keys
pair secret
nonce cache
raw signature
runtime diagnostics
replication retry internals
```

不属于 Canonical Replication Data。

## 3. Alpha 字段策略矩阵

| 数据 | metadata-only | redacted | full |
| --- | --- | --- | --- |
| Node / Entity ID 与 Typed Ref | 发送 | 发送 | 发送 |
| Agent Product / Source / Kind | 发送 | 发送 | 发送 |
| 时间、状态、耗时、序列 | 发送 | 发送 | 发送 |
| Tool canonicalName / sourceType | 发送 | 发送 | 发送 |
| Shared Project Repository Identity | 发送规范化身份 | 发送规范化身份 | 发送规范化身份 |
| Portable Asset Identity | 发送规范化身份 | 发送规范化身份 | 发送规范化身份 |
| Workspace 本机完整路径 | 默认 omitted | 脱敏 / 归一化后发送 | 允许发送本机已保存普通路径 |
| executable / configRoot / dataRoot | omitted | 脱敏后按必要性发送 | 允许按必要性发送 |
| AssetBinding.path | 默认 omitted | 脱敏后发送 | 允许发送 |
| SourceLocator.kind | 发送 | 发送 | 发送 |
| SourceLocator.path | omitted | 脱敏后按必要性发送 | 允许发送 |
| SourceLocator offset / rowId | 仅在不泄露正文且有诊断价值时发送 | 发送 | 发送 |
| Prompt / Message 正文 | omitted | 脱敏后发送 | 发送本机已允许正文 |
| Tool input / output 正文 | omitted | 脱敏后发送 | 发送本机已允许正文 |
| SourceRecord.payload | omitted | 脱敏 / 限长后发送 | 发送本机已允许 payload |
| Evidence missingReason / parser details | 保留最小结构；可能含路径的文本需清洗 | 清洗后发送 | 普通文本可发送，凭据仍遮蔽 |
| Runtime Diagnostics / retry stack | 不进入 Canonical Batch | 不进入 Canonical Batch | 不进入 Canonical Batch |
| Private Key / Pair Secret / Raw Signature | 永不发送 | 永不发送 | 永不发送 |

## 4. `metadata-only` 不是匿名模式

`metadata-only` 的目标是：

> 不上传 Prompt / Tool 等业务正文和不必要本机路径，同时保留 Hub 的 Session、Agent、Tool、Usage、Project 聚合能力。

它不是：

- 匿名化所有项目名称；
- 隐藏所有仓库身份；
- 隐藏 Agent / Tool 使用模式；
- 隐藏时间与会话结构。

用户界面必须避免把它写成“不会上传任何敏感信息”。

更准确的说明应包含：

> 不同步提示词和工具正文；仍会同步会话结构、智能体 / 工具、时间以及用于项目聚合的项目 / 仓库标识等元数据。

## 5. Repository Identity 规范化前必须去凭据

Git Remote 可能包含：

```text
https://user:token@example.com/org/repo.git
https://token@example.com/org/repo.git
```

Shared Identity Normalizer 在计算 / 发送 Repository Identity 之前必须：

- 移除 userinfo；
- 移除 query / fragment；
- 不把 credential 参与 Shared Key；
- 不在 diagnostics 中打印原始带凭据 URL。

这是 Identity Contract 之前的安全门禁，不依赖用户选择 `redacted`。

## 6. 本机路径的 Alpha 处理

### metadata-only

默认不上传完整本机路径。

Hub 仍可以通过：

```text
Workspace Replica ID
Project Shared Identity
Device / Node
```

区分工作区，而不需要知道 `C:\Users\name\...`。

如 UI 需要展示工作区，可显示：

```text
设备：主力 Windows
工作区：已隐藏本机路径
```

### redacted

允许发送统一脱敏后的路径，例如：

```text
C:\Users\alice\code\agent-lens
-> ~\code\agent-lens

/home/alice/code/agent-lens
-> ~/code/agent-lens
```

具体跨平台规范由 Replication Policy Serializer 实现，不能由 Web 自己临时遮蔽。

### full

可发送 Capture Policy 已允许保存的普通本机路径；显式凭据与 URI userinfo 仍必须遮蔽。

## 7. Omitted 必须保持结构可解释

当字段因为 Replication Policy 不发送时，Wire DTO 使用：

```text
state = omitted
reason = policy
```

不能简单写：

```text
path = null
```

否则 Hub 无法区分：

- 原事实确实没有路径；
- 本机没采集；
- Node 有路径但不允许上传。

Projection / Web 也不能把 omitted 显示成“来源没有提供”。

## 8. Policy 收紧与既有 Hub 数据

从：

```text
full -> metadata-only
```

之后，新的出站 Batch 必须立即遵守新规则。

但已经在 Hub 中存在的：

```text
Prompt
Tool body
完整路径
```

不会因为 Policy 设置变化自动删除。

需要独立：

```text
Purge / delete-history / policy cleanup preview
```

UI 必须明确这一点。

## 9. Hub 数据落盘安全

Hub SQLite 可能汇聚多台机器的：

- 项目身份；
- Session；
- Prompt；
- Tool 数据；
- 路径；
- 资产信息。

因此 Alpha 至少要求：

- 默认数据根权限只允许当前用户；
- Hub DB / backup / diagnostics 视为高敏感本地数据；
- 不把数据库自动上传到云服务；
- 不把 Hub 数据目录提交 Git；
- 建议用户在承载 `full` 数据时使用系统磁盘加密 / 受保护账户；
- Alpha 不宣称提供 SQLite 内建透明加密。

如果未来提供 Hub Recovery Bundle，安全密钥与 Canonical Replica 的备份策略必须单独设计，不能把私钥塞进普通资产备份。

## 10. 资源限制也是数据安全边界

已配对但被攻陷的 Node 仍可能发送超大 Payload 造成 Hub 资源耗尽。

Replication Surface 必须：

- 在完整解析前限制 HTTP Body 最大字节数；
- 限制 `maxEntitiesPerBatch`；
- 限制单 Entity Wire Body；
- 对 Hub 磁盘低水位提供明确保护；
- 不让一个 Node 无限占用内存 / SQLite 写锁；
- rate limit / backpressure 属于 Replication Control Plane。

R1 基础协议不要求压缩。未来若增加压缩 Capability，大小限制必须同时应用于压缩前后的解压后字节数，防止压缩炸弹。

## 11. 建议新增稳定错误语义

资源保护至少需要区分：

```text
BATCH_TOO_LARGE
ENTITY_TOO_LARGE
SERVER_BUSY
SERVER_STORAGE_PRESSURE
```

其中：

- `BATCH_TOO_LARGE`：Node 可重新切批；
- `ENTITY_TOO_LARGE`：单 Entity 无法靠切批解决，需要更严格序列化 / Policy / Contract 处理；
- `SERVER_BUSY`：临时退避；
- `SERVER_STORAGE_PRESSURE`：Hub 需要释放空间 / 调整容量后再继续。

这些都不能影响 Node 本机 Canonical Pipeline。

## 12. 验收不变量

至少验证：

- `metadata-only` 不发送 Prompt / Tool 正文；
- `metadata-only` 默认不发送 Workspace 完整本机路径；
- `metadata-only` 仍能完成 Session / Tool / Project 聚合；
- Repository Identity 带 credential 时，credential 不参与 Shared Key / Wire / Log；
- `redacted` 的路径脱敏在 Windows / macOS / Linux 一致；
- `full` 仍不会发送已识别凭据；
- omitted / null / not-captured 在 Hub 可区分；
- `full -> metadata-only` 后不再生成新的 full 出站请求；
- Hub 磁盘压力不会导致 Node 本地采集中断；
- 超大 Batch / Entity 在网络入口被安全拒绝，不导致 Hub 进程 OOM；
- 普通 Backup 不包含 Hub / Node Private Key。
