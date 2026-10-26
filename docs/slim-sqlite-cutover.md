# #617｜精简 SQLite 一次性迁移施工记录

> 2026-10-26：已新增**独立目标 Schema、只读旧库预检、保留备份的暂存迁移器**。当前运行时仍使用 v38；新库未自动启用，旧 Writer 未删除，**不代表迁移完成**。

## 1. 新库范围（暂存 Schema v1）

- `slim/001-schema.sql`：18 张表，身份（主机、产品、安装、运行配置）、项目/工作区、原生会话 Catalog/上下文、会话和工具名数值统计、Source checkpoint、资产绑定及当前状态、启动项目索引、维护任务。
- 不包含旧 `source_records`、`observations`、`evidence`、`interactions`、`logical_sessions`、`source_sessions`、`native_session_write_claims`、事件级复制与 Hub 缓存。运行时仍可构造 Canonical/Evidence DTO，但不能长期保存事件正文。
- `source_checkpoints.value_json` 可能携带运行时内容：**暂存时不复制任何旧 checkpoint**；必须审计后按 scope 制订白名单/重新发现策略。会话数值统计也不从旧库直接复制，待原生 Source 验证后重算。
- `native_session_catalog` 暂时从旧库复制的路径和身份仅为**待核验线索**，不等于文件现在存在、Hook 完整或 Reader 可恢复。

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
- `stageSlimCutover({legacyPath,backupPath,stagingPath})`：仅允许三条互不相同的路径；只读打开 v38，使用 SQLite Backup API 处理 WAL 一致性备份；检查数据库与外键；只把明确白名单数据复制到**全新**暂存库；拒绝同一原生身份跨多个 profile 的歧义；**永远返回 `readyToSwitch:false`**。
- 现有文件不会被覆盖；生成的 backup 和 stage 目前**都不会自动安装、替换或删除**。若迁移中断，保留文件供诊断，不声称成功。

## 4. 后续硬阻塞

1. 审计 checkpoint、用户标签、项目/资产、文件变更与备份状态的具体保留合同，完善迁移白名单和失联清单。
2. 全五个 Source 的原生文件真实性、归档、工具/附件/错误、Hook 缺口适配；统计从 Source 重算且不重复。
3. 消灭所有 Legacy SQL/Writer/Claims 依赖后，改为新库单一运行时；禁止用旧库兼容模式掩盖缺失功能。
4. 完成冻结写入、增量追平、原子文件切换、失败回滚及 Windows 真实升级/规模验收后，才能宣布迁移完成并执行旧库清理。
