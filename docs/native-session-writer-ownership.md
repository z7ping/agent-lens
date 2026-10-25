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
