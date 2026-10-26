# #617｜精简 SQLite 一次性迁移施工记录

> 2026-10-26：已新增**独立目标 Schema、只读旧库预检、保留备份的暂存迁移器**。当前运行时仍使用 v38；新库未自动启用，旧 Writer 未删除，**不代表迁移完成**。

## 1. 新库范围（暂存 Schema v1）

- `slim/001-schema.sql`：18 张表，身份（主机、产品、安装、运行配置）、项目/工作区、原生会话 Catalog/上下文、会话和工具名数值统计、Source checkpoint、资产绑定及当前状态、启动项目索引、维护任务。
- 不包含旧 `source_records`、`observations`、`evidence`、`interactions`、`logical_sessions`、`source_sessions`、`native_session_write_claims`、事件级复制与 Hub 缓存。运行时仍可构造 Canonical/Evidence DTO，但不能长期保存事件正文。
- `source_checkpoints.value_json` 可能携带运行时内容：**暂存时不复制任何旧 checkpoint**；必须审计后按 scope 制订白名单/重新发现策略。会话数值统计也不从旧库直接复制，待原生 Source 验证后重算。
- **旧 `native_session_catalog` 的路径不迁入新库**：旧库路径只在只读 Preflight 报告中计数，新库 Catalog 从零开始，由可信 Source Reader 重新核验原生文件并构建。旧库 `source_sessions` 关联仅迁入 `native_session_context` 的轻量身份/项目元数据，不能伪装成可读取的原生会话。

## 2. 已确认的旧表消费者

| 实现位置 | 旧依赖 | 切换责任 |
| --- | --- | --- |
| `core-services/source-runner.ts` | Legacy Writer、SourceRecord/Observation/Evidence、逐会话 claim | 写轻量 Catalog 与 Source 状态，去掉回退 |
| `storage-sqlite/repositories.ts` | 整套旧 Canonical 实体 CRUD | 只保留身份/项目/资产等新模型 |
| `storage-sqlite/session-summaries.ts` | Observations/SourceRecords/Evidence/session_summary_projection | 改用原生目录 + 可重算统计 |
| `storage-sqlite/tool-usage-{facts,observations-v2}.ts` | Observation/ToolUsageFact 及关联 | 改用工具名汇总与按需原生读取 |
| `storage-sqlite/{projection-backfill,unknown-observation-projection}.ts` | Observation/Evidence/SourceRecords | 删除旧事件补算链，原生重算 |
| `storage-sqlite/{task-file-changes,source-raw-audit}.ts` | 旧文件变更投影及 Evidence/SourceRecord | 按窗口从 Source/Git 生成 |
| `storage-sqlite/{session-runtime-profile,native-session-catalog}.ts` | source_sessions/logical_sessions、Legacy claim | 新的 native_session_context；Catalog 不再查询旧表 |
| `storage-sqlite/replication-observation-snapshot.ts`、`hub-remote-reader.ts` | 逐事件复制、Hub 缓存 | Hub 暂缓，移除单机旧模型依赖；未来新协议单独设计 |
| `storage-sqlite/{asset-inventory,launchable-projects}.ts` | 资产当前状态、项目索引 | 需要保留并适配轻量 Schema |
| `storage-sqlite/storage.ts` | 一次构造两套 repositories / diagnostics | 最后集中收敛 Composition Root |

上表是已逐文件核实的主要依赖，**不是全部消费者已完成切换的声明**；HTTP、Daemon、Live/Review、Backup 和数据运行时仍须继续逐项审计。

## 3. 可用代码及安全边界

- `initializeSlimSchema(db)`：仅允许**空白暂存库**初始化，与旧 `migrateDatabase(v1–v38)` 完全隔离。
- `inspectLegacyCutover(readonlyDb)`：只返回行数与匹配数，不暴露正文/路径，也不把 Catalog 缺失误报为原生文件已删除。
- `stageSlimCutover({legacyPath,backupPath,stagingPath})`：仅允许三条互不相同的路径；只读打开 v38，使用 SQLite Backup API 处理 WAL 一致性备份；检查数据库与外键；只把明确白名单数据复制到**全新**暂存库，**原生 Catalog 与统计从零开始**；拒绝同一原生身份跨多个 profile 的歧义；**永远返回 `readyToSwitch:false`**。
- 现有文件不会被覆盖；生成的 backup 和 stage 目前**都不会自动安装、替换或删除**。若迁移中断，保留文件供诊断，不声称成功。

## 4. 手动预检与暂存命令（仅开发/迁移验收）

命令必须提供明确的**旧库、备份和暂存库**路径，不修改旧库，不自动重启 AgentLens，不替换正式数据库文件，也不删除任何数据库。

