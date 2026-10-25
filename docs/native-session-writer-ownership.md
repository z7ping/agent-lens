# 原生会话写入归属（#617 / ADR-0024 方案 B）

> 2026-10-26 代码现状。**已认证来源的新会话默认 Native-only；全来源 P0 尚未完成。** 旧 SQLite 不迁移、不删除；Hub 暂缓，Vault 另阶段。

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
5. 全来源已满足上述条件后才退役其 Legacy Writer 分支并关闭 #617；旧库清理仍需用户独立授权，Hub 与 Vault 不属于当前 P0。

详见 [#617](https://github.com/z7ping/agent-lens/issues/617) 和 product-internal ADR-0024。 
