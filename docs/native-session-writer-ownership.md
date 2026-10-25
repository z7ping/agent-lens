# 原生会话写入归属（#617 / ADR-0024 方案 B）

> 2026-10-26 代码现状与新迁移目标。**当前仍有 Legacy 写入；最终必须一次性迁移到精简 SQLite 并移除旧路径。** Hub 暂缓。

## 2026-10-26 决策更新：一次性迁移并退役旧存储（目标约束）

用户明确修正：**不再长期并行 Legacy/Native-only 两套方案**。进行一次可验证的版本化迁移后，默认只运行原生 Source/Hook 按需读取 + 精简 SQLite；旧 Writer、旧事件表、旧索引、双归属判断和 Legacy 查询链从正式运行路径删除。下方「各来源能力门禁」「剩余 P0」记录**迁移前现实**，不是继续保留 Legacy 的目标设计。

**存储最终边界**：

- 原生 Agent 文件或用户授权的 Vault 归档：会话正文、工具输入输出、思考与可恢复的原生关系的唯一权威来源；无原生内容时显示不可用，不为了兼容重建第二份全文。
- Source-owned Hook Archive：只补充原生没有的运行时证据；保留准确的归属/缺口状态，Hook 覆盖不完整**不能触发旧 Writer 写全文**。
- 新 SQLite：仅会话目录/定位/发现检查点、必要的身份/项目/用户配置/资产索引、数值统计与版本/覆盖状态、备份索引等可审计的轻量数据。**不得**复制 `source_records`、`observations`、`evidence`、`interactions` 等逐事件数据模型，不默认复制 Legacy Replication 逐事件日志；具体表白名单须由消费者盘点和 Schema 测试锁定。

**一次性迁移流程（非每次启动的双方案兼容）**：

1. 在只读状态盘点旧 SQLite、原生文件、现有 Vault/Hook，形成身份映射、失联/缺失/无法恢复清单及预计丢弃内容；迁移前用 SQLite 一致性备份保全旧库/WAL，验证备份可读。
2. **独立新建精简 SQLite Schema**，不把 v1–v38 全量表结构复制后再靠 `DELETE` 或 `VACUUM` 冒充精简；迁入必要配置、用户标记、身份/项目映射及备份索引，来源可重建的 Catalog/统计通过 Source Reader 重建。
3. 按真实 Source/Installation/Session 身份逐项比对、读取验证；对旧库独有但原生丢失的会话，明确列出不能迁移的正文/证据，禁止伪装已迁移，也不能以完整 Legacy 表作为新库暗藏副本。
4. 停止相关 Writer 并冻结增量，迁移追平后进行 SQLite `integrity_check`/`foreign_key_check`、会话身份去重、抽样完整轮次读取及数值一致性验证；全部通过才原子切换新 DB 路径，否则保持旧版本可回退。
5. 切换后产品只启用**一种**新的 Native/Hook 数据路径，移除 Legacy Writer、Schema、SQL Consumers/元数据双计数和旧版同步分支。旧库只作为隔离回滚备份临时存在，验证完成后按迁移清理策略删除；不删除智能体的原生会话文件或独立 Vault 备份。

**验收定义**：全来源已支持原生按需读取（含失败/缺口诚实展示）；新装只创建精简 Schema；老装只运行一次迁移；新代码不再依赖 Legacy 事件表，100/1000/5000 会话启动与读取、Windows/其他平台安装升级和失败恢复有证据。Hub 后续按新架构单独设计，旧 Hub 复制模型不得作为保留事件表的理由。

**实施状态**：这是新确定的目标，尚未进行真实 SQLite 文件迁移或旧数据清理。一次性迁移器、新 Schema、消费者收敛、最终旧 Writer 删除均待代码实现及验收。

## 1. 存储归属

- 原生会话文件是消息、思考、工具输入输出和原生事件的权威来源。Reader/Normalizer/CapturePolicy 按需生成统一 Task DTO，不在新会话额外创建 SourceRecord/Observation/Evidence 正文副本。
- SQLite 保存会话级 Catalog、不可逆的写入模式声明（`native_session_write_claims`）与可重算数值汇总（`native_session_metrics`、`native_session_tool_metrics`）。不保存逐事件正文和关系。
- **会话归属先于写入固定**：已有 Legacy Claim / 旧 SQL SourceRecord 的会话继续旧管线；原生认证通过且未认领的会话才可 Native-only。原生缺失、权限错误、指纹漂移不得被当作删除或成功读取。
- `AGENT_LENS_NATIVE_ONLY_NEW_SESSIONS` 和 `AGENT_LENS_NATIVE_CATALOG_FAST_SCAN` 已不是启用条件，勿在文档/部署中继续指导使用。归属由 Source 能力、真实原生验证及 SQLite 原子 Claim 决定。