```bash
# 只读盘点：只输出表行数/版本/Native Catalog 缺口，不读取正文
npm run storage:slim:preflight -- --legacy /path/to/agent-lens-old.sqlite

# 分别生成完整 SQLite 一致性备份和精简暂存库，文件必须事先不存在
npm run storage:slim:stage -- --legacy /path/to/agent-lens-old.sqlite --backup /path/to/old-backup.sqlite --staging /path/to/slim-staging.sqlite
```

`stage` 仅接受 v38；输出 `readyToSwitch:false` 是刻意的强制保护。生成目标后仍必须完成 Source 原生正文可恢复覆盖率、统计重算、用户配置审计、增量追平、旧 Writer 退出、Windows 实机和原子替换验证，才能执行未来单独开发的最终切换动作。

## 5. 原生 Source 索引新入口（独立于旧 Writer）

`NativeOnlySourceIndexer` + `indexNativeInstallation` 已建立单一原生索引入口：从 Slim 身份库只读解析 Installation/Host → 调用 Source 本身的 `discoverNativeSessions`（前台每片默认 32、上限 128 个）→ Source 原生 Reader 读取首条并核对物理文件身份、会话 ID、指纹 → Source-owned `rawRecovery.verify` 认证 → 仅写入 `native_session_catalog` 的路径与元信息。

- 这条新路径**没有**注入 Legacy Writer / Canonical Observations / Evidence，也不做历史事件 Replay。
- Hook 生命周期覆盖没有认证时，返回 `nativeCoverage: partial`，**仍可索引经验证的原生文件**；不把 Hook 缺口当成 SQL 复制全文的理由。
- 原始文件缺失、身份/指纹漂移、扫描额度耗尽都有明确报告，不伪装迁移已完成；精简库写入失败会抛错，不吞掉错误。
- **当前仍为新架构能力，尚未接入 Daemon 默认扫描，也不是正式切换动作。** 用户旧库中的 Legacy-only 会话和需要保留的配置仍必须逐项处理。待其他消费者切换后将此入口替换旧 `SourceHistoryRunner` 的持久化历史链路。

## 6. 旧会话身份对账（只读）

```bash
npm run storage:slim:verify -- --legacy /path/to/legacy.sqlite --staging /path/to/slim-staging.sqlite
```

只读打开两份库，输出旧 `source_sessions` 唯一身份数量、新库 `native_session_context` 关联数量、已索引原生会话、仅归档会话、无对应 Catalog、缺失 Context 和需要重算的数值统计。最多附带 32 个带 SHA-256 摘要的差异身份，不输出原始会话 ID、文件路径或内容。**即使差异为 0，`readyToSwitch` 仍是 false**：仅证明目录映射，不等于所有正文完整可读，原生 Source/Hook 证据核验和正式切换仍必须另行验收。

## 7. 原生目录重建命令（显式运行）

```bash
# 仅对指定来源/安装实例，用真实 Source 文件重建精简暂存库目录
npm run storage:slim:reindex -- --staging /path/to/slim-staging.sqlite --source pi --installation <installation-id> --limit 5000

# 完成各来源原生索引后重新查看旧/新身份差异
npm run storage:slim:verify -- --legacy /path/to/legacy.sqlite --staging /path/to/slim-staging.sqlite
```

- 必须显式指定来源、安装身份和已存在的精简库；可选 `--runtime-profile` 和 `--since`（ISO 时间）。
- 普通入口默认仅检查 **32** 条；针对一次性离线历史迁移才允许通过 `--limit` 显式扩大到 **5000** 条，并定期让出执行权。
- 每条记录均由 Source 自己授权并验证物理文件身份和指纹，只有通过时写入原生 Catalog，失败计入覆盖报告；**不会**写消息正文、创建 SQL Observation 或重新启用 Legacy Writer。
- 因 Source 发现分页不统一，达到 `--limit` 时报告 `exhausted:false`，不可据此宣称全量恢复。各来源的完整覆盖验收仍需完善。
- 本命令**只修改用户明确指定的精简暂存库**，不读取/修改旧数据库，也不进行运行时切换、删除和安装目录替换。

## 8. 全部来源离线批量重建

```bash
npm run storage:slim:reindex-all -- --staging /path/to/slim-staging.sqlite --all-installations --limit 5000
```

按精简库已迁移的安装身份、来源产品与 Profile 分组，通过真实 Source Adapter 扫描原生会话。不复制旧会话文件路径、不读旧事件正文；所有批次显式报告扫描、索引、失败、部分覆盖、额度是否截断。`discoveryComplete` 仅表示目录枚举完成，不代表原生历史正文全量完整；`readyToSwitch` 始终为 false。**此命令只对明确提供的暂存精简库写目录元数据，不操作正在运行的库。** 超 5000 的单 Scope 需要后续按来源可持续分页。

## 9. 后续硬阻塞

