# 任务中心统一会话入口

2026-10-23：修复移除独立“进行中”分组后，未进入历史索引的 Live 会话失去返回入口的问题。

- 复用现有会话行、日期分组、筛选和 Live 路由；不恢复独立实时列表。
- `/api/v1/live/runtimes` 提供导航元数据和经过服务端验证的历史关联。关联使用内部 logicalSessionId，或产品、Source、Installation 和原生 Session ID 的索引查询；歧义时不猜测，不按标题合并。
- Live 元数据在浏览器内存中跨工作区保留。刷新失败保留旧入口，局部 Adapter 失败只保留对应来源；后台不轮询。
- 历史收录后复用历史行并优先进入存活 Runtime；Runtime 结束后使用 Review。ready 显示等待输入，不标为执行中。
- 只读取已有身份和历史索引，不复制原生正文，不改写历史事实。

## 回归范围

- 新建未入历史的会话仍有入口；同名不同会话不合并。
- 历史收录后只显示一条；点击进入存活 Runtime，结束后回到 Review。
- 智能体、项目、日期和搜索筛选；保留历史接口的全文搜索结果。
- 菜单切换、可见性恢复、请求失败和新建与列表读取并发时不丢入口。

## 独立排查项

Slowlight 原生会话 `01a1668d-ac0a-76dd-bb5f-134dc4ad5a5a` 的 JSONL 存在，但排查时没有对应 SourceRecord、SourceSession 或文件 checkpoint；采集已启用。尚不能把缺失归因于 Review 投影过滤。

验证过程中开发服务在 10:58 发生重启，PID 从 9160 变为 62456，原 Runtime 未恢复；本任务没有重启该服务。历史采集缺失和重启恢复问题需独立保留证据，不能用统一列表验证替代。

通过既有 `POST /api/v1/agents/rescan?sourceId=pi` 触发补录时，接口返回 500：`Data Runtime storage call cannot cross an active transaction`。这是补录链路故障证据，尚未定位该事务的创建与未释放原因；没有清理 checkpoint、改写数据库或重启服务绕过。

## 本轮验证结果

- 会话合并、会话展示、筛选与 HTTP 索引相关 38 项回归通过；新的 HTTP 身份关联用内存 SQLite 验证。
- 真实 Pi（Slowlight 工作区）无模型请求验收：新建 → 列表可见 → 洞察菜单 → 返回任务中心 → 点击同一 Runtime，保持等待输入。未发送提示词，未验证完整任务执行。
- 浏览器最终样式检查：复用原列表元信息布局（gap 5px），未添加页面覆盖层。浏览器 DOM 与样式值已核对，未把截图作为视觉验收依据。
- `build:dist` 通过。全量 `check:web-presentation` 被已有队列翻译键缺失阻断；类型检查存在既有 Pi 启动诊断、Composer 等错误。独立 Task 样式门禁仍硬匹配旧的 13px 工具行，和现有字号 Token 不一致。未宣称全量检查通过。