## 2. 各来源能力门禁

| 来源 | 新会话默认归属 | 说明 |
| --- | --- | --- |
| Pi | 满足真实恢复检查时 Native-only | `nativeSessionCoverageComplete: true`，JSONL append-oriented、稳定 Locator、原记录指纹与 Reader 校验 |
| Codex / Claude Code | Legacy | Hook-only 权限、工具/子代理等来源尚无全生命周期完整覆盖证书 |
| Hermes | Legacy | Hook 完整性未认证，原生 SQLite rowId 不具长期稳定恢复保证 |
| OpenCode | 满足当前态恢复认证时 Native-only | #741/#743：仅原生 `part` 行验证为 `session-current-state`，可变行改写后按原生当前态重建；不是跨历史版本完整恢复 |
| 其他/异常来源 | Legacy | 未明确声明并通过恢复验证时安全降级，不自动切换旧会话 |

**Source 已能读到 EOF，不等于全部运行时事实可恢复。** 仅已认证 Source 可把无缺口指标标为 complete；认证撤销后旧 complete 缓存读取时降级为 partial/stale。

## 3. 统一读取和统计现状

- Native Reader Worker 按需读取原生会话，通过统一 Review/Task Surface 展示；Task Center 已接入原生 Catalog 列表、分页、按需正文搜索，搜索未读完明确部分覆盖。
- Usage、Insights、Tools 消费 SQLite 可重算数值，Native-only 和 Legacy **分别汇总、不跨归属双计数**。未证明等价的 Project/Asset/会话等维度不得虚构。
- 统计一次最多读取 64×32 原生记录；长会话保持有界内存续算，读至 EOF 后才写完整会话统计。单轮最多 4 个候选、稳定 SQL 游标避免长期饥饿，正在计算最多保留 8 个内存状态。中断后可从原生源重算，无正文或 Tool Call ID 落 SQLite。
- Legacy Claim 即使没有生成 Review Observation，也不会通过 Native-only Catalog 搜索制造第二个任务入口。已认领 Legacy 不会被升级时改写归属。

## 4. Hook 与可变 SQLite 阻塞

- Codex / Claude / Hermes Hook Inbox 默认保存同份原始文件的 Source-owned archive，按需授权读取；紧急关闭 `AGENT_LENS_NATIVE_HOOK_ARCHIVE=0` 会造成恢复缺口。
- Hook 只有可验证的原生事件时间且严格唯一匹配用户轮次时才在主 Task Surface 叠加；`nativeCallId/nativeParentEventId` 冲突、跨窗口重用或来源无法证明时不猜归属（#758/#759）。同时间/内容但不同 Source 原始 ID 不能基于相似度去重（#760）。独立 Hook 证据可通过现有 Review Disclosure/分页查看（#761），`hookFactsPartial` 仍为 true。
- 三来源 Hook Inbox 保持单份已签封 Source 原始字节；失败文件冷却重试，不能再阻塞其他健康 Hook（#762）。签封页读完不等于全生命周期覆盖证明。
- Hermes SQLite 的只读事务和跨页边界指纹只验证**当前快照**，Hook 仍未认证，继续 Legacy。OpenCode 的**新会话当前态**已按有限 Source 语义单独认证 Native-only；这不保证被原生 SQLite 删除的旧版本可恢复。

## 5. #617 P0 剩余验收

1. Codex/Claude/Hermes Hook 全生命周期可恢复、严格事件身份/工具配对去重和来源完整性证书；否则继续 Legacy。
2. Hermes 原生 SQLite 的当前态/Hook 完整性证书；OpenCode 已认证当前态的进一步失效、压缩和归档验证，不可将当前态恢复误标历史版本恢复。
3. 全局 Usage/Insights/Tool/Asset/备份等旧 SQL 消费者按原生数据安全收敛、消除差异并保留错误/空值真实性。
4. 100/1000/5000 会话、1000+ 轮的冷启动/内存/磁盘、跨平台代码测试和 Windows 实机验收。当前 GitHub 远程改动未执行本地全面测试。
5. 按顶部一次性迁移决策完成精简 Schema、数据迁移与旧 Writer/旧 SQL 退役，不再把 Hook 全生命周期认证作为是否允许重复存储正文的前置条件；旧数据库仅作经核验的临时回滚副本，最终按迁移策略清理。Hub 另阶段。

详见 [#617](https://github.com/z7ping/agent-lens/issues/617) 和 product-internal ADR-0024。 