1. 审计 checkpoint、用户标签、项目/资产、文件变更与备份状态的具体保留合同，完善迁移白名单和失联清单。
2. 全五个 Source 的原生文件真实性、归档、工具/附件/错误、Hook 缺口适配；统计从 Source 重算且不重复。
3. 消灭所有 Legacy SQL/Writer/Claims 依赖后，改为新库单一运行时；禁止用旧库兼容模式掩盖缺失功能。
4. 完成冻结写入、增量追平、原子文件切换、失败回滚及 Windows 真实升级/规模验收后，才能宣布迁移完成并执行旧库清理。

## 全量原生正文可恢复性（独立实现）

`auditNativeSessionOriginal` 在 CoreServices 层通过真正的 Source Reader 逐页恢复原始记录，每条验证原生 ID、文件位置和 `rawRecovery.verify` 指纹；会话尾部再次对比真实文件或 SQLite/WAL revision。**只返回每个会话的验证结果和记录/页数，不保存任何原始正文。**

扫描上限与待完成尾部返回 `partial`，Source 文件丢失或身份漂移返回 `unavailable/drifted`。这项证明仅适用于**当时可读取的原生当前态**；对覆盖不完整的运行时 Hook、已覆盖或被删除的历史版本不宣称完整。切换门禁必须再汇总逐会话验收结果，而非只用 Catalog 行数。当前为独立服务，尚未自动切库。

## 全库原生当前态深度检查

```bash
npm run storage:slim:audit-originals -- --staging /path/to/slim-staging.sqlite --max-sessions 5000 --max-pages 16384
```

**只读**打开指定精简暂存库，按原生 Catalog 逐会话调用 `auditNativeSessionOriginal`，原生记录逐页/逐条核验直到 EOF；返回 verified/partial/drifted/unavailable/unsupported 计数、额度截断标记和最多 32 个不包含路径的摘要样本。即使 `allCurrentOriginalsVerified:true`，也不表示已删除的历史版本或缺失 Hook 被恢复，`readyToSwitch:false` 保持不变。

## Slim 原生资产发现

```bash
npm run storage:slim:assets -- --staging /path/to/slim-staging.sqlite --source pi --installation <id>
```

对源自 Pi/Codex/Claude/Hermes/OpenCode 的资产配置调用原生 `discoverAssets`，按 CapturePolicy 脱敏，仅写 `asset_definitions/asset_bindings/asset_current_state` 和安全的资产绑定状态快照，不落 Observation/Evidence。跨次扫描发现不再存在的资产，installed/configured 置 false，其余使用 unknown；源代码/工具正文不入库。Source/安装身份和 Runtime Profile 取自已存在的 Slim 元数据，不能从客户端任意指定文件路径。

## Worker 替换入口（代码已落地，默认 Daemon 尚未切换）

`SlimDataRuntime` 为独立精简库提供真正的 Writer/Reader Worker 入口；启动前强制验证**已存在的 Slim v1**，拒绝用 v38 迁移器打开/覆盖旧库。IPC 用 `schemaKind:'slim'` 隔离，不创建 Hub Unified Legacy Observation Reader；只允许已审计的原生目录、数值统计、项目与资产元数据方法。反射到 `executor/db`、Legacy Claim、SourceRecord、Observation/Evidence、复制日志和任意私有属性均在 Worker 方法白名单处拒绝。

此能力是默认 Daemon 数据服务的**替换基础**，不是开关切库；在 Live/Review/Usage/Insights 等所有消费者完成 Native 迁移前，绝不能直接拿它替换旧 `dataRuntimeStoragePlugin`。当前没有自动操作、删除或迁移用户的正在使用的数据库。

## 原生 Runtime Capture 替换（独立入口）

`NativeOnlyRuntimeCapture` 新运行链直接消费 Source 自身的 `startCapture`，逐个核验 `rawRecovery.verify`，可恢复事件只刷新 `NativeSessionCatalogTracker` 的 Source 文件元数据并使数值汇总失效；不执行 `processSourceRecordWithOwnership` 或 Legacy Writer/Observation/Evidence。未证明可恢复的 Hook/文件事件计为 `coverageGaps`，不会静默回退旧存储，亦不宣称“覆盖完整”。

跨次监听 Checkpoint 只允许小于 4KiB、没有正文/提示词/密钥字段的有界进度元数据。捕获队列串行处理，dispose 时先关闭 Source 再排空队列；计数器仅内存，不在 SQLite 复制执行事件。**仍需要新 Daemon 集成启动/停止与 Hook 自有归档覆盖策略**，此独立实现不等于默认运行时已切换。

## Native Source 经过 Daemon Worker 的真实桥接

`SlimDataRuntime.nativePort()` 已建立通过现有 Writer/Reader IPC 的最小存储端口：主机和安装身份由只读 Worker 查询；会话 Catalog、Runtime Profile 上下文、数值缓存失效和有界 Source Checkpoint 交由 Writer Worker。它可直接传给 `NativeSessionReader`、`indexNativeInstallation`，不需要旧 `RepositorySet` 或任何 Write Claim。

