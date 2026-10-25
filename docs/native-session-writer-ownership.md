# 原生会话写入归属（#617）

> 实验性切换门禁，**默认保持旧 Writer**。旧 SQLite 数据不迁移、不删除，Hub 不在范围内。

## 生效条件

Daemon 进程启动前显式配置 `AGENT_LENS_NATIVE_ONLY_NEW_SESSIONS=1`，只对满足下列条件且**尚未被旧事件存储认领**的 Source 会话生效：

1. Source 提供 `readNativeSessionPage`、`rawRecovery.verify`，原生文件/数据库可授权读取。
2. 当前 SourceRecord 指纹验证为 `verified`，对应 Catalog 已保存可信文件路径、文件身份和稳定 Review ID。
3. Source 原生分页能按相同 Session ID 验证位置；SQL **没有**已有 SourceRecord 或 Observation。
4. `native_session_write_claims` 原子认领为 `native-only` 后，该会话在历史同步和运行时捕获都只做 Catalog 元数据更新，不再复制事件正文或 Evidence。

未满足条件时在首次写入前原子认领 `legacy`，保持原有 Canonical/SourceRecord/Evidence 处理。两条 Runner 使用同一持久化归属，不允许关闭开关后把 `native-only` 会话重新写为旧事件。已存在旧事件的会话不会被切走。

## 当前限制

这是为了逐步收敛消费者的**显式实验开关**，不是生产默认模式。Native-only 会话的全局用量/工具统计、文件变更汇总、附件/原始 Evidence、错误/耗时全局筛选、尾轮定位与继续对话等仍有旧事件消费者；Live 的运行时原生状态与 Review 的历史按需读取也不能混淆。启用前需确认这些差异可接受，下一阶段继续补齐。归档/恢复/安全清理尚未完成。

**不允许**将缺失、漂移、权限不足的原生源当作可删除；归属表仅是存储模式元数据，不包含事件副本或允许自动删除的授权。

## Pi/Codex file-level fast index (experimental)

When **both** `AGENT_LENS_NATIVE_ONLY_NEW_SESSIONS=1` and `AGENT_LENS_NATIVE_CATALOG_FAST_SCAN=1` are set, history sync for Sources implementing `discoverNativeSessions` first enumerates source-owned session files and reads only their headers/stat. Before skipping a whole file, the Source-native reader must return an authorized first record with a matching file identity and session ID; the Source's fingerprint verifier must confirm it; and SQLite must atomically accept a `native-only` claim (which fails for existing SQL sessions).

Only successfully claimed files bypass `ingestHistory` payload parsing. Existing sessions with legacy events and unsupported/read-failed Sources keep legacy record ingestion. The ordinary history checkpoint remains independent; no synthetic observations, tool calls, or Evidence are created merely for catalog indexing.

**Do not make these flags the production default yet.** Runtime-only hook observations, native media/attachment readers, cross-session aggregates, search and Vault restoration do not all have equivalent consumers. Daemon still starts runtime capture concurrently with the initial history pass, so an early legacy ownership claim may win; no conversion or deletion is attempted. Disabling a flag is not a safe migration strategy for previously claimed native-only sessions; the durable mode prevents event re-persistence for those exact sessions. Recovery needs to read the original native file or a verified Vault archive.

## Startup capture ordering

For one explicitly enabled native-fast Source in the startup latest stage, Daemon now starts Runtime Capture **after** the source's original-file verification and per-session SQLite ownership decision. Legacy parsing continues afterward; the capture handoff no longer races to claim an event stream as legacy before native indexing. In ordinary mode, multi-source batches and failure/abort paths, the existing startup/fallback behavior remains; no runtime hook is written without authorization. This is startup sequencing, not a replacement for transient runtime-only facts missing from native files.

## Native-only source safety gate

A `verified` record is not enough to delete the durable event copy if its upstream is mutable. Native-only **requires all**: source-controlled native storage, stable locator, append-oriented mutation model, first-row fingerprint verification, source policy `persistencePreference=reference`, and ability to reread. Hermes/OpenCode current state.db uses mutable row IDs and policy `preserve`; therefore it **must not** be assigned native-only by either the per-record or fast-file path until a native snapshot/archive recovery strategy exists. Missing capabilities stay legacy; do not equate “database query succeeded once” with long-term evidence recoverability.

## Source session completeness attestation

In addition to stable append-only/fingerprint-verified storage, Native-only now requires the Source to opt in with `nativeSessionCoverageComplete: true`, meaning its history **and** runtime facts for that session can be reread from the original store. Default false. Pi's file-watch runtime capture tails the same JSONL source and opts in. Codex and Claude Code have independent runtime-hook evidence (permission/subagent lifecycle, etc.) and **do not** opt in until those facts have a separately recoverable, nonduplicating sidecar. Hermes/OpenCode remain disabled both for mutable SQLite history and this coverage condition. No source may turn on the flag merely to improve startup speed; a real recovery test is required first. Existing experimental Native-only ownership rows remain immutable and require separate follow-up before honoring their runtime-only events.


## Hook 原始归档默认保留（2026-10-25 P0）

Codex、Claude Code、Hermes 的 Runtime Hook 在原有 emitter 确认成功后，默认将本机 Inbox 原始事件文件通过同文件系统 hard-link → unlink 转入以 **安装实例 + 原生会话** 双重隔离的 Source-owned archive。**不会再复制/重新序列化一份 Hook 事件正文**；归档文件始终走现有 Reader/Worker/Normalizer/CapturePolicy 授权按需读取。仅没有可信会话 ID 的 Hook 沿用原 Inbox 清理策略，不能冒认进入其他会话。

- 默认归档：不需要配置 `AGENT_LENS_NATIVE_HOOK_ARCHIVE=1`。
- 紧急关闭：设置 `AGENT_LENS_NATIVE_HOOK_ARCHIVE=0`；这会重新删除已消费 Inbox 原始文件，因此 Hook 恢复/合流不再能证明完整，HTTP 必须标注证据可能缺失。
- **归档开启 ≠ Native-only 已经切换**：旧 Writer 依然是生产默认，阶段性可能同时存在原 Hook 文件归档和既有 SQL 事件。只有消费者完全去旧事件依赖、来源完整性/恢复证明充分以后，才能移除旧 Writer。旧数据不迁移、不删除。
- Vault 归档/恢复及 Hook 长期保留和清理策略尚未完成，不能自动删除源文件。先为实际数据量做好监控。
