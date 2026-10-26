# @agent-lens/storage-sqlite

**唯一运行态：Slim v1。** `@agent-lens/storage-sqlite/slim` 是 Daemon/Worker 的受限公共入口。SQLite 只保存安装、原生会话目录、轻量资产状态与精确数字统计，不保存事件正文、Observation/Evidence、旧 Claims 或 Hub 复制日志。

- 全新安装只能创建 Slim v1，不再加载旧 v1–v38 迁移链。
- 已有 v38 仅由显式 `agent-lens migrate` **只读**审计旧库并在完整门禁后切换；不会原地升级或自动删除原库。
- 用于隔离升级验收的旧 SQL 建库脚本保存在 `fixtures/legacy-v38/`，只能被 `legacy-v38-test-fixture.ts` 测试工具加载，正式发行产物不得打包。
- 生产运行态禁止旧 Event Repository、StorageService Writer、SessionSummary/TaskFileChange 投影及复制存储。