`SlimDataRuntime.reindexInstallation(...)` 和 `captureInstallation(...)` 接入了新的原生 Source 扫描/实时捕获实现，保留 Source-owned 原始文件作为唯一会话正文。**仍未把整个旧 HTTP/Live 运行入口切换为此服务**，在完成所有页面消费者之前不得直接启用默认安装切库。

## 切库前旧数据追平对账（只读）

```bash
npm run storage:slim:reconcile -- --legacy /path/to/legacy.sqlite --backup /path/to/backup-v38.sqlite --staging /path/to/staged-v1.sqlite
```

逐表只读对比旧库与一致性备份的实际行摘要及行数，不输出记录正文、原始文件路径或 SQL 内容；非空旧 WAL/rollback journal 也会报告。旧库自备份后发生任意变化，`unchangedSinceBackup=false`。即使报告未发现变化，**也不表示 Writer 已停止或文件可安全替换**，始终 `readyToSwitch=false`；只有单独完成冻结旧写入、末次快照、原生恢复核验、文件安装与失败回滚流程后才允许最终切库。

## 一体化切库预验收报告（仍不执行切换）

```bash
npm run storage:slim:gate -- --legacy /path/to/legacy.sqlite --backup /path/to/backup-v38.sqlite --staging /path/to/slim-v1.sqlite --max-sessions 5000
```

该显式只读命令串联三个互相独立的真实校验：先检查旧库与一致性备份是否变更；再核对旧会话身份与精简 Catalog/Context；再对全部原生 Catalog 进行 Source 原生内容逐页恢复，结束后重新检查旧库是否在耗时扫描期间发生变化。结果统一列出未索引身份、上下文缺失、不可恢复会话、数值统计缺口、旧 Writer 冻结/Hook 与回滚尚未认证等阻断原因。无论结果如何，`readyToSwitch:false` 是硬约束；本命令不更改旧库、备份、暂存库，不清理或替换任何用户文件。

## Facets 原生筛选项

精简库 `SqliteSlimNativeFacetReader` 直接使用安装身份、项目和原生会话 Catalog 构造智能体/项目筛选项，不读取旧 SessionSummary、Observations 或 Evidence。HTTP `/api/v1/facets` 在 SlimStore 可用时走这条读取器，并根据当前 Source 注册表与启用策略标记检测状态；日期范围暂标 `unavailable`，因为仅有会话最后活动日期不能证明完整的原生起止时间。Worker 已开放严格只读 `nativeFacets.query`，供默认 Daemon 完成切库后使用。

## Usage / Insights 消费者按精简模式实际切换

`/api/v1/usage` 和 `/api/v1/insights` 在发现 `nativeSessionList`（独立 Slim Runtime）时，不再调用旧 ToolAssetUsageProjection / UsageInsightsProjection，也不扫描 SourceRecords、Observation 或会话摘要；通过 `NativeSessionMetricsStore.overview` 按 Source/Project/时间过滤获得已验证数字。DTO 显式标 `meta.mode:'native-only'`；过时 Legacy 结构字段保持空壳**不得当作真实的 0**，可信值仅在 `meta.native`。Tools/Insights 页面据此隐藏旧汇总和明细面板，使用原生已验证工具表及数字卡，错误/未覆盖来源按部分/不可用提示；不推断时长、成功率、趋势或不存在的完整会话记录。`/usage/detail` 在 Slim 中明确报告未实现，不再偷偷调用旧事件读取。默认 Daemon 尚未正式切库，完整新详情与备份等消费者仍待收敛。

## 一键离线准备（不切换正式库）

已有的备份、暂存、原生全量目录重建和切库门禁可以按固定顺序串联：

```bash
npm run storage:slim:prepare -- --legacy /path/to/old.db --backup /path/to/new-backup.db --staging /path/to/new-slim.db --limit 5000
```

该命令仅复用现有 `stageSlimCutover`、`runNativeReindexAll`、`auditSlimCutoverGate`，不额外创建第二套数据库算法。所有路径必须显式指定、互不相同，备份和暂存文件必须不存在；旧库只读打开，遇到旧库追平差异、原生枚举/内容缺口、Hook 不完整等问题会在报告中列出阻断项。离线 Source 目录以真实迭代器 EOF 判断扫描完成，达到 `--limit` 并不等于完成。

**始终 `readyToSwitch:false`**：本命令不会停止 Daemon、替换正式数据库、删除旧 Writer 或自动回滚，也不能代替最终冻结写入与 Windows 迁移验收。失败时新生成的备份/暂存库原样保留，禁止自动清理。不要在正运行实例上把该命令当作自动升级。
