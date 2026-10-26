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
